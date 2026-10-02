#!/usr/bin/env python3
"""The packaged audio check tells sound lost on the way to the speaker from a
fault in the sound itself (#384).

On 2026-10-01 a CI runner recorded the first knock with 81 ms missing, in two
cuts of about 40 ms (package check run 36915387652). Everything that arrived
was the knock, sample for sample, and the app's own graph had played it
whole. Freezing a container for a moment does the same, so it was the
runner stopping, not the app. The fixtures are that knock and the loudest
clean one from the same recording, as the virtual speaker recorded them:
48 kHz, mono, 32-bit floats.

Run with `python3 scripts/linux-audio-check.test.py`.
"""

import array
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("linux_audio_check", HERE / "linux-audio-check.py")
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)


def fixture(name):
    samples = array.array("f")
    samples.frombytes((HERE / "fixtures" / name).read_bytes())
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


CLEAN = fixture("knock-clean.f32")
LOST = fixture("knock-lost-81ms.f32")
KNOCKS = [{"label": f"knock-{scenario}", "cue": "knock"}
          for scenario in ("first-preview", "repeat-preview", "delayed-preview", "live", "idle-preview")]
MS = 48


def recording(*cues):
    """Cues as the virtual speaker records them, half a second apart."""
    gap = array.array("f", [0.0] * 24000)
    samples = array.array("f", gap)
    for cue in cues:
        samples += cue
        samples += gap
    return samples


def changed(change):
    """A copy of the clean knock, changed."""
    samples = array.array("f", CLEAN)
    change(samples)
    return samples


def silence(start_ms, end_ms):
    def change(samples):
        samples[start_ms * MS:end_ms * MS] = array.array("f", [0.0] * ((end_ms - start_ms) * MS))
    return change


class LostAudio(unittest.TestCase):
    def assertLost(self, first, milliseconds):
        samples = recording(first, CLEAN, CLEAN, CLEAN, CLEAN)
        with self.assertRaises(AssertionError):
            audio.judge(samples, KNOCKS)
        damage = audio.lost(samples, KNOCKS)
        self.assertIsNotNone(damage, "should read as lost audio")
        self.assertEqual([label for label, _ in damage], ["knock-first-preview"])
        self.assertAlmostEqual(damage[0][1], milliseconds, delta=2)

    def assertNotLost(self, first, failure):
        samples = recording(first, CLEAN, CLEAN, CLEAN, CLEAN)
        with self.assertRaisesRegex(AssertionError, failure):
            audio.judge(samples, KNOCKS)
        self.assertIsNone(audio.lost(samples, KNOCKS))

    def test_a_clean_set_passes(self):
        onsets = audio.judge(recording(*[CLEAN] * 5), KNOCKS)
        self.assertEqual([onset["taps"] for onset in onsets], [2] * 5)

    def test_the_knock_that_failed_ci_lost_81_ms(self):
        samples = recording(LOST, CLEAN, CLEAN, CLEAN, CLEAN)
        with self.assertRaisesRegex(AssertionError, "Abrupt chime onset"):
            audio.judge(samples, KNOCKS)
        self.assertLost(LOST, 81)

    def test_a_skip_is_lost_audio(self):
        self.assertLost(CLEAN[:20 * MS] + CLEAN[60 * MS:], 40)

    def test_silence_in_place_of_sound_is_lost_audio(self):
        self.assertLost(changed(silence(160, 190)), 30)

    def test_silence_long_enough_to_split_a_knock_is_lost_audio(self):
        # 60–180 ms: the first tap's last 38 ms, the quiet between the taps,
        # and the second tap's first 40 ms. Only the sound counts as lost.
        split = changed(silence(60, 180))
        with self.assertRaisesRegex(AssertionError, "Missing/extra chimes"):
            audio.judge(recording(split, CLEAN, CLEAN, CLEAN, CLEAN), KNOCKS)
        self.assertLost(split, 78)

    def test_silence_in_place_of_a_fading_tail_is_lost_audio(self):
        # The first tap's last 18 ms, to 98.3 ms, are fainter than a
        # thousandth of full scale, but the check counts them: without them
        # the tap is too short.
        faded = changed(silence(80, 120))
        with self.assertRaisesRegex(AssertionError, "Clipped tap 0"):
            audio.judge(recording(faded, CLEAN, CLEAN, CLEAN, CLEAN), KNOCKS)
        self.assertLost(faded, 18)

    def test_a_lost_start_is_lost_audio_so_only_a_clean_replay_can_pass_it(self):
        # #94 lost the start of every cue: a replay loses it again, and fails.
        self.assertLost(CLEAN[10 * MS:], 10)

    def test_a_click_is_not(self):
        def click(samples):
            samples[50 * MS] += 0.05
        self.assertNotLost(changed(click), "Abrupt chime onset")

    def test_a_crackle_at_the_start_is_not(self):
        def crackle(samples):
            for index in range(2 * MS):
                samples[index] += 0.02 if index % 2 else -0.02
        self.assertNotLost(changed(crackle), "Abrupt chime onset")

    def test_a_quieter_tap_is_not(self):
        def quieter(samples):
            for index in range(140 * MS, len(samples)):
                samples[index] *= 0.3
        self.assertNotLost(changed(quieter), "Clipped tap 1")

    def test_a_missing_knock_is_not(self):
        samples = recording(CLEAN, CLEAN, CLEAN, CLEAN)
        with self.assertRaisesRegex(AssertionError, "Missing/extra chimes"):
            audio.judge(samples, KNOCKS)
        self.assertIsNone(audio.lost(samples, KNOCKS))

    def test_lost_audio_with_no_clean_knock_to_compare_is_not(self):
        self.assertIsNone(audio.lost(recording(*[LOST] * 5), KNOCKS))

    def test_a_knock_that_arrived_whole_lost_nothing(self):
        self.assertIsNone(audio.missing(CLEAN, CLEAN))


