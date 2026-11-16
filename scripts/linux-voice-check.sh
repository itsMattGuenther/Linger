#!/usr/bin/env bash
# The desktop app's own voice path through a sound server, on real streams
# (#905): the microphone and speakers Linger lists and opens when a desktop
# runs PulseAudio, or PipeWire answering as it.
#
# Starts a private PulseAudio with one speaker that plays to nowhere and one
# microphone that hears it, points Linger's audio at it (PULSE_SERVER), and
# runs the one test that needs it
# (client/src-tauri/src/voice/device.rs,
# `through_a_sound_server_a_sound_comes_back_at_once`): the lists hold those
# two and no monitor, a tone played comes back within half a second, not the
# two seconds a sound server's own buffering takes, asking again and again
# opens no more connections, and after the sound server is restarted under
# the open streams a tone comes back by itself.
#
# No real microphone or speaker is used, and nothing is heard. Needs
# `pulseaudio` (the daemon itself: a desktop on PipeWire doesn't have it)
# and what the desktop shell builds with (docs/development.md). Without
# pulseaudio it says so and passes: CI's tauri-shell job has it.
#
#   scripts/linux-voice-check.sh
#   scripts/linux-voice-check.sh <test binary>   the shell's tests, built
#       already (`cargo test --lib --no-run` names the file): for a container
#       that has pulseaudio and no Rust, on a desktop whose sound is PipeWire
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
if ! command -v pulseaudio >/dev/null; then
  echo "linux-voice-check: no pulseaudio daemon here, so nothing ran; CI runs it"
  exit 0
fi

work=$(mktemp -d)
finish() {
  if [ -f "$work/pulse.pid" ]; then
    kill "$(cat "$work/pulse.pid")" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap finish EXIT

mkdir -p "$work/run" "$work/home/.config/pulse"
socket="$work/pulse.sock"
# The key a program shows the sound server. PulseAudio keeps one in the
# person's home; this home is new, and a program showing none is turned
# away ("protocol error, kicking client") and falls back to ALSA.
cookie="$work/home/.config/pulse/cookie"
head -c 256 /dev/urandom > "$cookie"
cat > "$work/pulse.pa" <<PA
load-module module-null-sink sink_name=linger_check_speakers rate=48000 channels=2 sink_properties=device.description=Linger-check-speakers
load-module module-remap-source source_name=linger_check_microphone master=linger_check_speakers.monitor source_properties=device.description=Linger-check-microphone
set-default-sink linger_check_speakers
set-default-source linger_check_microphone
load-module module-native-protocol-unix socket=$socket auth-anonymous=1
PA

# Its own runtime and home, so it neither finds nor disturbs a sound server
# of the person's. Its process id goes in a file, because the test starts it
# a second time itself (below), from a process of its own.
cat > "$work/start.sh" <<START
rm -f "$socket"
HOME="$work/home" XDG_RUNTIME_DIR="$work/run" XDG_CONFIG_HOME="$work/home/.config" \\
  nohup pulseaudio -n --daemonize=no --use-pid-file=no --exit-idle-time=-1 --disallow-exit \\
  --file="$work/pulse.pa" >> "$work/pulse.log" 2>&1 &
echo \$! > "$work/pulse.pid"
for _ in \$(seq 1 100); do
  [ -S "$socket" ] && exit 0
  kill -0 "\$(cat "$work/pulse.pid")" 2>/dev/null || break
  sleep 0.1
done
echo "linux-voice-check: the private PulseAudio didn't start" >&2
exit 1
START
# The sound server stopped and started again under the test's open streams,
# as an update or a restart of PipeWire does under a call.
cat > "$work/restart.sh" <<RESTART
kill "\$(cat "$work/pulse.pid")" 2>/dev/null
for _ in \$(seq 1 100); do
  kill -0 "\$(cat "$work/pulse.pid")" 2>/dev/null || break
  sleep 0.1
done
sleep 1
exec sh "$work/start.sh"
RESTART

sh "$work/start.sh" || { cat "$work/pulse.log" >&2; exit 1; }

if [ $# -gt 0 ]; then
  tests=("$1")
else
  mkdir -p "$root/client/dist"
  tests=(cargo test --manifest-path "$root/client/src-tauri/Cargo.toml" --lib --)
fi
# LINGER_AUDIO unset: somebody who keeps to ALSA would otherwise skip what
# this checks.
if ! env -u LINGER_AUDIO PULSE_SERVER="unix:$socket" PULSE_COOKIE="$cookie" \
  LINGER_TEST_SOUND_SERVER_RESTART="$work/restart.sh" \
  "${tests[@]}" \
  --ignored --exact voice::device::tests::through_a_sound_server_a_sound_comes_back_at_once --nocapture; then
  echo "--- the private PulseAudio's log" >&2
  cat "$work/pulse.log" >&2
  exit 1
fi
