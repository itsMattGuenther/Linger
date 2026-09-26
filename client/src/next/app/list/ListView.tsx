import { type ReactNode, useState } from "react";
import type { ListModel } from "../../core/list";
import { Button, IconButton, TitleBar } from "../../kit";
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
  /** The gear: opens Settings (Ctrl+, does too). */
  onSettings?: () => void;
  /** The foot of the list: Media and Search, each in a window of its own (decision 15). */
  onMedia?: () => void;
  onSearch?: () => void;
  /**
   * Cards that come and go, like a knock on your door: laid over the bottom
   * of the list, just above the voice bar, so they never cover its controls.
   */
  notices?: ReactNode;
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
  const { onClose, onSettings, notices, voice, you, everywhere, onQuiet, onMove, folded, onMedia, onSearch } = props;
  const gear = onSettings ? <IconButton icon="gear" label="Settings" onClick={onSettings} /> : undefined;
  const bottom = (
    <>
      <div className="nx-list-notices">{notices}</div>
      {voice ? <VoiceDock {...voice} /> : null}
      {onMedia || onSearch ? (
        <nav className="nx-list-foot" aria-label="Media and search">
          {onMedia ? (
            <Button variant="quiet" icon="media" fill onClick={onMedia}>
              Media
            </Button>
          ) : null}
          {onSearch ? (
            <Button variant="quiet" icon="search" fill onClick={onSearch}>
              Search
            </Button>
          ) : null}
        </nav>
      ) : null}
    </>
  );
  const servers = props.servers;
  // What you've folded or opened yourself, by server. Anything you haven't
  // touched follows `folded`, or starts folded if it isn't your first server;
  // decided as each server appears, since they arrive one by one.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isFolded = (id: string, index: number) => chosen.get(id) ?? (folded ? folded.includes(id) : index > 0);

  if (servers === undefined || servers.length <= 1) {
    const only: (OneServer | ServerListing) | undefined = servers === undefined ? props : servers[0];
    const name = only === undefined ? "Linger" : "serverName" in only ? only.serverName : only.name;
    return (
      <div className="nx-list" data-screen="list">
        <TitleBar leading={<LogoMark />} actions={gear} onClose={onClose}>
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

        {bottom}
      </div>
    );
  }

  // Who you are, for the top card: you on your first server. The card only
  // says what's true everywhere; each server's section says who you are there.
  const me = servers.find((server) => server.model.me !== null)?.model.me?.user ?? null;
  const toggle = (id: string, index: number) =>
    setChosen((held) => new Map(held).set(id, !(held.get(id) ?? (folded ? folded.includes(id) : index > 0))));

  return (
    <div className="nx-list" data-screen="list" data-servers="several">
      <TitleBar leading={<LogoMark />} actions={gear} onClose={onClose}>
        Linger
      </TitleBar>

      {me ? <YouEverywhere me={me} servers={servers} actions={everywhere} /> : null}

      <div className="nx-list-scroll">
        {servers.map((listing, index) => (
          <ServerSection
            key={listing.id}
            listing={listing}
            index={index}
            folded={isFolded(listing.id, index)}
            first={index === 0}
            last={index === servers.length - 1}
            onToggle={() => toggle(listing.id, index)}
            onQuiet={onQuiet ? (quiet) => onQuiet(listing.id, quiet) : undefined}
            onMove={onMove ? (by) => onMove(listing.id, by) : undefined}
          />
        ))}
      </div>

      {bottom}
    </div>
  );
}
