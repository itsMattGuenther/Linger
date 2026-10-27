import { useRef, useState } from "react";
import type { ScreenFps } from "../../../lib/screen/presets";
import { setShareSoundOn, useShareSoundOn } from "../../../lib/screen/sound";
import { SHARE_CHOICES, SHARE_SOUND } from "../../core/screens";
import { type ControlSize, IconButton, Menu, type MenuAnchor } from "../../kit";

/** Share, in the voice bar and the room's voice line (SPEC §4.20, #360). */
export interface ShareControl {
  /** You're sharing now, from this window or another of yours. */
  sharing: boolean;
  /** Why Share can't be pressed now: three already share here. Said in its place. */
  unavailable?: string;
  /**
   * "Share the computer's sound" is offered (#736): this app can capture it
   * (the Windows app, on Windows 10 2004 and later) and the server passes it
   * on. Its on or off is kept on this computer (`lib/screen/sound.ts`), and
   * `onShare` reads it.
   */
  sound?: boolean;
  /** Call it straight from the press: the system's picker opens only from one. */
  onShare: (fps: ScreenFps) => void;
  onStop: () => void;
}

/**
 * Share your screen, as a symbol beside Mute, Deafen and Leave. Pressing it
 * asks which speed, 30 or 60 frames a second, and the system's own picker
 * asks what to share. Where the computer's sound can go with it, a tick
 * under the two says whether it does, off until it's turned on (#736);
 * ticking it leaves the menu open for the choice. While you share it's lit,
 * and pressing it stops.
 */
export function ShareButton({ control, size }: { control: ShareControl; size: ControlSize }) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const soundOn = useShareSoundOn();
  const opener = useRef<HTMLButtonElement | null>(null);
  if (control.sharing) {
    return <IconButton icon="share" label="Stop sharing your screen" size={size} pressed onClick={control.onStop} />;
  }
  const close = (refocus: boolean) => {
    setAnchor(null);
    if (refocus) opener.current?.focus();
  };
  const pick = (fps: ScreenFps) => {
    close(false);
    control.onShare(fps);
  };
  return (
    <>
      <IconButton
        icon="share"
        label="Share your screen"
        size={size}
        unavailable={control.unavailable}
        expanded={anchor !== null}
        onClick={(event) => {
          opener.current = event.currentTarget;
          const box = event.currentTarget.getBoundingClientRect();
          setAnchor((open) => (open ? null : { top: box.top, left: box.left, right: box.right, bottom: box.bottom }));
        }}
      />
      {anchor ? (
        <Menu
          label="Share your screen"
          anchor={anchor}
          wide={control.sound === true}
          onClose={(reason) => close(reason === "escape" || reason === "tab")}
          // Closed as a speed is picked: the menu doesn't close itself, and
          // one left open came back when the share ended.
          items={[
            { id: "60", ...SHARE_CHOICES[60], icon: "share", onSelect: () => pick(60) },
            { id: "30", ...SHARE_CHOICES[30], icon: "share", onSelect: () => pick(30) },
            ...(control.sound ? [{ id: "sound", ...SHARE_SOUND, icon: "speaker" as const, checked: soundOn, onSelect: () => setShareSoundOn(!soundOn) }] : []),
          ]}
        />
      ) : null}
    </>
  );
}
