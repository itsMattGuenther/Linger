import type { CSSProperties } from "react";
import type { User } from "../../../generated/User";
import { Button, Card, IconButton, Name, SettingRow, Switch } from "../../kit";

export interface ServerEntry {
  /** The server's address, which is its identity here. */
  id: string;
  name: string;
  /** The host's accent, a palette key, or null (HOST-9). */
  accent: string | null;
  /** You, on that server: a different you on each (MULTI-9). */
  me: User;
  /** Per-server quiet (MULTI-7): present only once it's built. */
  quiet?: boolean;
  /** Its own list window (MULTI-7): present only once it's built. */
  ownWindow?: boolean;
}

export interface ServersProps {
  servers: readonly ServerEntry[];
  /** Move a server up or down your list (MULTI-4). The order is yours; nothing reshuffles. */
  onMove: (id: string, delta: -1 | 1) => void;
  onQuiet?: (id: string, quiet: boolean) => void;
  onOwnWindow?: (id: string, own: boolean) => void;
  /** Sign out of one server; the others stay (SIGN-8). */
  onSignOut: (id: string) => void;
  onAddServer: () => void;
}

function accentStyle(key: string | null): CSSProperties | undefined {
  return key && /^[a-z]{2,16}$/.test(key) ? ({ "--server": `var(--name-${key})` } as CSSProperties) : undefined;
}

/** Servers, with more than one: each its own account, in your order (MULTI-1, MULTI-4, MULTI-7). */
export function ServersSection({ servers, onMove, onQuiet, onOwnWindow, onSignOut, onAddServer }: ServersProps) {
  return (
    <section className="nx-set-block">
      <ul className="nx-set-servers" aria-label="Your servers, in order">
        {servers.map((server, index) => (
          <li key={server.id}>
            <Card>
              <div className="nx-set-server" style={accentStyle(server.accent)}>
                <div className="nx-set-server-head">
                  <span className="nx-set-server-mark" aria-hidden="true" />
                  <h3 className="nx-set-server-name">{server.name}</h3>
                  <span className="nx-set-server-move">
                    <IconButton icon="up" label={`Move ${server.name} up`} size="sm" disabled={index === 0} onClick={() => onMove(server.id, -1)} />
                    <IconButton icon="down" label={`Move ${server.name} down`} size="sm" disabled={index === servers.length - 1} onClick={() => onMove(server.id, 1)} />
                  </span>
                </div>
                <p className="nx-set-server-you">
                  You're <Name person={server.me} size="inline" /> here
                </p>
                {onQuiet && server.quiet !== undefined ? (
                  <SettingRow
                    title="Quiet"
                    description="No chimes, no bold, no arrival cards. Knocks still reach you."
                    control={<Switch label={`Quiet, for ${server.name}`} checked={server.quiet} onChange={(on) => onQuiet(server.id, on)} />}
                  />
                ) : null}
                {onOwnWindow && server.ownWindow !== undefined ? (
                  <SettingRow
                    title="Own window"
                    description="A buddy list of its own, for a busy night or a second screen."
                    control={<Switch label={`Own window, for ${server.name}`} checked={server.ownWindow} onChange={(on) => onOwnWindow(server.id, on)} />}
                  />
                ) : null}
                <div className="nx-set-server-foot">
                  <Button size="sm" variant="danger" icon="leave" onClick={() => onSignOut(server.id)}>
                    Sign out of {server.name}
                  </Button>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <div className="nx-set-actions" data-start="yes">
        <span className="nx-set-buttons">
          <Button icon="plus" onClick={onAddServer}>
            Add a server
          </Button>
        </span>
      </div>
    </section>
  );
}
