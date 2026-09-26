import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { User } from "../../../generated/User";
import type { PersonRow } from "../../core/list";
import { candidates, existingDm, MAX_PICKS, pickedLabel } from "../../core/newDm";
import { Button, Chip, Name, Popover, Row, RowList, TextField } from "../../kit";
import { markerFor } from "../markers";
import "./NewDmPicker.css";

export interface NewDmPickerProps {
  /** Everyone else on the server, with where they are, from the list model. */
  people: PersonRow[];
  meId: string | null;
  /** Your DMs, by who's in them. */
  dms: { id: string; member_ids: string[] | null }[];
  /** The DMs heading, in window coordinates: the picker opens under it. */
  anchor: { bottom: number };
  /** Open the DM; resolves to what went wrong, in words, or null once it's open. */
  onStart: (people: User[]) => Promise<string | null>;
  onCancel: () => void;
}

/**
 * Start a DM (docs/design/buddy-list.md): pick one to seven people and open
 * the conversation with exactly them, which is the DM you already have if
 * there is one (SPEC §4.13). It opens inside the list window, under the DMs
 * heading.
 */
export function NewDmPicker({ people, meId, dms, anchor, onStart, onCancel }: NewDmPickerProps) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<User[]>([]);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ x: 8, y: anchor.bottom + 4 });

  useLayoutEffect(() => {
    const card = box.current?.parentElement;
    if (!card) return;
    // Layout sizes, not the drawn box: the card is still scaled down by its opening animation here.
    const { offsetWidth: width, offsetHeight: height } = card;
    const x = Math.max(8, Math.round((window.innerWidth - width) / 2));
    const y = Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - 8 - height));
    setAt((held) => (held.x === x && held.y === y ? held : { x, y }));
  }, [anchor.bottom, picked.length]);

  const rows = useMemo(() => new Map(people.map((row) => [row.user.id, row])), [people]);
  const users = useMemo(() => people.map((row) => row.user), [people]);
  const pickedIds = picked.map((user) => user.id);
  const offered = candidates(users, meId, query, pickedIds);
  const full = picked.length >= MAX_PICKS;
  const existing = existingDm(dms, meId, pickedIds);

  const pick = (user: User) => {
    if (full) return;
    setPicked((held) => [...held, user]);
    setQuery("");
    setProblem(null);
  };
  const unpick = (user: User) => {
    setPicked((held) => held.filter((person) => person.id !== user.id));
    setProblem(null);
  };
  const start = () => {
    if (picked.length === 0 || starting) return;
    setStarting(true);
    setProblem(null);
    void onStart(picked).then((went) => {
      // On success the list closes the picker; only a problem comes back here.
      setStarting(false);
      setProblem(went);
    });
  };

  const line = problem
    ? problem
    : picked.length === 0
      ? `Pick up to ${MAX_PICKS} people.`
      : existing
        ? `You already have a DM with ${pickedLabel(picked)}.`
        : `A new DM with ${pickedLabel(picked)}.`;

  return (
    <Popover label="New message" at={at} onClose={onCancel}>
      <div className="nx-newdm" ref={box}>
        <h2 className="nx-newdm-title">New message</h2>
        <div className="nx-newdm-to">
          <span className="nx-newdm-to-label">To</span>
          {picked.length === 0 ? <span className="nx-newdm-nobody">nobody yet</span> : null}
          {picked.map((user) => (
            <Chip key={user.id} label={user.display_name} marker={markerFor(user, rows.get(user.id)?.state ?? "offline")} onRemove={() => unpick(user)}>
              <Name person={user} size="control" />
            </Chip>
          ))}
        </div>
        <div
          onKeyDown={(event) => {
            if (event.key === "Backspace" && query === "" && picked.length > 0) {
              const last = picked.at(-1);
              if (last) unpick(last);
            }
          }}
        >
          <TextField
            label="Add someone"
            hideLabel
            placeholder={full ? "That's everyone a DM can hold" : "Add someone"}
            value={query}
            onChange={setQuery}
            icon="search"
            size="md"
            autoFocus
            disabled={full}
            onEnter={() => {
              const first = offered[0];
              if (first) pick(first);
            }}
          />
        </div>
        <div className="nx-newdm-list">
          {offered.length === 0 ? (
            <p className="nx-newdm-empty">{query.trim() === "" ? "Everyone's picked." : `Nobody called “${query.trim()}”.`}</p>
          ) : (
            <RowList label="People to pick">
              {offered.map((user) => {
                const row = rows.get(user.id);
                return (
                  <Row
                    key={user.id}
                    lead={{ kind: "person", person: markerFor(user, row?.state ?? "offline") }}
                    lines="two"
                    title={<Name person={user} />}
                    label={`Add ${user.display_name}`}
                    note={row?.note}
                    detail={row?.line ?? undefined}
                    away={row?.state === "away"}
                    disabled={full}
                    onActivate={() => pick(user)}
                  />
                );
              })}
            </RowList>
          )}
        </div>
        <p className="nx-newdm-line" role="status" data-problem={problem ? "" : undefined}>
          {line}
        </p>
        <div className="nx-newdm-actions">
          <Button size="md" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="md" variant="primary" icon="message" disabled={picked.length === 0 || starting} onClick={start}>
            {starting ? "Opening…" : existing ? "Open the DM" : "Start the DM"}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
