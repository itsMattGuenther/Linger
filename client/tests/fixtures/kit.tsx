/**
 * The kit gallery: every component in every state and size, on one page.
 *
 * It is the living style guide (open it with `pnpm exec vite` and visit
 * /tests/fixtures/kit.html) and the surface `tests/browser/kit.spec.ts`
 * measures. Add every new component and state here.
 */
import { type ReactNode, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { User } from "../../src/generated/User";
import type { Fill } from "../../src/generated/Fill";
import type { NameEffect } from "../../src/generated/NameEffect";
import { FONT_KEYS, FONT_LABELS, type FontKey } from "../../src/lib/fonts";
import { PALETTE_KEYS } from "../../src/lib/palette";
import {
  Button,
  Card,
  ChoiceCards,
  Chip,
  GroupMarker,
  HashMark,
  Icon,
  IconButton,
  ICON_NAMES,
  Marker,
  MarkerCluster,
  MarkerSlot,
  Menu,
  Name,
  Notice,
  Popover,
  Row,
  RowList,
  SectionLabel,
  SettingRow,
  Swatch,
  Switch,
  TabStrip,
  TextField,
  TitleBar,
  VoiceGlyph,
  type MarkerState,
  type MenuAnchor,
  type TabItem,
} from "../../src/next/kit";
import "../../src/next/styles/app.css";
import "./kit.css";

let seq = 0;
function person(
  name: string,
  font: FontKey,
  fill: Fill,
  opts: { weight?: 400 | 500 | 700; italic?: boolean; effect?: NameEffect; line?: string; away?: string } = {},
): User {
  seq += 1;
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}` as User["id"],
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    style: {
      font_key: font,
      weight: opts.weight ?? 500,
      italic: opts.italic ?? false,
      fill,
      effect: opts.effect ?? "none",
      msg_font_key: null,
    },
    status: {
      line: opts.line ?? null,
      reading: null,
      listening: null,
      working_on: null,
      image_id: null,
      image_url: null,
      away_message: opts.away ?? null,
      away_since: null,
    },
    entrance_sound: null,
    last_seen_at: null,
  };
}

const solid = (color: string): Fill => ({ kind: "solid", color });
const blend = (from: string, to: string): Fill => ({ kind: "gradient", from, to });

const STATES: MarkerState[] = ["here", "around", "idle", "away", "offline"];

/** Twelve people, one per face, so rows are measured in every face. */
const FACES = FONT_KEYS.map((font, index) => {
  const color = PALETTE_KEYS[index % PALETTE_KEYS.length] ?? "slate";
  const fill = index % 4 === 1 ? blend(color, PALETTE_KEYS[(index + 5) % PALETTE_KEYS.length] ?? "slate") : solid(color);
  const state = STATES[index % STATES.length] ?? "here";
  return {
    user: person(FONT_LABELS[font].split(" ")[0] ?? font, font, fill, {
      italic: font === "instrument-serif" || font === "newsreader",
      weight: index % 3 === 0 ? 700 : 500,
      effect: index === 2 ? "shimmer" : index === 7 ? "glow" : "none",
      line: index === 4 ? "a status long enough that it has to end in an ellipsis in a list this narrow" : "second coffee, no regrets",
      away: state === "away" ? "back after work" : undefined,
    }),
    color,
    state,
  };
});

const eli = person("Eli", "space-grotesk", solid("amber"), { weight: 700, line: "second coffee, no regrets" });
const jules = person("Jules", "instrument-serif", blend("fern", "teal"), { italic: true, line: "speakers: finally set up" });
const dave = person("Dave", "jetbrains-mono", solid("cyan"), { line: "side two. nobody talk to me" });
const callie = person("Callie", "newsreader", blend("violet", "orchid"), { italic: true, weight: 700 });
const sam = person("Sam", "silkscreen", solid("rose"), { away: "back after work" });
const longName = person("Bartholomew-Maximilian the Considerably Long", "inter", solid("sky"));

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="g-section" data-section={id} aria-labelledby={`g-${id}`}>
      <h2 id={`g-${id}`}>{title}</h2>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="g-label">{children}</span>;
}

const ROOM = { kind: "room" } as const;

/** Tabs from two servers: a stripe in each server's color says which is which. */
function StripedTabs() {
  const tabs: TabItem[] = [
    { id: "good-general", title: "general", lead: ROOM, label: "#general, The Good Company", stripe: "amber" },
    { id: "raid-lobby", title: "lobby", lead: ROOM, label: "#lobby, Raid Night", stripe: "violet", voice: "others" },
    { id: "good-plans", title: "weekend-plans", lead: ROOM, label: "#weekend-plans, The Good Company", stripe: "amber", fresh: true },
  ];
  const [active, setActive] = useState("good-general");
  return (
    <div className="g-window">
      <TitleBar onClose={() => {}}>
        <TabStrip label="Tabs from two servers" tabs={tabs} activeId={active} onSelect={setActive} />
      </TitleBar>
      <div className="g-window-body">Two servers: the stripe along each tab's top is its server's color.</div>
    </div>
  );
}

/** A message's actions, with the confirm step a delete has. */
function MenuDemo() {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [chose, setChose] = useState("nothing yet");
  const close = () => {
    setAnchor(null);
    setConfirming(false);
  };
  return (
    <div className="g-row">
      <span data-testid="menu-trigger">
        <IconButton
          icon="more"
          label="Actions for Eli's message"
          expanded={anchor !== null}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setAnchor((open) => (open ? null : { top: box.top, left: box.left, right: box.right, bottom: box.bottom }));
          }}
        />
      </span>
      <span className="g-label" data-testid="menu-chose">
        {chose}
      </span>
      {anchor ? (
        <Menu
          label="Actions for Eli's message"
          anchor={anchor}
          items={
            confirming
              ? [
                  { id: "delete-for-good", label: "Delete for good", icon: "close", tone: "danger", onSelect: () => {
                      setChose("deleted");
                      close();
                    } },
                  { id: "keep", label: "Keep it", icon: "check", onSelect: close },
                ]
              : [
                  { id: "reply", label: "Reply", icon: "message", onSelect: () => {
                      setChose("reply");
                      close();
                    } },
                  { id: "edit", label: "Edit", icon: "pencil", onSelect: () => {
                      setChose("edit");
                      close();
                    } },
                  { id: "delete", label: "Delete", icon: "close", tone: "danger", onSelect: () => setConfirming(true) },
                ]
          }
          onClose={(reason) => {
            close();
            if (reason === "escape" || reason === "tab") document.querySelector<HTMLElement>("[data-testid='menu-trigger'] button")?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function Tabs() {
  const [tabs, setTabs] = useState<TabItem[]>([
    { id: "general", title: "general", lead: ROOM, label: "#general", voice: "mine", speaking: true, closable: true },
    { id: "listening", title: "listening-room", lead: ROOM, label: "#listening-room", closable: true },
    { id: "jules", title: "Jules", lead: { kind: "person", person: { color: "fern", state: "here" } }, label: "DM with Jules", fresh: true, closable: true },
    { id: "weekend", title: "weekend-plans", lead: ROOM, label: "#weekend-plans", fresh: true, closable: true },
    { id: "raid", title: "raid-night", lead: ROOM, label: "#raid-night", voice: "others", closable: true },
    { id: "long", title: "a-room-with-a-name-that-goes-on-and-on", lead: ROOM, label: "#a-room-with-a-name-that-goes-on-and-on", closable: true },
    { id: "geral", title: "geral", lead: ROOM, label: "#geral", closable: true },
    { id: "fotos", title: "fotos", lead: ROOM, label: "#fotos", closable: true },
  ]);
  const [active, setActive] = useState("listening");
  return (
    <div className="g-window" data-testid="tabbed-window">
      <TitleBar actions={<IconButton icon="gear" label="Settings" />} onClose={() => {}}>
        <TabStrip
          label="Conversations"
          tabs={tabs}
          activeId={active}
          onSelect={setActive}
          onClose={(id) => setTabs((all) => all.filter((tab) => tab.id !== id))}
          onMove={(id, to) =>
            setTabs((all) => {
              const moving = all.find((tab) => tab.id === id);
              if (!moving) return all;
              const rest = all.filter((tab) => tab.id !== id);
              return [...rest.slice(0, to), moving, ...rest.slice(to)];
            })
          }
        />
      </TitleBar>
      <div className="g-window-body">The showing tab: {active}</div>
    </div>
  );
}

function Gallery() {
  const [switches, setSwitches] = useState({ quiet: true, door: false, plain: false });
  const [mode, setMode] = useState<"tabs" | "windows">("tabs");
  const [field, setField] = useState("");
  const [status, setStatus] = useState("fixing the porch light (the real one)");
  const [open, setOpen] = useState({ offline: false, away: true, rooms: true });
  const [swatch, setSwatch] = useState<string>("azure");
  const [picked, setPicked] = useState([eli, jules, longName]);

  return (
    <main className="g-page">
      <header>
        <h1>Linger kit</h1>
        <p>Every piece of the Buddy list client, in every state. docs/design/system.md explains the rules.</p>
      </header>

      <Section id="icons" title="Icons">
        <div className="g-icons">
          {ICON_NAMES.map((name) => (
            <span key={name} className="g-icon">
              <Icon name={name} size="sm" />
              <Icon name={name} size="md" />
              <Icon name={name} size="lg" />
              {name}
            </span>
          ))}
        </div>
      </Section>

      <Section id="buttons" title="Buttons">
        {(["primary", "secondary", "quiet", "danger"] as const).map((variant) => (
          <div className="g-row" key={variant}>
            <Label>{variant}</Label>
            <Button variant={variant} size="sm" icon="message">
              Message
            </Button>
            <Button variant={variant} size="md" icon="knock">
              Knock
            </Button>
            <Button variant={variant} size="lg">
              Save your look
            </Button>
            <Button variant={variant} disabled>
              Disabled
            </Button>
            <Button variant={variant} busy>
              Saving
            </Button>
          </div>
        ))}
        <div className="g-row">
          <Label>pressed</Label>
          <Button pressed>Newsreader</Button>
          <Button pressed={false}>Inter</Button>
          <Button size="sm" pressed>
            bold
          </Button>
        </div>
        <div className="g-row">
          <Label>fill, long</Label>
          <span className="g-narrow">
            <Button variant="primary" fill icon="message">
              A label much too long for its narrow column
            </Button>
          </span>
        </div>
      </Section>

      <Section id="icon-buttons" title="Icon buttons">
        {(["plain", "filled", "accent", "danger"] as const).map((tone) => (
          <div className="g-row" key={tone}>
            <Label>{tone}</Label>
            <IconButton icon="close" label="Close" size="sm" tone={tone} />
            <IconButton icon="gear" label="Settings" size="md" tone={tone} />
            <IconButton icon="send" label="Send" size="lg" tone={tone} shortcut="Enter" />
            <IconButton icon="knock" label="Knock" tone={tone} disabled />
          </div>
        ))}
        <div className="g-row">
          <Label>pressed</Label>
          <IconButton icon="mic" label="Mute" pressed />
          <IconButton icon="compose" label="New message" size="sm" />
        </div>
      </Section>

      <Section id="markers" title="Markers">
        {(["md", "sm"] as const).map((size) => (
          <div className="g-row" key={size}>
            <Label>{size}</Label>
            {STATES.map((state) => (
              <Marker key={state} color="amber" state={state} size={size} label={`Eli (${size})`} />
            ))}
            <Marker color="fern" state="here" size={size} typing label="Jules typing" />
          </div>
        ))}
        <div className="g-row">
          <Label>slot</Label>
          <MarkerSlot>
            <Marker color="azure" state="here" />
          </MarkerSlot>
          <MarkerSlot>
            <GroupMarker people={[{ color: "amber", state: "here" }, { color: "rose", state: "away" }]} />
          </MarkerSlot>
          <MarkerSlot>
            <GroupMarker people={[{ color: "amber", state: "here" }, { color: "rose", state: "away" }, { color: "cyan", state: "offline" }]} />
          </MarkerSlot>
          <MarkerSlot>
            <GroupMarker
              people={[
                { color: "amber", state: "here" },
                { color: "rose", state: "away" },
                { color: "cyan", state: "offline" },
                { color: "violet", state: "around" },
              ]}
            />
          </MarkerSlot>
          <MarkerSlot>
            <HashMark />
          </MarkerSlot>
          <MarkerCluster
            people={[
              { color: "azure", state: "here" },
              { color: "amber", state: "here" },
              { color: "fern", state: "here" },
            ]}
          />
          <VoiceGlyph speaking={false} />
          <VoiceGlyph speaking />
          <VoiceGlyph speaking={false} mine />
        </div>
      </Section>

      <Section id="names" title="Names">
        <div className="g-columns">
          <div>
            {FACES.map(({ user }) => (
              <div className="g-row" key={user.id}>
                <Name person={user} />
              </div>
            ))}
          </div>
          <div>
            <div className="g-row">
              <Name person={jules} size="display" />
            </div>
            <div className="g-row">
              <Name person={eli} size="body" />
              <Name person={callie} size="control" />
              <Name person={sam} size="meta" />
            </div>
            <div className="g-row g-narrow">
              <Name person={longName} />
            </div>
            <p className="g-row g-sentence" data-testid="inline-names">
              <span>
                Replying to <Name person={jules} size="inline" />: <Name person={eli} size="inline" /> and{" "}
                <Name person={sam} size="inline" /> are typing, inside a sentence, in its own size and line.
              </span>
            </p>
          </div>
        </div>
      </Section>

      <Section id="rows" title="Rows">
        <div className="g-columns">
          <div className="g-list" data-kit-column="">
            <SectionLabel
              label="Rooms"
              open={open.rooms}
              onToggle={() => setOpen((o) => ({ ...o, rooms: !o.rooms }))}
            />
            <RowList label="Rooms">
              <Row
                lead={{ kind: "room" }}
                lines="one"
                title="general"
                end={
                  <>
                    <VoiceGlyph speaking mine />
                    <MarkerCluster
                      people={[
                        { color: "azure", state: "here" },
                        { color: "amber", state: "here" },
                        { color: "fern", state: "here" },
                      ]}
                    />
                  </>
                }
              />
              <Row lead={{ kind: "room" }} lines="one" title="listening-room" fresh end={<MarkerCluster people={[{ color: "cyan", state: "here" }]} />} />
              <Row lead={{ kind: "room" }} lines="one" title="a-room-with-a-name-far-too-long-for-the-list" fresh />
            </RowList>
            <SectionLabel label="DMs" action={<IconButton icon="compose" label="New message" size="sm" />} />
            <RowList label="DMs">
              <Row lead={{ kind: "person", person: { color: "fern", state: "here" } }} lines="one" title="Jules" fresh />
              <Row
                lead={{ kind: "group", people: [{ color: "amber", state: "here" }, { color: "rose", state: "away" }] }}
                lines="one"
                title="Eli, Sam"
              />
              <Row
                lead={{
                  kind: "group",
                  people: [
                    { color: "amber", state: "here" },
                    { color: "rose", state: "away" },
                    { color: "cyan", state: "offline" },
                  ],
                }}
                lines="one"
                title="Eli, Sam, Dave"
              />
              <Row
                lead={{
                  kind: "group",
                  people: [
                    { color: "amber", state: "here" },
                    { color: "rose", state: "away" },
                    { color: "cyan", state: "offline" },
                    { color: "violet", state: "around" },
                  ],
                }}
                lines="one"
                title="Eli, Sam, Dave, Callie, and more people than fit"
              />
              <Row lead={{ kind: "none" }} lines="one" title="No marker at all" />
            </RowList>
            <SectionLabel label="People" />
            <RowList label="People">
              <Row
                lead={{ kind: "person", person: { color: "amber", state: "here" } }}
                lines="two"
                title={<Name person={eli} />}
                detail="second coffee, no regrets"
                note="in #general"
                trailing={<VoiceGlyph speaking />}
                actions={[<IconButton key="k" icon="knock" label="Knock on Eli" tone="filled" />, <IconButton key="m" icon="message" label="Message Eli" tone="filled" />]}
              />
              <Row
                lead={{ kind: "person", person: { color: "fern", state: "here" }, typing: true }}
                lines="two"
                title={<Name person={jules} />}
                detail="speakers: finally set up"
                note="in #general"
                trailing={<VoiceGlyph speaking={false} />}
                selected
              />
              <Row lead={{ kind: "person", person: { color: "cyan", state: "here" } }} lines="two" title={<Name person={dave} />} detail="side two. nobody talk to me" note="in #listening-room" />
              <Row lead={{ kind: "person", person: { color: "violet", state: "around" } }} lines="two" title={<Name person={callie} />} detail="" note="around" />
            </RowList>
            <SectionLabel label="Away" level="group" open={open.away} onToggle={() => setOpen((o) => ({ ...o, away: !o.away }))} />
            <RowList label="Away">
              <Row lead={{ kind: "person", person: { color: "rose", state: "away" } }} lines="two" title={<Name person={sam} />} detail="“back after work”" away note="away · 1h" />
            </RowList>
            <SectionLabel label="Offline" level="group" open={open.offline} onToggle={() => setOpen((o) => ({ ...o, offline: !o.offline }))} />
          </div>

          <div className="g-list" data-kit-column="">
            <SectionLabel label="Every face" />
            <RowList label="Every face">
              {FACES.map(({ user, color, state }) => (
                <Row
                  key={user.id}
                  lead={{ kind: "person", person: { color, state } }}
                  lines="two"
                  title={<Name person={user} />}
                  detail={user.status?.away_message ?? user.status?.line ?? ""}
                  away={state === "away"}
                  note={state}
                />
              ))}
            </RowList>
          </div>

          <div className="g-list" data-kit-column="">
            <SectionLabel label="Every face, one line" />
            <RowList label="Every face, one line">
              {FACES.map(({ user, color, state }) => (
                <Row key={user.id} lead={{ kind: "person", person: { color, state } }} lines="one" title={<Name person={user} />} />
              ))}
              <Row lead={{ kind: "person", person: { color: "sky", state: "here" } }} lines="one" title={<Name person={longName} />} note="in #general" />
            </RowList>
          </div>
        </div>
      </Section>

      <Section id="tabs" title="Tabs and title bars">
        <Tabs />
        <StripedTabs />
        <div className="g-window">
          <TitleBar leading={<Icon name="house" />} actions={<IconButton icon="gear" label="Settings" />} onClose={() => {}}>
            The Good Company
          </TitleBar>
          <div className="g-window-body">A focused window with a plain title.</div>
        </div>
        <div className="g-window">
          <TitleBar focused={false} onClose={() => {}}>
            A window that has lost focus, with a title long enough that it has to end in an ellipsis rather than run under the close button
          </TitleBar>
          <div className="g-window-body">Unfocused: the title dims.</div>
        </div>
      </Section>

      <Section id="menus" title="Menus">
        <MenuDemo />
      </Section>

      <Section id="fields" title="Fields">
        <div className="g-fields">
          <TextField label="Server" value={field} onChange={setField} placeholder="linger.example" size="sm" />
          <TextField label="Search" value={field} onChange={setField} placeholder="Search rooms and your DMs" icon="search" />
          <TextField label="Your status" value={status} onChange={setStatus} italic size="lg" hint="Everyone on this server sees it." />
          <TextField label="Invite link" value="https://linger.example/invite/7f3k" onChange={() => {}} readOnly mono />
          <TextField label="Password" value="short" onChange={() => {}} type="password" error="At least 12 characters." />
          <TextField label="Say something" hideLabel value="" onChange={() => {}} placeholder="Say something in #general" />
        </div>
      </Section>

      <Section id="settings" title="Switches and choices">
        <div className="g-settings">
          <SettingRow
            title="Quiet hours"
            description="No DM, room or knock chimes from 22:00 to 08:00."
            control={<Switch label="Quiet hours" checked={switches.quiet} onChange={(quiet) => setSwitches((s) => ({ ...s, quiet }))} />}
          />
          <SettingRow
            title="Door sounds"
            description="A very quiet chime when somebody comes in."
            control={<Switch label="Door sounds" checked={switches.door} onChange={(door) => setSwitches((s) => ({ ...s, door }))} />}
          />
          <SettingRow title="Use plain names and message fonts" control={<Switch label="Use plain names and message fonts" checked={false} disabled onChange={() => {}} />} />
          <SettingRow title="Play" description="A preview of the knock chime." control={<Button size="sm" icon="play">Play</Button>} />
        </div>
        <ChoiceCards
          legend="Conversations open"
          name="conversations"
          value={mode}
          onChange={setMode}
          choices={[
            {
              value: "tabs",
              title: "As tabs in one window",
              description: "The default, on any desktop. Pop a tab out when you want two side by side.",
              art: "intoTabs",
            },
            {
              value: "windows",
              title: "Each in its own window",
              description: "Good on a tiling desktop like Omarchy, which lays them out for you.",
              art: "windows",
            },
          ]}
          note="Voice stays on when you switch tabs or close a window."
        />
      </Section>

      <Section id="chips" title="Chips and swatches">
        <div className="g-row">
          {picked.map((user) => (
            <Chip key={user.id} label={user.display_name} marker={{ color: "amber", state: "here" }} onRemove={() => setPicked((p) => p.filter((x) => x.id !== user.id))}>
              <Name person={user} size="control" />
            </Chip>
          ))}
          <Chip label="Ashen Lanterns">Ashen Lanterns</Chip>
        </div>
        <div className="g-row g-narrow" data-testid="narrow-things">
          <Chip label="A server whose name is much too long for this">A server whose name is much too long for this</Chip>
          <Notice icon="knock">Somebody with a long name knocked, just saying hi</Notice>
          <div className="g-list">
            <SectionLabel label="A section label much too long to fit" open onToggle={() => {}} />
          </div>
        </div>
        <div className="g-swatches">
          {PALETTE_KEYS.map((key) => (
            <Swatch key={key} colorKey={key} label={key} pressed={swatch === key} onClick={() => setSwatch(key)} />
          ))}
        </div>
      </Section>

      <Section id="cards" title="Cards, popovers and notices">
        <div className="g-columns">
          <Card tint="fern">
            <div className="g-card-body">
              <div className="g-card-title">
                <Marker color="fern" state="here" />
                <Name person={jules} size="display" />
              </div>
              <p className="g-card-status">speakers: finally set up</p>
            </div>
          </Card>
          <Popover label="Jules" tint="fern" arrow="left" onClose={() => {}}>
            <div className="g-card-body">
              <div className="g-card-title">
                <Marker color="fern" state="here" />
                <Name person={jules} size="display" />
              </div>
              <p className="g-card-status">speakers: finally set up</p>
              <div className="g-card-actions">
                <Button variant="primary" icon="message" fill>
                  Message
                </Button>
                <Button icon="knock">Knock</Button>
              </div>
            </div>
          </Popover>
          <div>
            <Notice icon="door" tag={<Chip label="The Good Company">The Good Company</Chip>}>
              <Name person={callie} size="control" /> came into #general
            </Notice>
          </div>
        </div>
      </Section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing kit root");
createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
