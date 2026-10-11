/**
 * Leaving a group DM (SPEC §4.13, #565): the group's ⋯ button, a menu with
 * Leave in it, and one calm question that says what happens before it does.
 * The same on the group's row in the list and in its conversation's header,
 * and on the phone, where the menu and the question rise from the bottom.
 *
 * Nothing here changes the list. Once the server has taken you out it tells
 * every window and device you have (`dm.remove`), and the row, a tab and a
 * conversation's own window each go because the store no longer has it.
 */
import { useEffect, useRef, useState } from "react";
import { onPhone } from "../core/phone";
import { Button, IconButton, Menu, type MenuAnchor } from "../kit";
import { FloatingForm } from "./chat/ReportBlock";
import "./chat/ReportBlock.css";
import "./LeaveGroup.css";

export interface LeaveGroupProps {
  /** The group, named as the list names it: "Callie and Dave". */
  label: string;
  /** You're the only one still in it, so leaving deletes it. */
  last: boolean;
  /** Leave it. Resolves to null once it's done, or what went wrong in words. */
  onLeave: () => Promise<string | null>;
  /** The ⋯ button's size: small on a row, as its other buttons are. */
  size?: "sm" | "md";
}

export function LeaveGroup({ label, last, onLeave, size = "sm" }: LeaveGroupProps) {
  const trigger = useRef<HTMLSpanElement | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [asking, setAsking] = useState<MenuAnchor | null>(null);
  const backToTrigger = () => trigger.current?.querySelector("button")?.focus();
  const more = `More for ${label}`;

  return (
    <span ref={trigger} className="nx-leave-group">
      <IconButton
        icon="more"
        label={more}
        size={size}
        expanded={menu !== null || asking !== null}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setMenu((open) => (open ? null : { top: box.top, left: box.left, right: box.right, bottom: box.bottom }));
        }}
      />
      {menu ? (
        <Menu
          label={more}
          items={[
            {
              id: "leave",
              label: "Leave this group…",
              icon: "leave",
              tone: "danger",
              onSelect: () => {
                setAsking(menu);
                setMenu(null);
              },
            },
          ]}
          anchor={menu}
          onClose={(reason) => {
            setMenu(null);
            if (reason === "escape" || reason === "tab") backToTrigger();
          }}
          sheet={onPhone() ? { head: label } : undefined}
        />
      ) : null}
      {asking ? (
        <FloatingForm
          anchor={asking}
          label={`Leave ${label}`}
          onClose={() => {
            setAsking(null);
            backToTrigger();
          }}
        >
          <LeaveForm
            label={label}
            last={last}
            onLeave={onLeave}
            onLeft={() => setAsking(null)}
            onDone={() => {
              setAsking(null);
              backToTrigger();
            }}
          />
        </FloatingForm>
      ) : null}
    </span>
  );
}

export interface LeaveFormProps {
  label: string;
  last: boolean;
  onLeave: () => Promise<string | null>;
  /** It's done: the group is on its way out of every window. */
  onLeft: () => void;
  /** Back to what opened it, having stayed. */
  onDone: () => void;
}

/**
 * The question, said plainly before it's done (#565): it goes from your list
 * everywhere, nobody can put you back, and what happens to what's in it. It
 * opens on Stay, so a stray Enter doesn't take the step.
 */
export function LeaveForm({ label, last, onLeave, onLeft, onDone }: LeaveFormProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    box.current?.querySelector("button")?.focus();
  }, []);
  const leave = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const said = await onLeave();
    setBusy(false);
    // Done, it closes; the server's word takes the group out of the list,
    // and its tab or window with it, a moment later.
    if (said === null) onLeft();
    else setProblem(said);
  };
  return (
    <div ref={box} className="nx-report" role="group" aria-label={`Leave ${label}`}>
      <h3 className="nx-report-title">Leave this group?</h3>
      <ul className="nx-report-list">
        <li>It goes from your list, on every device you use.</li>
        <li>Nobody can add you back, but anyone in it can start a new one with you.</li>
        {last ? (
          <li>You're the last one in it, so everything said and shared in it is deleted for good.</li>
        ) : (
          <li>The others see that you left, and keep what you said.</li>
        )}
      </ul>
      {problem ? (
        <p className="nx-report-problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="nx-report-buttons">
        <Button variant="secondary" size="md" onClick={onDone}>
          Stay
        </Button>
        <Button variant="danger" size="md" icon="leave" busy={busy} onClick={() => void leave()}>
          Leave
        </Button>
      </div>
    </div>
  );
}
