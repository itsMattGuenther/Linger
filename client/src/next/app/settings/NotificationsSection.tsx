import { type KeyboardEvent, useId, useRef, useState } from "react";
import type { NotifyRule } from "../../../generated/NotifyRule";
import type { Room } from "../../../generated/Room";
import type { User } from "../../../generated/User";
import { HEADINGS, ruleSummary } from "../../core/settings";
import { Button, Icon, Name, SettingRow, Switch } from "../../kit";
import { Block, Note, SaveLine, useSave } from "./parts";

export interface NotificationsProps {
  /** Everyone else on the server, by name. */
  people: readonly User[];
  /** The server's rooms, not archived. */
  rooms: readonly Room[];
  rules: readonly NotifyRule[];
  /** Turn one rule on or off (`PUT`/`DELETE /me/notify-rules`). Resolves to the problem in words, or null. */
  setRule: (rule: NotifyRule, on: boolean) => Promise<string | null>;
}

/**
 * Notifications: "always notify me when [person] posts", everywhere or in
 * chosen rooms (NOTE-1, NOTE-2). Somebody naming you always reaches you;
 * there is nothing else to turn on, and no @everyone.
 */
export function NotificationsSection({ people, rooms, rules, setRule }: NotificationsProps) {
  const [open, setOpen] = useState<string | null>(null);
  const save = useSave();
  const others = [...people].sort((a, b) => a.display_name.localeCompare(b.display_name));
  const change = (rule: NotifyRule, on: boolean) => void save.run(setRule(rule, on));

  return (
    <Block
      heading={HEADINGS.banners}
      lead="Mentions can show a desktop banner. Choose people whose other messages should also notify you, across this server or in chosen rooms. Banners are separate from chimes."
    >
      {others.length === 0 ? (
        <Note>Nobody else is here yet.</Note>
      ) : (
        <ul className="nx-set-list" aria-label="People">
          {others.map((person) => (
            <PersonRules
              key={person.id}
              person={person}
              rooms={rooms}
              rules={rules}
              open={open === person.id}
              onOpen={(on) => setOpen(on ? person.id : null)}
              onChange={change}
            />
          ))}
        </ul>
      )}
      <SaveLine phase={save.phase.kind === "problem" ? save.phase : { kind: "idle" }} />
      <Note>Somebody naming you always reaches you. Nothing else does, and there is no @everyone to turn on.</Note>
    </Block>
  );
}

function PersonRules({
  person,
  rooms,
  rules,
  open,
  onOpen,
  onChange,
}: {
  person: User;
  rooms: readonly Room[];
  rules: readonly NotifyRule[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (rule: NotifyRule, on: boolean) => void;
}) {
  const body = useId();
  const header = useRef<HTMLButtonElement | null>(null);
  const theirs = rules.filter((rule) => rule.target_user_id === person.id);
  const everywhere = theirs.some((rule) => rule.room_id === null);
  const summary = ruleSummary(rules, person.id, rooms);
  // Escape inside a person's choices folds them and hands focus back.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onOpen(false);
    header.current?.focus();
  };
  return (
    <li className="nx-set-person" data-open={open ? "yes" : undefined}>
      <button
        ref={header}
        type="button"
        className="nx-set-person-head"
        aria-expanded={open}
        aria-controls={body}
        aria-label={`${person.display_name}: ${summary}`}
        onClick={() => onOpen(!open)}
      >
        <span className="nx-set-caret">
          <Icon name="caret" size="sm" />
        </span>
        <Name person={person} />
        <span className="nx-set-person-summary">{summary}</span>
      </button>
      {open ? (
        <div id={body} className="nx-set-person-body" onKeyDown={onKeyDown}>
          <SettingRow
            title="Everywhere"
            description={`Every message ${person.display_name} writes, in any room you can see.`}
            control={<Switch label={`Everywhere, for ${person.display_name}`} checked={everywhere} onChange={(on) => onChange({ target_user_id: person.id, room_id: null }, on)} />}
          />
          {everywhere ? null : (
            <div className="nx-set-rooms" role="group" aria-label={`Rooms where ${person.display_name} notifies you`}>
              {rooms.map((room) => {
                const on = theirs.some((rule) => rule.room_id === room.id);
                return (
                  <Button key={room.id} size="sm" pressed={on} onClick={() => onChange({ target_user_id: person.id, room_id: room.id }, !on)}>
                    #{room.name}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}
