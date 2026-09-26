import type { VoiceDeviceList } from "../../../lib/ipc";
import { inQuietHours, type SoundCategory, type SoundPrefs } from "../../../lib/sound";
import { clockTime } from "../../../lib/time";
import { PUSH_TO_TALK_KEY, type VoicePrefs } from "../../../lib/voice";
import { CHIMES, deviceOptions, HEADINGS, quietChoices, SYSTEM_DEFAULT } from "../../core/settings";
import { IconButton, Select, SettingRow, Switch } from "../../kit";
import { Block, Fields, Note } from "./parts";

export interface SoundProps {
  /** Chimes and quiet hours, on this computer (SND-1 to SND-4). Changes take effect at once. */
  sound: SoundPrefs;
  onSound: (prefs: SoundPrefs) => void;
  /** Play a chime now, whatever the switches say (SND-4). */
  onPreview: (category: SoundCategory) => void;
  /** Devices and push-to-talk, on this computer (VOICE-8, VOICE-9). */
  voice: VoicePrefs;
  onVoice: (prefs: VoicePrefs) => void;
  /** What's plugged in: null outside the desktop app, "looking" while the core is asked. */
  devices: VoiceDeviceList | null | "looking";
  /** Now, for saying whether quiet hours are on right now. */
  now: number;
}

/** A minute of the day as this computer writes clock times. */
function minuteText(minutes: number): string {
  return clockTime(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).getTime());
}

/** Sound & Voice (SND, VOICE-8, VOICE-9). Arrival cards and door sounds are new and not built yet. */
export function SoundSection({ sound, onSound, onPreview, voice, onVoice, devices, now }: SoundProps) {
  const from = minuteText(sound.quietFrom);
  const until = minuteText(sound.quietUntil);
  const right = sound.muted
    ? "All chimes are off. Play still plays a preview."
    : sound.quietHours && inQuietHours(new Date(now), sound.quietFrom, sound.quietUntil)
      ? `Quiet hours are on until ${until}: no message or knock chimes. Voice and mute sounds still play.`
      : null;

  return (
    <>
      <Block heading={HEADINGS.chimes}>
        {/* One column with no gaps, so every rule between rows has the same space either side. */}
        <div className="nx-set-rows">
          <SettingRow
            title="Mute all notification sounds"
            description="One switch for every chime below. Voice itself is never affected."
            control={<Switch label="Mute all notification sounds" checked={sound.muted} onChange={(muted) => onSound({ ...sound, muted })} />}
          />
          <SettingRow
            title="Quiet hours"
            description={`No DM, room or knock chimes from ${from} to ${until}, on this computer's clock. Voice and mute sounds still play.`}
            control={<Switch label="Quiet hours" checked={sound.quietHours} onChange={(quietHours) => onSound({ ...sound, quietHours })} />}
          />
          {sound.quietHours ? (
            <div className="nx-set-quiet">
              <Select
                label="Quiet from"
                size="sm"
                value={String(sound.quietFrom)}
                onChange={(value) => onSound({ ...sound, quietFrom: Number(value) })}
                options={quietChoices(sound.quietFrom).map((minutes) => ({ value: String(minutes), label: minuteText(minutes) }))}
              />
              <Select
                label="Quiet until"
                size="sm"
                value={String(sound.quietUntil)}
                onChange={(value) => onSound({ ...sound, quietUntil: Number(value) })}
                options={quietChoices(sound.quietUntil).map((minutes) => ({ value: String(minutes), label: minuteText(minutes) }))}
              />
            </div>
          ) : null}
          {right ? (
            <div className="nx-set-rows-note">
              <Note tone="status">{right}</Note>
            </div>
          ) : null}
          <div className="nx-set-chimes">
            {CHIMES.map((chime) => (
              <SettingRow
                key={chime.category}
                title={chime.label}
                description={chime.hint}
                control={
                  <>
                    <IconButton icon="play" label={`Play the ${chime.label.toLowerCase()} chime`} size="sm" onClick={() => onPreview(chime.category)} />
                    <Switch
                      label={chime.label}
                      checked={sound.categories[chime.category]}
                      onChange={(on) => onSound({ ...sound, categories: { ...sound.categories, [chime.category]: on } })}
                    />
                  </>
                }
              />
            ))}
          </div>
        </div>
        <Note>Play always sounds a preview. Live chimes follow the switches and quiet hours.</Note>
      </Block>
      <Block heading={HEADINGS.voice} lead="Talking happens in a room: Join, in a room's voice strip, turns your microphone on there.">
        {devices === null || devices === "looking" ? (
          <Note tone="status">{devices === null ? "Microphones and speakers are picked in the desktop app." : "Looking for microphones and speakers…"}</Note>
        ) : (
          <>
            <Fields>
              <Select
                label="Microphone"
                value={voice.devices.input ?? SYSTEM_DEFAULT}
                onChange={(input) => onVoice({ ...voice, devices: { ...voice.devices, input: input === SYSTEM_DEFAULT ? null : input } })}
                options={deviceOptions(devices.inputs, devices.default_input, voice.devices.input)}
              />
              <Select
                label="Speakers"
                value={voice.devices.output ?? SYSTEM_DEFAULT}
                onChange={(output) => onVoice({ ...voice, devices: { ...voice.devices, output: output === SYSTEM_DEFAULT ? null : output } })}
                options={deviceOptions(devices.outputs, devices.default_output, voice.devices.output)}
              />
            </Fields>
            <Note>A change applies the next time you join voice. If a device you picked isn't plugged in, Linger uses the system default rather than stopping you talking.</Note>
          </>
        )}
        <SettingRow
          title="Push to talk"
          description="Starts every call muted and opens the microphone only while you hold the key. Off by default: a room you leave running shouldn't need a key held down."
          control={
            <>
              <kbd className="nx-set-key" title="The push-to-talk key">
                {PUSH_TO_TALK_KEY === "Control" ? "Ctrl" : PUSH_TO_TALK_KEY}
              </kbd>
              <Switch label="Push to talk" checked={voice.pushToTalk} onChange={(pushToTalk) => onVoice({ ...voice, pushToTalk })} />
            </>
          }
        />
        <SettingRow
          title="Voice through the server"
          description="Your voice goes to the server once, and it passes it on to everyone in the room. Turn it off to use the old way, straight to each person: if anybody in a room does, the whole room goes the old way. Only matters on a server that passes voice on, and takes effect the next time you join."
          control={<Switch label="Voice through the server" checked={voice.forwarding} onChange={(forwarding) => onVoice({ ...voice, forwarding })} />}
        />
      </Block>
    </>
  );
}
