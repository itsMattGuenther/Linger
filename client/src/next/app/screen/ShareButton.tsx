import { useRef, useState } from "react";
import type { ScreenFps } from "../../../lib/screen/presets";
import { type ControlSize, IconButton, Menu, type MenuAnchor } from "../../kit";

/** Share, in the voice bar and the room's voice line (SPEC §4.20, #360). */
export interface ShareControl {
  /** You're sharing now, from this window or another of yours. */
  sharing: boolean;
  /** Why Share can't be pressed now: three already share here. Said in its place. */
  unavailable?: string;
  /** Call it straight from the press: the system's picker opens only from one. */
  onShare: (fps: ScreenFps) => void;
  onStop: () => void;
}

/**
 * Share your screen, as a symbol beside Mute, Deafen and Leave. Pressing it
 * asks which speed, 30 or 60 frames a second, and the system's own picker
 * asks what to share. While you share it's lit, and pressing it stops.
 */
export function ShareButton({ control, size }: { control: ShareControl; size: ControlSize }) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  if (control.sharing) {
    return <IconButton icon="share" label="Stop sharing your screen" size={size} pressed onClick={control.onStop} />;
  }
  const close = (refocus: boolean) => {
    setAnchor(null);
    if (refocus) opener.current?.focus();
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
          onClose={(reason) => close(reason === "escape" || reason === "tab")}
          items={[
            { id: "30", label: "Sharp text, 30 fps", icon: "share", onSelect: () => control.onShare(30) },
            { id: "60", label: "Smooth motion, 60 fps", icon: "share", onSelect: () => control.onShare(60) },
          ]}
        />
      ) : null}
    </>
  );
}
