import { type KeyboardEvent, useId, useRef, useState } from "react";
import type { NotifyRule } from "../../../generated/NotifyRule";
import type { PushSettings } from "../../../generated/PushSettings";
import type { Room } from "../../../generated/Room";
import type { User } from "../../../generated/User";
import { isOnlyMentions, onlyMentions, type PhonePush, type PushSupport, roomChoice, withRoom } from "../../../lib/push";
import { HEADINGS, ruleSummary } from "../../core/settings";
import { Button, Icon, Name, Select, SettingRow, Switch } from "../../kit";
import { Block, Note, SaveLine, useSave } from "./parts";

/** Phone notifications on this phone, for the server Settings shows (#830, SPEC §4.15). */
export interface PhonePushProps {
  support: PushSupport;
  state: PhonePush;
  /** Each resolves to the problem in words, or null. */
  turnOn: () => Promise<string | null>;
  turnOff: () => Promise<string | null>;
  change: (settings: PushSettings) => Promise<string | null>;
}

export interface NotificationsProps {
  /** Everyone else on the server, by name. */
  people: readonly User[];
  /** The server's rooms, not archived. */
  rooms: readonly Room[];
  rules: readonly NotifyRule[];
  /** Turn one rule on or off (`PUT`/`DELETE /me/notify-rules`). Resolves to the problem in words, or null. */
  setRule: (rule: NotifyRule, on: boolean) => Promise<string | null>;
  /** Arrival cards (decision 13): on unless turned off, on this computer. */
  arrivals?: { on: boolean; onChange: (on: boolean) => void };
  /** DM alerts (#291): a banner for every DM, and the taskbar. On unless turned off, on this computer. */
  dmAlerts?: { on: boolean; onChange: (on: boolean) => void };
  /** On the phone: its own notifications, in place of the desktop's banners (#830). */
  phonePush?: PhonePushProps;
}

/**
 * Notifications: DMs (#291), and "always notify me when [person] posts",
 * everywhere or in chosen rooms (NOTE-1, NOTE-2). Somebody naming you always
 * reaches you, and so does a DM unless DM banners are off. There is no
 * @everyone.
 */
export function NotificationsSection({ people, rooms, rules, setRule, arrivals, dmAlerts, phonePush }: NotificationsProps) {
  const [open, setOpen] = useState<string | null>(null);
  const save = useSave();
  const others = [...people].sort((a, b) => a.display_name.localeCompare(b.display_name));
  const change = (rule: NotifyRule, on: boolean) => void save.run(setRule(rule, on));

  return (
    <>
      {phonePush ? <PhoneNotifications push={phonePush} rooms={rooms} /> : null}
      <Block
        heading={phonePush ? HEADINGS.follows : HEADINGS.banners}
        lead={
          phonePush
            ? "Choose people whose messages should reach you even when they don't name you, across this server or in chosen rooms. People you follow, above, turns these on and off on this phone."
            : "DMs and mentions can show a desktop banner. Choose people whose other messages should also notify you, across this server or in chosen rooms. Banners are separate from chimes."
        }
      >
        {dmAlerts ? (
          <SettingRow
            title="DMs"
            description="A banner for every DM, saying who it's from, and Linger's taskbar button flashes until you look. Nothing for a DM you're reading. On this computer only."
            control={<Switch label="Banners for DMs" checked={dmAlerts.on} onChange={dmAlerts.onChange} />}
          />
        ) : null}
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
        {phonePush ? null : (
          <Note>Somebody naming you always reaches you, and so does a DM while DM banners are on. There is no @everyone to turn on.</Note>
        )}
      </Block>
      {arrivals ? (
        <Block heading={HEADINGS.arrivals} lead="Who's around, as it happens. On this computer only.">
          <SettingRow
            title="Arrival cards"
            description="A small card when somebody comes into a room: “Callie came into #general”. It never takes the cursor and goes by itself. None from a Quiet server, or in quiet hours. The door chime, in Sound & Voice, is its sound."
            control={<Switch label="Arrival cards" checked={arrivals.on} onChange={arrivals.onChange} />}
          />
        </Block>
      ) : null}
    </>
  );
}

