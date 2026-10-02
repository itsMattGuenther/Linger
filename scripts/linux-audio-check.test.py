#!/usr/bin/env python3
"""The packaged audio check hears each chime as the player made it, and tells
sound lost on the way to the speaker from a fault in the sound (#384, #387).

On 2026-10-01 a CI runner recorded the first knock with 81 ms missing, in two
cuts of about 40 ms (package check run 36915387652). Everything that arrived
was the knock, sample for sample, and the app's own graph had played it
whole. Freezing a container for a moment does the same, so it was the
runner stopping, not the app. Freezing it also lost stretches of DM chimes
that every measurement passed (#387), so each recorded cue is now compared
with the probe's rendering of the player's own score.

Fixtures, all 32-bit floats: `knock-lost-81ms.f32` is that knock and
`knock-clean.f32` a clean one from the same recording, and `dm-clean.f32` a
clean DM chime from a container run, as the 48 kHz virtual speaker recorded
them. `score-knock-44100.f32` and `score-dm-44100.f32` are the probe's
renderings at the WebView's 44.1 kHz, which the check converts to 48 kHz.

Run with `python3 scripts/linux-audio-check.test.py`.
"""

import array
import base64
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


KNOCK = fixture("knock-clean.f32")
LOST = fixture("knock-lost-81ms.f32")
DM = fixture("dm-clean.f32")
SCORES = {cue: audio.score(base64.b64encode((HERE / "fixtures" / f"score-{cue}-44100.f32").read_bytes()), 44100)
          for cue in ("knock", "dm")}
SCENARIOS = ("first-preview", "repeat-preview", "delayed-preview", "live", "idle-preview")
CUES = {cue: [{"label": f"{cue}-{scenario}", "cue": cue} for scenario in SCENARIOS] for cue in ("knock", "dm")}
CLEAN = {"knock": KNOCK, "dm": DM}
MS = 48


def recording(*cues):
    """Cues as the virtual speaker records them, half a second apart."""
    gap = array.array("f", [0.0] * 24000)
    samples = array.array("f", gap)
    for cue in cues:
        samples += cue
        samples += gap
    return samples


def changed(cue, change):
    """A copy of a clean recording of the cue, changed."""
    samples = array.array("f", CLEAN[cue])
    change(samples)
    return samples


def silence(start_ms, end_ms):
    def change(samples):
        samples[start_ms * MS:end_ms * MS] = array.array("f", [0.0] * ((end_ms - start_ms) * MS))
    return change


def first_of_five(cue, first):
    return recording(first, *[CLEAN[cue]] * 4)


