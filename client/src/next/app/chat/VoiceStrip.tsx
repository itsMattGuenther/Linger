import { type MouseEvent, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "../../../generated/User";
import { startProblemWords, type StartProblem, volumeLabel } from "../../../lib/voice";
import { QUIET_MOVE_WORDS, stripFit, VOICE_ACTION_WORDS, type StripFit, type StripMeasure, type VoiceStrip as Strip } from "../../core/chat/voice";
import { verbFor } from "../../core/chat/words";
import { copyText } from "../../core/copy";
import { onPhone } from "../../core/phone";
import { Button, Chip, IconButton, markerOf, Name, Popover, VoiceGlyph } from "../../kit";
import { useTalkSeats } from "../useTalkSeats";
import { ShareButton, type ShareControl } from "../screen/ShareButton";
import { EveryoneCard } from "../list/EveryoneCard";
import type { VoiceDockPerson } from "../list/VoiceDock";
import { VolumeCard } from "../list/VolumeCard";
import "./VoiceStrip.css";

/**
 * How long after Join or Leave a click on the strip doesn't count (#510).
 * Each redraws the buttons under the pointer, Deafen where Join was and
 * Join where Leave was, so a quick second click would press a button that
 * wasn't there when it began: in voice deafened, or straight back in.
 */
const SWAP_MS = 400;

/**
 * A conversation's voice, in one line under its header (docs/design/
 * buddy-list.md, "Voice belongs to the room"). It says who's talking here
 * and offers one way in. In the room you're in voice in, it has your controls
 * too (#216): mute, deafen and leave, as symbols, the same ones as the list's
 * voice bar, which stays. It is one height in every state, so a change in
 * voice never moves the conversation (VOICE-17).
 */

/** Your voice controls, in the room you're in voice in (#216). The list window acts on them. */
export interface StripControls {
  /** You muted yourself: with push-to-talk too, which the key can't undo (#232). */
  muted: boolean;
  deafened: boolean;
  onMute: (muted: boolean) => void;
  onDeafen: (deafened: boolean) => void;
  onLeave: () => void;
}

/** The shares in this conversation's voice, and Watch (SPEC §4.20, #360). */
export interface StripWatch {
  /** Who shares here, not you: their session, and them. */
  sharers: readonly { session: string; user: User }[];
  /** The share this window shows, if one. */
  watching: string | null;
  /** Watch one: joins voice here first when you aren't in it. */
  onWatch: (session: string) => void;
}

/**
 * Each person's volume, from their chip, in the room you're in voice in
 * (#747): the voice bar's card, under the chip. The list window runs voice
 * and acts on it.
 */
export interface StripVolume {
  /** "#general", or a DM's people: the everyone card says where. */
  where: string;
  /** How loud each person plays for you, 0 to 2, by user id; 1 when it isn't here. */
  of: ReadonlyMap<string, number>;
  onVolume: (id: string, volume: number) => void;
  /** The host or a co-host taking somebody out of voice (#423, #424); never offered on the host's chip. */
  onTakeOut?: (id: string) => Promise<string | null>;
}

/** Why the last start here failed, as the strip says it, and the shell's whole reason (#261, #273). */
export type StripProblem = StartProblem & { detail: string };

export const VoiceStrip = memo(function VoiceStrip({
  strip,
  people,
  meId,
  speaking,
  mics,
  onJoin,
  onPickDevice,
  controls,
  failed,
  takenOut,
  sharing,
  watch,
  share,
  volume,
}: {
  strip: Strip;
  /** Everyone the strip names, by id. */
  people: ReadonlyMap<string, User>;
  /** You, shown as "you". */
  meId: string | null;
  /** Who is talking right now (only known while you are in voice). */
  speaking: ReadonlySet<string>;
  /** Whose microphone is off, as shared (VOICE-6), by user id. */
  mics?: ReadonlyMap<string, "muted" | "deafened">;
  /** Join, move here, or start: the window knows which from `strip`. */
  onJoin: () => void;
  /** Open Settings on Sound & Voice, where a device is picked by name (#273). */
  onPickDevice: () => void;
  /** Yours, when you're in voice here. */
  controls?: StripControls;
  /**
   * The last try at starting voice here failed (#261). It takes the words'
   * place, on the same one line, so the strip keeps its height (VOICE-17).
   * The whole of it, and the shell's reason, are the tooltip, and a click
   * opens them in a card that stays, with Copy for sending them to the host
   * (#399). The button stays, to try again. When picking a device fixes it,
   * that's a button too, which opens Settings there and is never cut off: on
   * a narrow window the words give way first (#273).
   */
  failed?: StripProblem;
  /**
   * The host or a co-host took you out of voice here (#423, #424): said where the strip's words
   * go, until you join again. Join stays, since it isn't a ban.
   */
  takenOut?: boolean;
  /** Who's sharing their screen here, by user id (#360): the mark on their chip. */
  sharing?: ReadonlySet<string>;
  /** Watch, for each share here you aren't watching (#360). */
  watch?: StripWatch;
  /** Share your screen, beside your controls, when you're in voice here (#360). */
  share?: ShareControl;
  /**
   * Each person's volume from their chip (#747). Only in the room you're in
   * voice in: anywhere else the chips are plain, since there's nobody to set
   * a volume for until you join.
   */
  volume?: StripVolume;
}) {
  const showFailed = failed && strip.kind !== "mine" ? failed : undefined;
  const showTakenOut = takenOut === true && strip.kind !== "mine" && !showFailed;
  const [why, setWhy] = useState<DOMRect | null>(null);
  // Whose volume is open (#747), or everyone's, from "and others", and what
  // opened it, for the card to sit under and the keyboard to go back to.
  const [volumeOf, setVolumeOf] = useState<string | null>(null);
  const [everyone, setEveryone] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  // The level last set from the open card. A conversation in a window of its
  // own hears the list window's answer a moment later; until then the card
  // shows what was set, so the next step goes on from there, not back. Once
  // the answer for that step comes, the shared level shows again, so a change
  // made somewhere else shows here too; an answer to an older step doesn't.
  const [setTo, setSetTo] = useState<{ id: string; volume: number } | null>(null);
  // A double-click on the strip is one click, and for a moment after Join
  // or Leave redraws the buttons a click doesn't count (#510): it was meant
  // for the button that was there. Whoever double-clicks everything joins
  // once, unmuted and undeafened, and Mute pressed that way mutes.
  const swappedAt = useRef(Number.NEGATIVE_INFINITY);
  const press = (act: () => void, swaps: boolean) => (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 1 || event.timeStamp - swappedAt.current < SWAP_MS) return;
    if (swaps) swappedAt.current = event.timeStamp;
    act();
  };
  // Who's in voice here, and as many of them as fit the line (#745).
  const ids = strip.kind === "mine" || strip.kind === "others" ? strip.people : NOBODY;
  const here = ids.flatMap((id) => people.get(id) ?? []);
  const you = strip.kind === "mine" && meId !== null && ids.includes(meId) ? meId : null;
  // Volumes, in the room you're in voice in (#747). Somebody who left voice
  // has nothing to set, and leaving it yourself closes the cards: they don't
  // come back open when you join again.
  const volumes = strip.kind === "mine" ? volume : undefined;
  const heard = volumes ? here.filter((user) => user.id !== meId) : NO_USERS;
  const openOf = volumeOf === null ? undefined : heard.find((user) => user.id === volumeOf);
  const everyoneOpen = everyone && volumes !== undefined;
  const shared = openOf ? (volume?.of.get(openOf.id) ?? 1) : null;
  useEffect(() => {
    if (volumeOf !== null && !openOf) setVolumeOf(null);
    if (everyone && !everyoneOpen) setEveryone(false);
  }, [volumeOf, openOf, everyone, everyoneOpen]);
  useEffect(() => {
    if (setTo === null) return;
    if (setTo.id !== volumeOf || (shared !== null && Math.abs(shared - setTo.volume) < 0.001)) setSetTo(null);
  }, [setTo, volumeOf, shared]);
  const words = stripWords(strip.kind, here.length, showFailed, showTakenOut);
  const { fit, measuring, list, line, ruler } = useStripFit(here, you, words, mics, sharing);
  // A room too big for its chips, that you're in (#197): you first, then
  // whoever just talked, kept still (core/seats.ts). Who's talking is known
  // only in the room you're in; elsewhere the pane's order stands, with the
  // people you talk to first.
  const others = strip.kind === "mine" ? strip.people.filter((id) => id !== meId) : [];
  const talkingKey = others.filter((id) => speaking.has(id)).join("\n");
  const talkingHere = useMemo(() => new Set(talkingKey === "" ? [] : talkingKey.split("\n")), [talkingKey]);
  const seats = useTalkSeats(others, talkingHere, fit.kind === "seats" ? fit.seats : 0);
  const takenOutWords = showTakenOut ? (
    <p ref={line} className="nx-strip-words" role="status">
      {TAKEN_OUT}
    </p>
  ) : null;
  const lead = showFailed ? `Couldn't start voice. ${startProblemWords(showFailed)}` : "";
  const problem = showFailed ? (
    <p ref={line} className="nx-strip-words" data-problem="yes" role="alert" title={`${lead}\n${showFailed.detail}`}>
      <button
        type="button"
        className="nx-strip-why-open"
        aria-haspopup="dialog"
        aria-expanded={why !== null}
        onClick={(event) => setWhy(event.currentTarget.getBoundingClientRect())}
      >
        {words.all}
      </button>
      {why ? <WhyCard anchor={why} lead={lead} detail={showFailed.detail} onClose={() => setWhy(null)} /> : null}
    </p>
  ) : null;
  const fix =
    showFailed && showFailed.fix !== null ? (
      <Button size="sm" variant="secondary" icon="gear" onClick={onPickDevice}>
        {showFailed.fix}
      </Button>
    ) : null;
  if (strip.kind === "off") {
    return (
      <div className="nx-strip" data-kind="off" role="group" aria-label="Voice in this conversation">
        <VoiceGlyph speaking={false} />
        <p className="nx-strip-words">Voice isn't set up on this server.</p>
      </div>
    );
  }
  if (strip.kind === "quiet") {
    return (
      <div className="nx-strip" data-kind="quiet" role="group" aria-label="Voice in this conversation">
        <VoiceGlyph speaking={false} />
        {problem ?? takenOutWords ?? <p className="nx-strip-words">Nobody's talking in here.</p>}
        {fix}
        <Button size="sm" variant="secondary" icon="mic" onClick={press(onJoin, true)}>
          {strip.action === "move" ? QUIET_MOVE_WORDS : VOICE_ACTION_WORDS[strip.action]}
        </Button>
      </div>
    );
  }

  // While measuring, everybody, at their own widths; then as many as fit.
  const shown =
    measuring || fit.kind === "all"
      ? here
      : fit.kind === "first"
        ? here.slice(0, fit.count)
        : [you ?? "", ...seats].flatMap((id) => people.get(id) ?? []);
  const talking = here.some((user) => speaking.has(user.id));
  // A share you aren't watching has its Watch lit in the lamp (Matt, #746),
  // and Join steps down beside it: Watch joins voice too, and two lit
  // buttons side by side would say neither.
  const unwatched = watch ? watch.sharers.filter((one) => one.session !== watch.watching) : [];
  return (
    <div className="nx-strip" data-kind={strip.kind} role="group" aria-label="Voice in this conversation">
      <VoiceGlyph speaking={talking} mine={strip.kind === "mine"} />
      <ul ref={list} className="nx-strip-people" data-measuring={measuring ? "yes" : undefined} aria-label="In voice here">
        {shown.map((user) => (
          <li key={user.id} data-user={user.id}>
            <Chip
              label={user.id === meId ? "you" : user.display_name}
              marker={markerOf(user, "in_room")}
              active={speaking.has(user.id)}
              sharing={sharing?.has(user.id)}
              state={micState(mics?.get(user.id))}
              {...(volumes && user.id !== meId
                ? {
                    actionLabel: `${user.display_name}'s volume, ${volumeLabel(volumes.of.get(user.id) ?? 1)}`,
                    expanded: volumeOf === user.id,
                    onActivate: (event: MouseEvent<HTMLButtonElement>) => {
                      setEveryone(false);
                      if (volumeOf === user.id) {
                        setVolumeOf(null);
                        return;
                      }
                      opener.current = event.currentTarget;
                      setVolumeOf(user.id);
                    },
                  }
                : {})}
            >
              {user.id === meId ? "you" : <Name person={user} size="control" />}
            </Chip>
          </li>
        ))}
      </ul>
      {problem ?? takenOutWords ?? (
        <p ref={line} className="nx-strip-words">
          {/* "and others" opens everyone by name, as the voice bar's crowd does (#197). */}
          {volumes && here.length > shown.length && !measuring ? (
            <button
              type="button"
              className="nx-strip-others"
              aria-haspopup="dialog"
              aria-expanded={everyone}
              onClick={(event) => {
                setVolumeOf(null);
                opener.current = event.currentTarget;
                setEveryone((open) => !open);
              }}
            >
              {words.some}
            </button>
          ) : here.length > shown.length ? (
            words.some
          ) : (
            words.all
          )}
        </p>
      )}
      {volumes && openOf ? (
        <VolumeCard
          // Each person's own card: its focus, and nothing left from the last one's.
          key={openOf.id}
          user={openOf}
          volume={setTo?.id === openOf.id ? setTo.volume : (volumes.of.get(openOf.id) ?? 1)}
          anchor={opener}
          side="below"
          sheet={onPhone()}
          onVolume={(level) => {
            setSetTo({ id: openOf.id, volume: level });
            volumes.onVolume(openOf.id, level);
          }}
          // Never on the host's chip (#424): a co-host can't take the host out.
          {...(volumes.onTakeOut && !openOf.is_host ? { onTakeOut: takeOutOf(volumes.onTakeOut, openOf.id) } : {})}
          onClose={() => {
            setVolumeOf(null);
            opener.current?.focus();
          }}
        />
      ) : null}
      {volumes && everyoneOpen ? (
        <EveryoneCard
          people={heard.map((user): VoiceDockPerson => ({ user, speaking: speaking.has(user.id), you: false, controls: mics?.get(user.id) ?? null, volume: volumes.of.get(user.id) ?? 1 }))}
          where={volumes.where}
          anchor={opener}
          side="below"
          sheet={onPhone()}
          onPick={(person) => {
            setEveryone(false);
            setVolumeOf(person.user.id);
          }}
          onClose={() => {
            setEveryone(false);
            opener.current?.focus();
          }}
        />
      ) : null}
      {fix}
      {watch
        ? unwatched.map((one) => (
            <Button
              key={one.session}
              size="sm"
              variant="primary"
              icon="screen"
              onClick={press(() => watch.onWatch(one.session), strip.kind !== "mine")}
            >
              {watch.sharers.length > 1 ? `Watch ${one.user.display_name}` : "Watch"}
            </Button>
          ))
        : null}
      {strip.kind === "mine" && controls ? (
        <YourControls
          share={share}
          muted={controls.muted}
          deafened={controls.deafened}
          onMute={press(() => controls.onMute(!controls.muted), false)}
          onDeafen={press(() => controls.onDeafen(!controls.deafened), false)}
          onLeave={press(controls.onLeave, true)}
        />
      ) : strip.kind === "mine" ? (
        <span className="nx-strip-here">You're in voice here</span>
      ) : (
        <Button size="sm" variant={strip.action === "join" && unwatched.length === 0 ? "primary" : "secondary"} icon="mic" onClick={press(onJoin, true)}>
          {VOICE_ACTION_WORDS[strip.action]}
        </Button>
      )}
      {measuring ? (
        <span ref={ruler} className="nx-strip-ruler" aria-hidden="true">
          <span>{words.some}</span>
          <span>{words.all}</span>
        </span>
      ) : null}
    </div>
  );
});

const NOBODY: readonly string[] = [];
const NO_USERS: readonly User[] = [];

function takeOutOf(takeOut: (id: string) => Promise<string | null>, id: string): () => Promise<string | null> {
  return () => takeOut(id);
}
const TAKEN_OUT = "You were taken out of voice.";
const EVERYBODY: StripFit = { kind: "all" };

/** The words after the chips, said with "and others" (`some`) and without (`all`). */
interface StripWords {
  some: string;
  all: string;
}

/**
 * What the strip says after its chips (#745): "and others", then who's
 * talking when it isn't your room. A failed start or being taken out of
 * voice says that instead, the same either way.
 */
function stripWords(kind: Strip["kind"], count: number, failed: StripProblem | undefined, takenOut: boolean): StripWords {
  if (failed) {
    const said = `Couldn't start voice. ${failed.line}`;
    return { some: said, all: said };
  }
  if (takenOut) return { some: TAKEN_OUT, all: TAKEN_OUT };
  const talking = kind === "others" ? `${verbFor(count, "is", "are")} talking` : "";
  return { some: talking === "" ? "and others" : `and others ${talking}`, all: talking };
}

/** The width the chips and the words after them share: the line, less what's on it for good. */
function room(list: Element, words: Element): number {
  return list.getBoundingClientRect().width + words.getBoundingClientRect().width;
}

/**
 * A chip on the line is no longer the width it was measured at. Only while
 * none is squeezed: on a line that has just narrowed they shrink before the
 * recount, and that isn't a change in the chips.
 */
function drifted(list: Element, measure: StripMeasure): boolean {
  if (list.scrollWidth > list.clientWidth + 1) return false;
  return [...list.children].some((chip) => {
    const was = measure.chips.find((one) => one.id === (chip as HTMLElement).dataset.user);
    return was !== undefined && Math.abs(chip.getBoundingClientRect().width - was.width) > 0.5;
  });
}

/** Watch the chips on the line now, and stop watching any that have gone. */
function watchEach({ watch, chips, each }: { watch: ResizeObserver; chips: Element; each: Set<Element> }): void {
  for (const chip of chips.children) {
    if (each.has(chip)) continue;
    watch.observe(chip);
    each.add(chip);
  }
  for (const chip of each) {
    if (chip.parentElement === chips) continue;
    watch.unobserve(chip);
    each.delete(chip);
  }
}

function sameFit(a: StripFit, b: StripFit): boolean {
  return a.kind === b.kind && (a.kind !== "first" || b.kind !== "first" || a.count === b.count) && (a.kind !== "seats" || b.kind !== "seats" || a.seats === b.seats);
}

/**
 * How many of the strip's people fit its line (#745), measured rather than
 * guessed, since names come in every face, weight and length. When who's
 * here changes, or how any of them looks, or a font arrives, one draw puts
 * everybody on the line at their own width (`measuring`, which CSS keeps
 * from shrinking them). Before that's ever painted their widths are read,
 * and the strip draws as many as fit (core/chat/voice.ts `stripFit`). A
 * wider or narrower window, or a button coming or going on the line,
 * recounts from those widths without drawing everybody again. A chip that
 * has since changed width (a face that arrived late, which WebKit doesn't
 * always say) has everybody measured again.
 */
function useStripFit(here: readonly User[], you: string | null, words: StripWords, mics: ReadonlyMap<string, "muted" | "deafened"> | undefined, sharing: ReadonlySet<string> | undefined) {
  const list = useRef<HTMLUListElement>(null);
  const line = useRef<HTMLParagraphElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  // A face that arrives after the widths were read changes them.
  const [again, setAgain] = useState(0);
  useEffect(() => {
    const faces = typeof document === "undefined" ? undefined : document.fonts;
    if (!faces) return;
    const measureAgain = () => setAgain((count) => count + 1);
    faces.addEventListener("loadingdone", measureAgain);
    return () => faces.removeEventListener("loadingdone", measureAgain);
  }, []);
  const key = [again, you ?? "", words.some, words.all, ...here.map((user) => `${JSON.stringify(user)} ${mics?.get(user.id) ?? ""} ${sharing?.has(user.id) ? "sharing" : ""}`)].join("\n");
  const [fitted, setFitted] = useState<{ key: string; measure: StripMeasure; fit: StripFit } | null>(null);
  const current = useRef(fitted);
  current.current = fitted;
  const measuring = here.length > 0 && fitted?.key !== key;
  useLayoutEffect(() => {
    if (!measuring) return;
    const chips = list.current;
    const said = line.current;
    const sizes = ruler.current;
    if (!chips || !said || !sizes) return;
    const widths = [...chips.children].map((chip, at) => ({ id: here[at]?.id ?? "", width: chip.getBoundingClientRect().width }));
    const [some = 0, all = 0] = [...sizes.children].map((words) => words.getBoundingClientRect().width);
    const measure: StripMeasure = { chips: widths, gap: parseFloat(getComputedStyle(chips).columnGap) || 0, words: { some, all }, you };
    setFitted({ key, measure, fit: stripFit(measure, room(chips, said)) });
  });
  // Recount whenever the line's room changes. The list and the words are
  // watched, not the strip: a button coming or going on the line changes
  // their room without changing the strip's width. Each chip is watched too:
  // a face that arrives after a full line was measured changes the chips'
  // widths and not the line's, and WebKit doesn't always say it arrived
  // (#747's repeated runs found the strip left squeezed that way).
  const watched = useRef<{ watch: ResizeObserver; chips: Element; said: Element; each: Set<Element> } | null>(null);
  useEffect(() => {
    const chips = list.current;
    const said = line.current;
    const now = watched.current;
    if (now && now.chips === chips && now.said === said) {
      watchEach(now);
      return;
    }
    now?.watch.disconnect();
    watched.current = null;
    if (!chips || !said || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      const was = current.current;
      if (!was) return;
      if (drifted(chips, was.measure)) {
        setAgain((count) => count + 1);
        return;
      }
      const fit = stripFit(was.measure, room(chips, said));
      if (!sameFit(fit, was.fit)) setFitted({ ...was, fit });
    });
    watch.observe(chips);
    watch.observe(said);
    watched.current = { watch, chips, said, each: new Set() };
    watchEach(watched.current);
  });
  useEffect(
    () => () => {
      watched.current?.watch.disconnect();
      watched.current = null;
    },
    [],
  );
  return { fit: fitted?.fit ?? EVERYBODY, measuring, list, line, ruler };
}