type RoomPick = "off" | "wakes" | "every";

const ROOM_PICKS: readonly { value: RoomPick; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "wakes", label: "When it wakes up" },
  { value: "every", label: "Every message" },
];

/**
 * This phone's notifications from this server (#830, SPEC §4.15): off until
 * turned on, then each kind its own switch, "only mentions" one tap, and a
 * choice per room. Each change reaches the server at once.
 */
function PhoneNotifications({ push, rooms }: { push: PhonePushProps; rooms: readonly Room[] }) {
  const save = useSave();
  const { state, support } = push;
  const settings = state.settings;
  const set = (next: PushSettings) => void save.run(push.change(next));
  const kind = (key: "mentions" | "dms" | "knocks" | "follows", title: string, description: string) => (
    <SettingRow
      title={title}
      description={description}
      control={<Switch label={title} checked={settings[key]} onChange={(on) => set({ ...settings, [key]: on })} />}
    />
  );

  if (support === "unknown") {
    return (
      <Block heading={HEADINGS.phonePush}>
        <Note>Asking this server…</Note>
      </Block>
    );
  }
  if (support !== "on") {
    return (
      <Block heading={HEADINGS.phonePush}>
        <Note tone="status">
          {support === "old"
            ? "This server needs an update before it can notify your phone. Its host can update it."
            : "This server's host turned phone notifications off."}
        </Note>
      </Block>
    );
  }
  const main = (
    <Block
      heading={HEADINGS.phonePush}
      lead="Off until you turn them on. They go through Apple or Google and Linger's relay, encrypted so none of them can read what they say. Nothing while you're using Linger somewhere else."
    >
      <SettingRow
        title="Notifications"
        description={state.on ? "On, for this server, on this phone." : "Nothing from this server reaches this phone."}
        control={
          <Switch
            label="Notifications on this phone"
            checked={state.on}
            onChange={(on) => void save.run(on ? push.turnOn() : push.turnOff())}
          />
        }
      />
      {state.on ? (
        <>
          <SettingRow
            title="Only when somebody mentions me"
            description="Mentions, and nothing else from this server."
            control={
              <Button size="sm" pressed={isOnlyMentions(settings)} onClick={() => set(onlyMentions(settings))}>
                Only mentions
              </Button>
            }
          />
          {kind("mentions", "Mentions", "Somebody names you.")}
          {kind("dms", "DMs", "Somebody writes to you.")}
          {kind("knocks", "Knocks", "Somebody knocks on your row.")}
          {kind("follows", "People you follow", "Somebody you chose below posts.")}
        </>
      ) : null}
      <SaveLine phase={save.phase.kind === "problem" ? save.phase : { kind: "idle" }} />
    </Block>
  );
  return (
    <>
      {main}
      {state.on ? (
        <Block
          heading={HEADINGS.phoneRooms}
          lead="Each room is off until you choose. When it wakes up is a room's first message after an hour with none. Every message is once a burst: the next replaces the last, and the room is quiet until you read it or 15 minutes pass."
        >
          <ul className="nx-set-list" aria-label="Rooms on this phone">
            {rooms.map((room) => (
              <li key={room.id}>
                <SettingRow
                  title={`#${room.name.replace(/^#/, "")}`}
                  control={
                    <Select<RoomPick>
                      label={`Notifications from #${room.name.replace(/^#/, "")}`}
                      hideLabel
                      size="sm"
                      value={roomChoice(settings, room.id) ?? "off"}
                      options={ROOM_PICKS}
                      onChange={(pick) => set(withRoom(settings, room.id, pick === "off" ? null : pick))}
                    />
                  }
                />
              </li>
            ))}
          </ul>
        </Block>
      ) : null}
    </>
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
