import { useState } from "react";
import type { ListModel } from "../../core/list";
import { TitleBar } from "../../kit";
import { LogoMark } from "../LogoMark";
import "./ListView.css";
import { ServerBody, type ServerBodyActions } from "./ServerBody";
import { type ServerListing, ServerSection } from "./ServerSection";
import { type YouActions, YouCard } from "./YouCard";
import { type AwayEverywhere, YouEverywhere } from "./YouEverywhere";
import { VoiceDock, type VoiceDockProps } from "./VoiceDock";

export type { ServerListing } from "./ServerSection";
export type { AwayEverywhere } from "./YouEverywhere";

/**
 * One server, passed the way the list window passed it before there could be
 * several: the same list as `servers` with one entry.
 */
export interface OneServer extends ServerBodyActions {
  serverName: string;
  model: ListModel;
  /** Who is talking right now, for the voice glyphs. */
  speaking?: ReadonlySet<string>;
  servers?: undefined;
}

export type ListViewProps = ListShared &
  (
    | {
        /**
         * Your servers, in your order. With one, the list is that server's; with
         * several, each gets a section of its own (docs/design/buddy-list.md,
         * "Several servers").
         */
        servers: ServerListing[];
      }
    | OneServer
  );

interface ListShared {
  /** Where the desktop draws no close button, Linger draws its own. */
  onClose?: () => void;
  /** You're in voice: the voice bar at the bottom. */
  voice?: VoiceDockProps;
  /** One server: changing your status and going away, from the top card. */
  you?: YouActions;
  /** Several servers: going away, with a choice of where, and coming back. */
  everywhere?: AwayEverywhere;
  /** Several servers: a server's Quiet, from its menu. */
  onQuiet?: (server: string, quiet: boolean) => void;
  /** Several servers: moving a server up or down your order, from its menu. */
  onMove?: (server: string, by: -1 | 1) => void;
  /** Several servers: which start folded. Every server but the first, if left out. */
  folded?: readonly string[];
}

/**
 * The buddy list (docs/design/buddy-list.md): you, then the rooms with who's
 * in them, your DMs, and everyone else, for each of your servers. Drawn only
 * from the models and the kit, so the same view serves the real window and
 * the fixture page.
 */
export function ListView(props: ListViewProps) {
  const { onClose, voice, you, everywhere, onQuiet, onMove, folded } = props;
  const servers = props.servers;
  const [foldedIds, setFoldedIds] = useState<ReadonlySet<string>>(
    () => new Set(folded ?? (servers ?? []).slice(1).map((server) => server.id)),
  );

  if (servers === undefined || servers.length <= 1) {
    const only: (OneServer | ServerListing) | undefined = servers === undefined ? props : servers[0];
    const name = only === undefined ? "Linger" : "serverName" in only ? only.serverName : only.name;
    return (
      <div className="nx-list" data-screen="list">
        <TitleBar leading={<LogoMark />} onClose={onClose}>
          {name}
        </TitleBar>

        {only?.model.me ? <YouCard me={only.model.me} actions={you} /> : null}

        <div className="nx-list-scroll">
          {only ? (
            <ServerBody
              model={only.model}
              speaking={only.speaking}
              onOpenRoom={only.onOpenRoom}
              onOpenDm={only.onOpenDm}
              onMessage={only.onMessage}
              onKnock={only.onKnock}
              onStartDm={only.onStartDm}
            />
          ) : null}
        </div>

        {voice ? <VoiceDock {...voice} /> : null}
      </div>
    );
  }

  // Who you are, for the top card: you on your first server. The card only
  // says what's true everywhere; each server's section says who you are there.
  const me = servers.find((server) => server.model.me !== null)?.model.me?.user ?? null;
  const toggle = (id: string) =>
    setFoldedIds((held) => {
      const next = new Set(held);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="nx-list" data-screen="list" data-servers="several">
      <TitleBar leading={<LogoMark />} onClose={onClose}>
        Linger
      </TitleBar>

      {me ? <YouEverywhere me={me} servers={servers} actions={everywhere} /> : null}

      <div className="nx-list-scroll">
        {servers.map((listing, index) => (
          <ServerSection
            key={listing.id}
            listing={listing}
            index={index}
            folded={foldedIds.has(listing.id)}
            first={index === 0}
            last={index === servers.length - 1}
            onToggle={() => toggle(listing.id)}
            onQuiet={onQuiet ? (quiet) => onQuiet(listing.id, quiet) : undefined}
            onMove={onMove ? (by) => onMove(listing.id, by) : undefined}
          />
        ))}
      </div>

      {voice ? <VoiceDock {...voice} /> : null}
    </div>
  );
}
