import { type RefObject, useEffect, useRef, useState } from "react";
import { volumeLabel } from "../../../lib/voice";
import { Icon, Name, Popover, Row, RowList, TextField, VoiceGlyph } from "../../kit";
import { markerFor } from "../markers";
import { useAbove } from "./useAbove";
import type { VoiceDockPerson } from "./VoiceDock";
import "./EveryoneCard.css";

/**
 * Everyone in a big voice room by name (#197), opened from its crowd of
 * markers: to see who's there, and to find somebody to make quieter or
 * louder. Alphabetical, so a name stays put while people talk; talking shows
 * as the bars beside a name. Picking somebody opens their volume card in its
 * place. You aren't listed: your own seat is always first in the bar.
 */
export function EveryoneCard({
  people,
  where,
  anchor,
  onPick,
  onClose,
}: {
  /** Everyone in voice but you. */
  people: VoiceDockPerson[];
  /** "#raid-night". */
  where: string;
  /** The crowd that opened it: the card sits over it. */
  anchor: RefObject<HTMLElement | null>;
  onPick: (person: VoiceDockPerson) => void;
  onClose: () => void;
}) {
  const [find, setFind] = useState("");
  const body = useRef<HTMLDivElement | null>(null);
  const at = useAbove(anchor, body);

  // The search box has the keyboard as soon as it opens.
  useEffect(() => {
    body.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  const wanted = find.trim().toLocaleLowerCase();
  const shown = [...people]
    .sort((a, b) => a.user.display_name.localeCompare(b.user.display_name))
    .filter((person) => wanted === "" || person.user.display_name.toLocaleLowerCase().includes(wanted) || person.user.username.toLocaleLowerCase().includes(wanted));

  return (
    <Popover label={`Everyone in voice in ${where}`} at={at} onClose={onClose}>
      <div className="nx-everyone" ref={body}>
        <p className="nx-everyone-head">
          <span className="nx-everyone-label">In voice</span>
          <span className="nx-everyone-where">{where}</span>
        </p>
        <TextField
          label={`Find somebody in voice in ${where}`}
          hideLabel
          icon="search"
          placeholder="Find someone"
          value={find}
          onChange={setFind}
          // Enter picks the first one found, as the new-message picker does.
          onEnter={() => {
            const [first] = shown;
            if (first) onPick(first);
          }}
        />
        {shown.length > 0 ? (
          <div className="nx-everyone-list">
            <RowList label={`In voice in ${where}`}>
              {shown.map((person) => (
                <Row
                  key={person.user.id}
                  lead={{ kind: "person", person: markerFor(person.user, "in_room") }}
                  lines="one"
                  title={<Name person={person.user} />}
                  trailing={<Marks person={person} />}
                  note={noteOf(person)}
                  label={`${person.user.display_name}'s volume, ${volumeLabel(person.volume ?? 1)}`}
                  onActivate={() => onPick(person)}
                />
              ))}
            </RowList>
          </div>
        ) : (
          <p className="nx-everyone-none">Nobody by that name in voice.</p>
        )}
      </div>
    </Popover>
  );
}

/** Beside a name: their microphone off, as its control's glyph, and the bars while they talk. */
function Marks({ person }: { person: VoiceDockPerson }) {
  const off = person.controls === "deafened" ? { icon: "headOff" as const, word: "Deafened" } : person.controls === "muted" ? { icon: "micOff" as const, word: "Muted" } : null;
  if (!off && !person.speaking) return null;
  return (
    <>
      {off ? (
        <span className="nx-everyone-state" title={off.word}>
          <Icon name={off.icon} size="sm" />
          <span className="k-sr-only">{off.word}</span>
        </span>
      ) : null}
      {person.speaking ? <VoiceGlyph speaking /> : null}
    </>
  );
}

/** The faint note at the end: trouble reaching them first, then a volume you changed. */
function noteOf(person: VoiceDockPerson): string | undefined {
  if (person.link === "connecting") return "connecting…";
  if (person.link === "unreachable") return "can't reach";
  const volume = person.volume ?? 1;
  return Math.abs(volume - 1) > 0.001 ? volumeLabel(volume) : undefined;
}
