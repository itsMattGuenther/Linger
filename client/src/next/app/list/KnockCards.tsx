import { useEffect } from "react";
import type { User } from "../../../generated/User";
import { KNOCK_TTL_MS } from "../../../lib/gateway";
import { ARRIVAL_TTL_MS } from "../../core/arrivals";
import { Name, Notice } from "../../kit";
import "./KnockCards.css";

/** One knock on your door, from the store (`GatewayState.knocks`). */
export interface KnockCard {
  server: string;
  id: string;
  /** When it arrived, by this computer's clock. */
  at: number;
  /** Who knocked, or null for somebody the list doesn't know yet. */
  from: User | null;
  /** Which server, said only when you're on more than one. */
  serverName: string | null;
}

/** Somebody came into a room (decision 13, `core/arrivals.ts`). */
export interface ArrivalCard {
  server: string;
  id: string;
  at: number;
  who: User | null;
  /** The room's name, without its #. */
  room: string;
  serverName: string | null;
}

/**
 * Somebody knocked on your door (SPEC §4.9, parity KNOCK-2): a card says who,
 * then goes by itself. It has no buttons (a knock is nothing to answer), it
 * never takes focus (whatever you were typing keeps the caret), it's
 * announced politely, and it leaves nothing behind. Knocks from every server
 * come here, even a quiet one's.
 *
 * Arrivals ("Callie came into #general", decision 13) land in the same band,
 * above the knocks, and behave the same way.
 */
export function KnockCards({
  cards,
  onGone,
  arrivals = [],
  onArrivalGone,
}: {
  cards: readonly KnockCard[];
  onGone: (server: string, id: string) => void;
  arrivals?: readonly ArrivalCard[];
  onArrivalGone?: (id: string) => void;
}) {
  if (cards.length === 0 && arrivals.length === 0) return null;
  return (
    <div className="nx-knocks" data-screen="knocks">
      {arrivals.map((card) => (
        <OneArrival key={card.id} card={card} onGone={onArrivalGone} />
      ))}
      {cards.map((card) => (
        <OneKnock key={`${card.server} ${card.id}`} card={card} onGone={onGone} />
      ))}
    </div>
  );
}

function OneArrival({ card, onGone }: { card: ArrivalCard; onGone?: (id: string) => void }) {
  const { id, at } = card;
  useEffect(() => {
    if (!onGone) return;
    const timer = window.setTimeout(() => onGone(id), Math.max(0, at + ARRIVAL_TTL_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [id, at, onGone]);
  return (
    <Notice icon="door" tag={card.serverName ? <span className="nx-knock-server">{card.serverName}</span> : undefined}>
      {card.who ? <Name person={card.who} size="inline" /> : "Somebody"} came into #{card.room}.
    </Notice>
  );
}

/**
 * A card holds its own end, timed from when the knock arrived rather than
 * from when it was drawn, so one drawn late still goes on time.
 */
function OneKnock({ card, onGone }: { card: KnockCard; onGone: (server: string, id: string) => void }) {
  const { server, id, at } = card;
  useEffect(() => {
    const timer = window.setTimeout(() => onGone(server, id), Math.max(0, at + KNOCK_TTL_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [server, id, at, onGone]);

  return (
    <Notice icon="knock" tag={card.serverName ? <span className="nx-knock-server">{card.serverName}</span> : undefined}>
      {card.from ? <Name person={card.from} size="inline" /> : "Somebody"} knocked. <span className="nx-knock-hi">Just saying hi.</span>
    </Notice>
  );
}