/**
 * Mute, Deafen and Leave, as symbols: each word is the button's name and
 * tooltip (#230). On the phone they're a thumb's size (#429).
 */
function YourControls({ muted, deafened, onMute, onDeafen, onLeave, share }: { muted: boolean; deafened: boolean; onMute: (event: MouseEvent<HTMLButtonElement>) => void; onDeafen: (event: MouseEvent<HTMLButtonElement>) => void; onLeave: (event: MouseEvent<HTMLButtonElement>) => void; share?: ShareControl }) {
  const size = onPhone() ? "lg" : "sm";
  return (
    <div className="nx-strip-controls" role="group" aria-label="Your voice">
      <IconButton icon={muted ? "micOff" : "mic"} label={muted ? "Muted" : "Mute"} size={size} pressed={muted} onClick={onMute} />
      <IconButton icon={deafened ? "headOff" : "head"} label={deafened ? "Deafened" : "Deafen"} size={size} pressed={deafened} onClick={onDeafen} />
      {share ? <ShareButton control={share} size={size} /> : null}
      <IconButton icon="leave" label="Leave voice" size={size} onClick={onLeave} />
    </div>
  );
}

/** Voice you're in somewhere else, on the phone (#429): where, and your controls. */
export interface InVoice {
  /** "#general", or a DM's people. */
  where: string;
  /** Somebody in your call is talking. */
  talking: boolean;
  muted: boolean;
  deafened: boolean;
  onGo: () => void;
  onMute: (muted: boolean) => void;
  onDeafen: (deafened: boolean) => void;
  onLeave: () => void;
}