class AsThePlayerMadeIt(unittest.TestCase):
    def assertLost(self, cue, first, milliseconds):
        samples = first_of_five(cue, first)
        with self.assertRaises(AssertionError):
            audio.judge(samples, CUES[cue], SCORES)
        damage = audio.lost(samples, CUES[cue], SCORES)
        self.assertIsNotNone(damage, "should read as lost audio")
        self.assertEqual([label for label, _ in damage], [f"{cue}-first-preview"])
        self.assertAlmostEqual(damage[0][1], milliseconds, delta=2)

    def assertNotLost(self, cue, first, failure):
        samples = first_of_five(cue, first)
        with self.assertRaisesRegex(AssertionError, failure):
            audio.judge(samples, CUES[cue], SCORES)
        self.assertIsNone(audio.lost(samples, CUES[cue], SCORES))

    def test_the_score_converted_to_48_khz_is_what_the_speaker_recorded(self):
        self.assertEqual(audio.missing(KNOCK, SCORES["knock"]), 0)
        self.assertEqual(audio.missing(DM, SCORES["dm"]), 0)

    def test_clean_sets_pass(self):
        onsets = audio.judge(recording(*[KNOCK] * 5), CUES["knock"], SCORES)
        self.assertEqual([onset["taps"] for onset in onsets], [2] * 5)
        self.assertEqual(len(audio.judge(recording(*[DM] * 5), CUES["dm"], SCORES)), 5)

    def test_the_knock_that_failed_ci_lost_81_ms(self):
        with self.assertRaisesRegex(AssertionError, "Abrupt chime onset"):
            audio.judge(first_of_five("knock", LOST), CUES["knock"], SCORES)
        self.assertLost("knock", LOST, 81)

    def test_a_dm_chime_that_lost_a_stretch_every_measurement_passes_is_lost_audio(self):
        # #387: its tail is too quiet for the cut to be a sudden jump, and
        # its length doesn't change.
        cut = changed("dm", silence(290, 340))
        samples = first_of_five("dm", cut)
        start, end = audio.segments(samples)[0]
        audio.judge_cue(samples, CUES["dm"][0], start, end)
        with self.assertRaisesRegex(AssertionError, "Not the sound the player made: dm-first-preview is missing"):
            audio.judge(samples, CUES["dm"], SCORES)
        self.assertLost("dm", cut, 50)

    def test_a_pause_is_held_up_audio(self):
        # The sound stops for 20 ms and carries on where it stopped.
        paused = DM[:300 * MS] + array.array("f", [0.0] * (20 * MS)) + DM[300 * MS:]
        self.assertLost("dm", paused, 20)

    def test_a_skip_is_lost_audio(self):
        self.assertLost("knock", KNOCK[:20 * MS] + KNOCK[60 * MS:], 40)

    def test_silence_in_place_of_sound_is_lost_audio(self):
        self.assertLost("knock", changed("knock", silence(160, 190)), 30)

    def test_silence_long_enough_to_split_a_knock_is_lost_audio(self):
        # 60–180 ms: the first tap's last 38 ms, the quiet between the taps,
        # and the second tap's first 40 ms. Only the sound counts as lost.
        split = changed("knock", silence(60, 180))
        with self.assertRaisesRegex(AssertionError, "Missing/extra chimes"):
            audio.judge(first_of_five("knock", split), CUES["knock"], SCORES)
        self.assertLost("knock", split, 78)

    def test_silence_in_place_of_a_fading_tail_is_lost_audio(self):
        # The first tap's last 18 ms, to 98.3 ms, are fainter than a
        # thousandth of full scale, but the check counts them: without them
        # the tap is too short.
        faded = changed("knock", silence(80, 120))
        with self.assertRaisesRegex(AssertionError, "Clipped tap 0"):
            audio.judge(first_of_five("knock", faded), CUES["knock"], SCORES)
        self.assertLost("knock", faded, 18)

    def test_a_lost_start_is_lost_audio_so_only_a_clean_replay_can_pass_it(self):
        # #94 lost the start of every cue: a replay loses it again, and fails.
        self.assertLost("knock", KNOCK[10 * MS:], 10)

    def test_five_knocks_that_lost_audio_are_all_lost_audio(self):
        damage = audio.lost(recording(*[LOST] * 5), CUES["knock"], SCORES)
        self.assertEqual(len(damage), 5)

    def test_a_click_is_not(self):
        def click(samples):
            samples[50 * MS] += 0.05
        self.assertNotLost("knock", changed("knock", click), "Abrupt chime onset")

    def test_a_crackle_at_the_start_is_not(self):
        def crackle(samples):
            for index in range(2 * MS):
                samples[index] += 0.02 if index % 2 else -0.02
        self.assertNotLost("knock", changed("knock", crackle), "Abrupt chime onset")

    def test_a_quieter_tap_is_not(self):
        def quieter(samples):
            for index in range(140 * MS, len(samples)):
                samples[index] *= 0.3
        self.assertNotLost("knock", changed("knock", quieter), "Clipped tap 1")

    def test_a_quieter_dm_chime_every_measurement_passes_is_not(self):
        def quieter(samples):
            for index in range(len(samples)):
                samples[index] *= 0.8
        softer = changed("dm", quieter)
        samples = first_of_five("dm", softer)
        start, end = audio.segments(samples)[0]
        audio.judge_cue(samples, CUES["dm"][0], start, end)
        self.assertNotLost("dm", softer, "Not the sound the player made: dm-first-preview differs")

    def test_a_missing_knock_is_not(self):
        samples = recording(*[KNOCK] * 4)
        with self.assertRaisesRegex(AssertionError, "Missing/extra chimes"):
            audio.judge(samples, CUES["knock"], SCORES)
        self.assertIsNone(audio.lost(samples, CUES["knock"], SCORES))

    def test_a_knock_that_arrived_whole_lost_nothing(self):
        self.assertEqual(audio.missing(KNOCK, SCORES["knock"]), 0)


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
