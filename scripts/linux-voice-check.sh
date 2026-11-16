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
# two and no monitor, and a tone played comes back within half a second, not
# the two seconds a sound server's own buffering takes.
#
# No real microphone or speaker is used, and nothing is heard. Needs
# `pulseaudio` (the daemon itself: a desktop on PipeWire doesn't have it)
# and what the desktop shell builds with (docs/development.md). Without
# pulseaudio it says so and passes: CI's tauri-shell job has it.
#
#   scripts/linux-voice-check.sh
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
if ! command -v pulseaudio >/dev/null; then
  echo "linux-voice-check: no pulseaudio daemon here, so nothing ran; CI runs it"
  exit 0
fi

work=$(mktemp -d)
server=""
finish() {
  if [ -n "$server" ] && kill -0 "$server" 2>/dev/null; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap finish EXIT

mkdir -p "$work/run" "$work/home"
socket="$work/pulse.sock"
cat > "$work/pulse.pa" <<PA
load-module module-null-sink sink_name=linger_check_speakers rate=48000 channels=2 sink_properties=device.description=Linger-check-speakers
load-module module-remap-source source_name=linger_check_microphone master=linger_check_speakers.monitor source_properties=device.description=Linger-check-microphone
set-default-sink linger_check_speakers
set-default-source linger_check_microphone
load-module module-native-protocol-unix socket=$socket auth-anonymous=1
PA

# Its own runtime and home, so it neither finds nor disturbs a sound server
# of the person's.
HOME="$work/home" XDG_RUNTIME_DIR="$work/run" XDG_CONFIG_HOME="$work/home/.config" \
  pulseaudio -n --daemonize=no --use-pid-file=no --exit-idle-time=-1 --disallow-exit \
  --file="$work/pulse.pa" > "$work/pulse.log" 2>&1 &
server=$!

for _ in $(seq 1 100); do
  [ -S "$socket" ] && break
  if ! kill -0 "$server" 2>/dev/null; then
    cat "$work/pulse.log" >&2
    echo "linux-voice-check: the private PulseAudio didn't start" >&2
    exit 1
  fi
  sleep 0.1
done
[ -S "$socket" ] || { cat "$work/pulse.log" >&2; echo "linux-voice-check: the private PulseAudio made no socket" >&2; exit 1; }

mkdir -p "$root/client/dist"
# LINGER_AUDIO unset: somebody who keeps to ALSA would otherwise skip what
# this checks.
if ! env -u LINGER_AUDIO PULSE_SERVER="unix:$socket" \
  cargo test --manifest-path "$root/client/src-tauri/Cargo.toml" --lib -- \
  --ignored --exact voice::device::tests::through_a_sound_server_a_sound_comes_back_at_once --nocapture; then
  echo "--- the private PulseAudio's log" >&2
  cat "$work/pulse.log" >&2
  exit 1
fi