/**
 * Your voice, on every other screen of the phone (#429). A conversation, Media
 * or Search covers the list there, and with it the voice bar, so this line
 * takes the voice line's place under the title: an open microphone is never
 * out of sight. Its words go back to the room you're in voice in. In another
 * room it stands in for that room's own line, so the phone never offers to
 * move voice here: leave, then join.
 */
export const InVoiceLine = memo(function InVoiceLine({ voice }: { voice: InVoice }) {
  return (
    <div className="nx-strip" data-kind="mine" role="group" aria-label="Your voice call">
      <VoiceGlyph speaking={voice.talking} mine />
      <button type="button" className="nx-strip-where" onClick={voice.onGo}>
        {voice.where.startsWith("#") ? "In voice in " : "In voice with "}
        <b>{voice.where}</b>
      </button>
      <YourControls
        muted={voice.muted}
        deafened={voice.deafened}
        onMute={() => voice.onMute(!voice.muted)}
        onDeafen={() => voice.onDeafen(!voice.deafened)}
        onLeave={voice.onLeave}
      />
    </div>
  );
});

/** A microphone that's off, as its control's glyph and word. */
function micState(off: "muted" | "deafened" | undefined): { icon: "micOff" | "headOff"; word: string } | undefined {
  if (off === "deafened") return { icon: "headOff", word: "Deafened" };
  if (off === "muted") return { icon: "micOff", word: "Muted" };
  return undefined;
}

