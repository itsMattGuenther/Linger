import { Menu, type MenuAnchor, type MenuCloseReason, type MenuItem } from "../../kit";
import { useBackButton } from "../useBackButton";

/** Where a held thing is on the screen, for a sheet's anchor. */
export function boxOf(element: HTMLElement): MenuAnchor {
  const box = element.getBoundingClientRect();
  return { top: box.top, left: box.left, right: box.right, bottom: box.bottom };
}

/**
 * What a held row or server's header raises on the phone (SPEC §4.15, #704):
 * the actions its buttons have on a computer, risen from the bottom as a
 * held message's are (#686), under a `head` line saying whose they are.
 * Back, or a swipe in from an iPhone's edge, closes it, as a tap on the
 * dimmed page does.
 */
export function HeldSheet({
  label,
  head,
  items,
  anchor,
  onClose,
}: {
  label: string;
  head: string;
  items: MenuItem[];
  anchor: MenuAnchor;
  onClose: (reason: MenuCloseReason) => void;
}) {
  useBackButton(true, () => onClose("outside"));
  return <Menu label={label} items={items} anchor={anchor} onClose={onClose} sheet={{ head }} />;
}
