import { EVERY_SERVER, scopeOptions, type ScopeServer } from "../core/scope";
import { Select } from "../kit";
import { serverColor } from "./list/ServerSection";
import "./ServerScope.css";

/**
 * Which server search or media looks through, when you're on several
 * (docs/design/buddy-list.md, "Several servers"): the server's color as a
 * short bar where a marker sits, and a drop-down of every server and then
 * each by name. For every server the lead column holds the first three's
 * bars, which is all it has room for. With one server there is nothing to
 * pick, and it draws nothing.
 */
export function ServerScope({ servers, value, onChange }: { servers: readonly ScopeServer[]; value: string; onChange: (value: string) => void }) {
  if (servers.length < 2) return null;
  const picked = value === EVERY_SERVER ? null : servers.find((one) => one.server === value);
  return (
    <div className="nx-scope">
      <span className="nx-scope-marks" aria-hidden="true">
        {(picked ? [picked] : servers.slice(0, 3)).map((one) => (
          <i key={one.server} style={serverColor(one.accent)} />
        ))}
      </span>
      <span className="nx-scope-pick">
        <Select label="Server" hideLabel value={value} onChange={onChange} options={scopeOptions(servers)} />
      </span>
    </div>
  );
}

/** A server's bar, for a hit or a tile that says which server it's from. */
export function ServerMark({ accent }: { accent: string | null }) {
  return <i className="nx-scope-mark" style={serverColor(accent)} aria-hidden="true" />;
}
