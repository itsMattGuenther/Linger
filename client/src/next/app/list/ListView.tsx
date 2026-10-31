import { memo, type ReactNode, useCallback, useMemo, useState } from "react";
import type { ListModel } from "../../core/list";
import { minimizer } from "../../core/windowControls";
import { Button, IconButton, TitleBar } from "../../kit";
import { LogoMark } from "../LogoMark";
import "./ListView.css";
import { ServerBody, type ServerBodyActions } from "./ServerBody";
import { type BlockedListing, BlockedSection, type ServerListing, ServerSection } from "./ServerSection";
import type { AwayNudge } from "./AwayNudge";
import { type YouActions, YouCard } from "./YouCard";
import { type AwayEverywhere, YouEverywhere } from "./YouEverywhere";
import { VoiceDock, type VoiceDockProps } from "./VoiceDock";

export type { BlockedListing, ServerListing } from "./ServerSection";
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
  /**
   * Folded with conversations kept (#337): bringing them back beside the
   * list. Folding them away is the conversations' own button, at their edge.
   */
  onUnfold?: () => void;
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
  /**
   * Knocks on your door so far (#211): each new one rocks the whole list,
   * title bar and all, as the prototype's window did. 0 or none: still.
   */
  rock?: number;
  /**
   * Standing lines that stay while they're true (decision 1): connection
   * trouble, the keyring, a new version. Between the list and the voice bar.
   */
  notes?: ReactNode;
  /** You're in voice: the voice bar at the bottom. */
  voice?: VoiceDockProps;
  /** One server: changing your status and going away, from the top card. */
  you?: YouActions;
  /**
   * You're back at the computer and still away (#392): the top card says so,
   * beside I'm back, until you come back or wave it off.
   */
  nudge?: AwayNudge;
  /**
   * One server: your name on the top card opens your own card, as friends
   * see it (#271), and this is its Edit profile: Settings → Profile.
   */
  onEditProfile?: () => void;
  /** Several servers: going away, with a choice of where, and coming back. */
  everywhere?: AwayEverywhere;
  /** Several servers: a server's Quiet, from its menu. */
  onQuiet?: (server: string, quiet: boolean) => void;
  /** Several servers: moving a server up or down your order, from its menu. */
  onMove?: (server: string, by: -1 | 1) => void;
  /** Several servers: Settings → Profile for who you are on one, from its menu (#719). */
  onProfileOn?: (server: string) => void;
  /** Several servers: which start folded. Every server, if left out (#712). */
  folded?: readonly string[];
  /**
   * Servers that need a newer app than this one (#793), in your order: each
   * a dimmed section after the ones that work. With any, the list has
   * sections, even beside one working server or none.
   */
  blocked?: readonly BlockedListing[];
}

/** The logo at the head of the list: one element, drawn once. */
const LOGO = <LogoMark />;

/** The foot of the list: Media and Search, each in a window of its own (decision 15). */
const Foot = memo(function Foot({ onMedia, onSearch }: { onMedia?: () => void; onSearch?: () => void }) {
  if (!onMedia && !onSearch) return null;
  return (
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
  );
});

/**
 * The buddy list (docs/design/buddy-list.md): you, then the rooms with who's
 * in them, your DMs, and everyone else, for each of your servers. Drawn only
 * from the models and the kit, so the same view serves the real window and
 * the fixture page.
 */
export function ListView(props: ListViewProps) {
  const { onClose, onSettings, notices, notes, voice, you, nudge, onEditProfile, everywhere, onQuiet, onMove, onProfileOn, folded, onMedia, onSearch, rock, onUnfold } = props;
  const blocked = props.blocked ?? [];
  // Two names for one rock, taken in turn, so a knock during a rock starts it over.
  const rocking = rock ? (rock % 2 === 1 ? "a" : "b") : undefined;
  // Made again only when what's in them changes, so an event on a server
  // doesn't draw the title bar and the foot again with its section (#533).
  const gear = useMemo(
    () =>
      onSettings || onUnfold ? (
        <>
          {onSettings ? <IconButton icon="gear" label="Settings" onClick={onSettings} /> : null}
          {/* Neutral, not the lamp: amber is for something new (a lit DM), and this is only a way back. */}
          {onUnfold ? <IconButton icon="unfold" tone="filled" label="Show your conversations" onClick={onUnfold} /> : null}
        </>
      ) : undefined,
    [onSettings, onUnfold],
  );
  const minimize = onClose && minimizer();
  const bottom = (
    <>
      <div className="nx-list-notices">{notices}</div>
      {notes}
      {voice ? <VoiceDock {...voice} /> : null}
      <Foot onMedia={onMedia} onSearch={onSearch} />
    </>
  );
  const servers = props.servers;
  // What you've folded or opened yourself, by server, until Linger closes.
  // Anything you haven't touched follows `folded`, or starts folded: every
  // server does, so the list opens on all of them, each header saying
  // what's happening there, and you open the one you want. The first one
  // opened by itself, and buried the rest under it (#712).
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const startsFolded = useCallback((id: string) => (folded ? folded.includes(id) : true), [folded]);
  const isFolded = (id: string) => chosen.get(id) ?? startsFolded(id);
  const toggle = useCallback((id: string) => setChosen((held) => new Map(held).set(id, !(held.get(id) ?? startsFolded(id)))), [startsFolded]);

  if (servers === undefined || (servers.length <= 1 && blocked.length === 0)) {
    const only: (OneServer | ServerListing) | undefined = servers === undefined ? props : servers[0];
    const name = only === undefined ? "Linger" : "serverName" in only ? only.serverName : only.name;
    return (
      <div className="nx-list" data-screen="list" data-rock={rocking}>
        <TitleBar leading={LOGO} actions={gear} onMinimize={minimize} onClose={onClose}>
          {name}
        </TitleBar>

        {only?.model.me ? <YouCard me={only.model.me} actions={you} nudge={nudge} onEditProfile={onEditProfile} /> : null}

        <div className="nx-list-scroll">
          {only ? (
            <ServerBody
              model={only.model}
              speaking={only.speaking}
              onOpenRoom={only.onOpenRoom}
              onOpenDm={only.onOpenDm}
              onOpenPerson={only.onOpenPerson}
              showing={only.showing}
              onMessage={only.onMessage}
              onKnock={only.onKnock}
              safetyFor={only.safetyFor}
              onReports={only.onReports}
              onStartDm={only.onStartDm}
              onLeaveDm={only.onLeaveDm}
              onHost={only.onHost}
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

  return (
    <div className="nx-list" data-screen="list" data-servers="several" data-rock={rocking}>
      <TitleBar leading={LOGO} actions={gear} onMinimize={minimize} onClose={onClose}>
        Linger
      </TitleBar>

      {me ? <YouEverywhere me={me} servers={servers} actions={everywhere} nudge={nudge} /> : null}

      <div className="nx-list-scroll">
        {servers.map((listing, index) => (
          <ServerSection
            key={listing.id}
            listing={listing}
            index={index}
            folded={isFolded(listing.id)}
            first={index === 0}
            last={index === servers.length - 1}
            onToggle={toggle}
            onQuiet={onQuiet}
            onMove={onMove}
            onProfile={onProfileOn}
            topName={me?.display_name ?? null}
          />
        ))}
        {blocked.map((listing) => (
          <BlockedSection key={listing.id} listing={listing} />
        ))}
      </div>

      {bottom}
    </div>
  );
}
