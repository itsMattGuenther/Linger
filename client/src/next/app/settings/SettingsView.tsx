import { useLayoutEffect, useRef, useState } from "react";
import { type SettingsKey, type SettingsScope, sectionLead, SECTION_LABELS, settingsEntries, showable } from "../../core/settings";
import { Icon, type IconName, type NavEntry, NavList, TitleBar } from "../../kit";
import { type AccountProps, AccountSection } from "./AccountSection";
import { type AppearanceProps, AppearanceSection } from "./AppearanceSection";
import {
  type HostInvitesProps,
  type HostPeopleProps,
  type HostRoomsProps,
  type HostServerProps,
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
import "./SettingsView.css";

/** Everything the host can change, for the server you host. */
export interface HostingProps {
  /** The server's name, under the Hosting label. */
  serverName: string;
  rooms: HostRoomsProps;
  invites: HostInvitesProps;
  people: HostPeopleProps;
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
  /** Only for the host; leave out for a member (SRV-8). */
  hosting?: HostingProps;
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
    severalServers: (props.servers?.servers.length ?? 0) > 1,
    windows: hasWindowsChoices(props.windows),
  };
  const [wanted, setWanted] = useState<SettingsKey>(props.initialSection ?? "profile");
  const section = showable(scope, wanted);
  const main = useRef<HTMLDivElement | null>(null);

  // A section starts at its top, not where the last one was scrolled to.
  useLayoutEffect(() => {
    if (main.current) main.current.scrollTop = 0;
  }, [section]);

  const entries: NavEntry<SettingsKey>[] = settingsEntries(scope).map((entry) =>
    entry.kind === "group" ? entry : { kind: "item", key: entry.key, label: entry.label, icon: ICONS[entry.key] },
  );

  return (
    <div className="nx-set" data-screen="settings">
      <TitleBar leading={<Icon name="gear" size="md" />} focused={props.focused ?? true} onClose={props.onClose}>
        Settings
      </TitleBar>
      <div className="nx-set-body">
        <nav className="nx-set-nav" aria-label="Settings">
          <NavList label="Settings sections" entries={entries} current={section} onSelect={setWanted} panelId="nx-set-panel" />
        </nav>
        <div className="nx-set-main" ref={main}>
          <section id="nx-set-panel" className="nx-set-panel" role="tabpanel" aria-labelledby="nx-set-title">
            <header className="nx-set-head">
              <h2 id="nx-set-title" className="nx-set-title">
                {SECTION_LABELS[section]}
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
      return <SoundSection {...props.sound} />;
    case "notifications":
      return <NotificationsSection {...props.notifications} />;
    case "account":
      return <AccountSection {...props.account} />;
    case "servers":
      return props.servers ? <ServersSection {...props.servers} /> : null;
    case "rooms":
      return props.hosting ? <RoomsSection {...props.hosting.rooms} /> : null;
    case "invites":
      return props.hosting ? <InvitesSection {...props.hosting.invites} /> : null;
    case "people":
      return props.hosting ? <PeopleSection {...props.hosting.people} /> : null;
    case "server":
      return props.hosting ? <ServerSection {...props.hosting.server} /> : null;
  }
}
