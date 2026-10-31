import { useState } from "react";
import type { DroppedFile } from "../../../lib/shellDrops";
import { type ShareSection, type ShareTarget, shareHead, sharedProblem } from "../../core/shareInbox";
import { type IconName, Menu, type MenuItem } from "../../kit";
import { useBackButton } from "../useBackButton";
import "./ShareSheet.css";

/** Each kind of conversation's mark, as the list draws it. */
const MARK: Record<ShareTarget["kind"], IconName> = { room: "hash", group: "people", dm: "message" };

/** A sheet has no anchor of its own: it rises from the bottom. */
const NOWHERE = { top: 0, left: 0, right: 0, bottom: 0 };

/**
 * Which conversation a share is for (#785, SPEC §4.15): risen from the
 * bottom as the phone's other sheets are, with every room, group DM and DM,
 * and under several servers each says whose it is. Picking one hands the
 * files over (`onPick`), which answers with a problem in words when none
 * could be read; then the sheet stays and says so. Back, a tap on the dimmed
 * page or Escape turns the share down.
 */
export function ShareSheet({
  waiting,
  sections,
  onPick,
  onClose,
}: {
  waiting: readonly DroppedFile[];
  sections: readonly ShareSection[];
  onPick: (target: ShareTarget) => Promise<string | null>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useBackButton(true, onClose);
  const several = sections.length > 1;
  // A file that can't be sent is said up front, before anybody picks.
  const known = waiting.map(sharedProblem).find((why) => why !== null) ?? null;
  const said = problem ?? known;
  const pick = (target: ShareTarget) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    void onPick(target).then((why) => {
      setBusy(false);
      setProblem(why);
    });
  };
  const items: MenuItem[] = sections.flatMap((section) =>
    section.targets.map(
      (target): MenuItem => ({
        id: `${target.server} ${target.roomId}`,
        label: target.label,
        icon: MARK[target.kind],
        detail: several ? section.name : undefined,
        unavailable: busy ? "Getting the files ready…" : undefined,
        onSelect: () => pick(target),
      }),
    ),
  );
  if (items.length === 0) {
    items.push({ id: "nowhere", label: "Nowhere to share to", unavailable: "Join a room or start a DM first.", onSelect: () => undefined });
  }
  return (
    <Menu
      label="Share to a conversation"
      items={items}
      anchor={NOWHERE}
      onClose={onClose}
      sheet={{
        head: shareHead(waiting),
        top: said === null ? undefined : (
          <p className="nx-share-problem" role="status">
            {said}
          </p>
        ),
      }}
    />
  );
}
