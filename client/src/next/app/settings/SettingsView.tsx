import { useLayoutEffect, useRef, useState } from "react";
import { type SettingsKey, type SettingsScope, sectionLabel, sectionLead, settingsEntries, showable } from "../../core/settings";
import { minimizer } from "../../core/windowControls";
import { Icon, IconButton, type IconName, type NavEntry, NavList, TitleBar } from "../../kit";
import { type AccountProps, AccountSection } from "./AccountSection";
import { type AppearanceProps, AppearanceSection } from "./AppearanceSection";
import {
  type HostInvitesProps,
  type HostPeopleProps,
  type HostRoomsProps,
  type HostServerProps,
  EmojiSection,
  type HostEmojiProps,
  InvitesSection,
  PeopleSection,
  RoomsSection,
  ServerSection,
} from "./HostingSections";
import { type NotificationsProps, NotificationsSection } from "./NotificationsSection";
import { type ProfileProps, ProfileSection } from "./ProfileSection";
import { type ServersProps, ServersSection } from "./ServersSection";
import { type SoundProps, SoundSection } from "./SoundSection";
import { hasWindowsChoices, type WindowsProps, WindowsSection } from "./WindowsSection";
import { useBackButton } from "../useBackButton";
import "./SettingsView.css";

/** Everything the host can change, for the server you host or co-host. */
export interface HostingProps {
  /** The server's name, under the Hosting label. */
  serverName: string;
  /** You're a co-host here, not the host (#424): the words say so. */
  cohost?: boolean;
  rooms: HostRoomsProps;
  invites: HostInvitesProps;
  people: HostPeopleProps;
  emoji: HostEmojiProps;
  server: HostServerProps;
}

export interface SettingsViewProps {
  /** The section to open on; a missing one (Hosting for a member) opens Profile. */
  initialSection?: SettingsKey;
  /** The window has focus: full-strength title bar. */
  focused?: boolean;
  /** Draws Linger's own close button, where the desktop draws none. */
  onClose?: () => void;
  profile: ProfileProps;
  appearance: AppearanceProps;
  /** Leave out, or give no choices, and there's no Windows section. */
  windows?: WindowsProps;
  sound: SoundProps;
  notifications: NotificationsProps;
  account: AccountProps;
  /** With more than one server; leave out with one. */
  servers?: ServersProps;
  /** Only for the host or a co-host; leave out for a member (SRV-8, #424). */
  hosting?: HostingProps;
  /** The phone app (SPEC §4.15): no Notifications, and Sound and Account say less. */
  phone?: boolean;
}

const ICONS: Record<SettingsKey, IconName> = {
  profile: "tag",
  appearance: "sun",
  windows: "windows",
  sound: "speaker",
  notifications: "bell",
  account: "key",
  servers: "stack",
  rooms: "hash",
  invites: "link",
  people: "people",
  emoji: "smile",
  server: "house",
};

/**
 * The Settings window (docs/design/buddy-list.md, "Settings"): a sidebar of
 * sections and the one showing. Every setting today's app has is here
 * (docs/design/parity.md, SET). It holds only which section is showing and
 * each form's draft; everything else arrives as props and leaves as
 * callbacks, so the same view serves the real window and the fixture page.
 */
export function SettingsView(props: SettingsViewProps) {
  const scope: SettingsScope = {
    hosting: props.hosting?.serverName ?? null,
    cohost: props.hosting?.cohost === true,
    severalServers: (props.servers?.servers.length ?? 0) > 1,
    windows: hasWindowsChoices(props.windows),
    phone: props.phone === true,
  };
  const [wanted, setWanted] = useState<SettingsKey>(props.initialSection ?? "profile");
  const section = showable(scope, wanted);
  // On the phone the sections are a list of their own, and one opens over it
  // with a way back (SPEC §4.15): side by side, neither fits. Asked for a
  // section, it opens on that one.
  const [stack, setStack] = useState<"index" | "section">(props.initialSection ? "section" : "index");
  const phone = props.phone === true;
  const choose = (key: SettingsKey) => {
    setWanted(key);
    setStack("section");
  };
  // Android's Back: from a section to the list of them, and from there out.
  useBackButton(phone, () => {
    if (stack === "section") setStack("index");
    else props.onClose?.();
  });
  const main = useRef<HTMLDivElement | null>(null);

  // A section starts at its top, not where the last one was scrolled to.
  useLayoutEffect(() => {
    if (main.current) main.current.scrollTop = 0;
  }, [section]);

  const entries: NavEntry<SettingsKey>[] = settingsEntries(scope).map((entry) =>
    entry.kind === "group" ? entry : { kind: "item", key: entry.key, label: entry.label, icon: ICONS[entry.key] },
  );

  return (
    <div className="nx-set" data-screen="settings" data-stack={phone ? stack : undefined}>
      <TitleBar
        leading={
          // On the phone Settings is a screen over the list, left by Back
          // like every other one (SPEC §4.15).
          !phone ? (
            <Icon name="gear" size="md" />
          ) : stack === "section" ? (
            <IconButton icon="back" label="Back to Settings" size="lg" onClick={() => setStack("index")} />
          ) : props.onClose ? (
            <IconButton icon="back" label="Back" size="lg" onClick={props.onClose} />
          ) : undefined
        }
        focused={props.focused ?? true}
        onMinimize={!phone && props.onClose ? minimizer() : undefined}
        onClose={phone ? undefined : props.onClose}
      >
        {phone && stack === "section" ? sectionLabel(section, scope) : "Settings"}
      </TitleBar>
      <div className="nx-set-body">
        <nav className="nx-set-nav" aria-label="Settings">
          <NavList label="Settings sections" entries={entries} current={section} onSelect={phone ? choose : setWanted} panelId="nx-set-panel" />
        </nav>
        <div className="nx-set-main" ref={main}>
          <section id="nx-set-panel" className="nx-set-panel" role="tabpanel" aria-labelledby="nx-set-title">
            <header className="nx-set-head">
              <h2 id="nx-set-title" className="nx-set-title">
                {sectionLabel(section, scope)}
              </h2>
              <p className="nx-set-intro">{sectionLead(section, scope)}</p>
            </header>
            {/* Keyed by section, so each opens with fresh drafts. */}
            <div className="nx-set-sections" key={section}>
              <Section section={section} {...props} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Section({ section, ...props }: SettingsViewProps & { section: SettingsKey }) {
  switch (section) {
    case "profile":
      return <ProfileSection {...props.profile} />;
    case "appearance":
      return <AppearanceSection {...props.appearance} />;
    case "windows":
      return props.windows ? <WindowsSection {...props.windows} /> : null;
    case "sound":
      return <SoundSection {...props.sound} phone={props.phone} />;
    case "notifications":
      return <NotificationsSection {...props.notifications} />;
    case "account":
      return <AccountSection {...props.account} phone={props.phone} />;
    case "servers":
      return props.servers ? <ServersSection {...props.servers} /> : null;
    case "rooms":
      return props.hosting ? <RoomsSection {...props.hosting.rooms} /> : null;
    case "invites":
      return props.hosting ? <InvitesSection {...props.hosting.invites} /> : null;
    case "people":
      return props.hosting ? <PeopleSection {...props.hosting.people} /> : null;
    case "emoji":
      return props.hosting ? <EmojiSection {...props.hosting.emoji} /> : null;
    case "server":
      return props.hosting ? <ServerSection {...props.hosting.server} /> : null;
  }
}