/** Space kept between the card, the strip and the window's edges. */
const GAP = 4;
const EDGE = 8;

/**
 * Why voice didn't start, whole (#399): Linger's sentence and the shell's
 * own words, which say what actually failed, in a card that stays until it's
 * closed. Its words can be selected, and Copy takes both, ready to send the
 * host. It sits under the strip's words, or over them if there's no room
 * below, and never off the window.
 */
function WhyCard({ anchor, lead, detail, onClose }: { anchor: DOMRect; lead: string; detail: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ x: EDGE, y: anchor.bottom + GAP });
  const [copied, setCopied] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const card = box.current?.parentElement;
    if (!card) return;
    const { offsetWidth: width, offsetHeight: height } = card;
    const below = anchor.bottom + GAP;
    const y = below + height <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - GAP - height);
    const x = Math.max(EDGE, Math.min(Math.round(anchor.left), window.innerWidth - width - EDGE));
    setAt((held) => (held.x === x && held.y === y ? held : { x, y }));
  }, [anchor.top, anchor.bottom, anchor.left]);
  // Copy has the focus to start with; a press anywhere else closes it.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("[data-copy] button")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.parentElement?.contains(event.target)) return;
      close.current();
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, []);
  return createPortal(
    <Popover label="Why voice didn't start" at={at} onClose={onClose}>
      <div ref={box} className="nx-strip-why">
        <p className="nx-strip-why-lead">{lead}</p>
        <p className="nx-strip-why-detail">{detail}</p>
        <div className="nx-strip-why-buttons">
          <span data-copy="">
            <Button size="sm" variant="secondary" onClick={() => void copyText(`${lead}\n${detail}`).then(setCopied)}>
              {copied === true ? "Copied" : "Copy"}
            </Button>
          </span>
        </div>
        {copied === false ? (
          <p className="nx-strip-why-said" role="status">
            The clipboard wouldn't take it. Select the words above and copy them instead.
          </p>
        ) : null}
      </div>
    </Popover>,
    document.body,
  );
}
