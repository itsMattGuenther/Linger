import { memo, useCallback, useMemo } from "react";
import type { CustomEmoji } from "../../../generated/CustomEmoji";
import type { Motd } from "../../../generated/Motd";
import type { User } from "../../../generated/User";
import { setWhen } from "../../../lib/time";
import { Icon, IconButton, Name } from "../../kit";
import { type CustomEmojiByName, type MentionLookup, MessageText } from "./MessageText";
import "./MotdStrip.css";

const NO_EMOJI: readonly CustomEmoji[] = [];

/**
 * A room's message of the day (SPEC §4.1, #464), whole, under the room's
 * header: what's happening now, where the topic in the header says what the
 * room is about. Its words read as a message's do, links and all, with who set
 * it and when under them.
 *
 * The arrow folds it to one line that stays put, for you on this device; a
 * new message of the day opens it again (core/chat/motd.ts). Nothing about it
 * is a count or a call: it's there for whoever comes in.
 */
export const MotdStrip = memo(function MotdStrip({
  motd,
  people,
  me,
  customEmoji = NO_EMOJI,
  now,
  folded,
  onFold,
  onOpenLink,
}: {
  motd: Motd;
  /** Everyone the room may name, by id: who set it, and anybody it mentions. */
  people: ReadonlyMap<string, User>;
  me: User | null;
  customEmoji?: readonly CustomEmoji[];
  now: number;
  folded: boolean;
  onFold: (folded: boolean) => void;
  onOpenLink: (href: string) => void;
}) {
  const byHandle = useMemo(() => new Map([...people.values()].map((person) => [person.username, person])), [people]);
  const mentions = useCallback<MentionLookup>(
    (handle) => {
      const person = byHandle.get(handle);
      return person === undefined ? null : { name: person.display_name, me: person.id === me?.id };
    },
    [byHandle, me?.id],
  );
  const emoji = useMemo<CustomEmojiByName>(() => new Map(customEmoji.map((one) => [one.name, one])), [customEmoji]);
  const by = people.get(motd.set_by);

  return (
    <div className="nx-motd" role="note" aria-label="Message of the day" data-folded={folded ? "yes" : undefined}>
      <Icon name="pin" size="sm" />
      <div className="nx-motd-words">
        <MessageText source={motd.text} mentions={mentions} emoji={emoji} onOpenLink={onOpenLink} />
        {folded ? null : (
          <p className="nx-motd-by">
            Message of the day, set by {by ? <Name person={by} size="inline" /> : "someone"} {setWhen(motd.set_at, now)}
          </p>
        )}
      </div>
      <IconButton
        icon={folded ? "down" : "up"}
        label={folded ? "Show the whole message of the day" : "Fold the message of the day to one line"}
        size="sm"
        onClick={() => onFold(!folded)}
      />
    </div>
  );
});