class Replay(unittest.TestCase):
    """Only lost audio plays the set again, once, and the replay must pass."""

    def setUp(self):
        area = tempfile.TemporaryDirectory()
        self.addCleanup(area.cleanup)
        self.output = Path(area.name) / "audio-deb"
        self.calls = 0

    def run_with(self, *outcomes, environment=None):
        def check(program, output, appimage, video):
            output.mkdir()
            outcome = outcomes[self.calls]
            self.calls += 1
            if outcome:
                raise outcome
        printed = io.StringIO()
        with mock.patch.object(audio, "check", check), mock.patch.dict(os.environ, environment or {}, clear=True), \
                contextlib.redirect_stdout(printed):
            audio.run(Path("/usr/bin/linger-client"), self.output, False, False)
        return printed.getvalue()

    def test_lost_audio_plays_the_set_again_and_keeps_the_first_recording(self):
        printed = self.run_with(audio.LostAudio("knock-first-preview lost 81 ms"), None)
        self.assertEqual(self.calls, 2)
        self.assertTrue(self.output.is_dir())
        self.assertTrue(self.output.with_name("audio-deb-lost").is_dir())
        self.assertIn("LOST linger-client: knock-first-preview lost 81 ms", printed)
        self.assertFalse(printed.startswith("::warning"))

    def test_on_ci_the_replay_is_a_warning_on_the_run(self):
        printed = self.run_with(audio.LostAudio("lost"), None, environment={"GITHUB_ACTIONS": "true"})
        self.assertTrue(printed.startswith("::warning title=Audio lost on the way to the speaker::LOST"))

    def test_lost_audio_twice_fails(self):
        with self.assertRaisesRegex(AssertionError, "lost again on the second play"):
            self.run_with(audio.LostAudio("lost"), audio.LostAudio("lost"))
        self.assertEqual(self.calls, 2)

    def test_any_other_failure_fails_without_a_replay(self):
        with self.assertRaisesRegex(AssertionError, "Abrupt chime onset"):
            self.run_with(AssertionError("Abrupt chime onset"))
        self.assertEqual(self.calls, 1)
        self.assertFalse(self.output.with_name("audio-deb-lost").exists())


if __name__ == "__main__":
    unittest.main()
