import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { User } from "../../src/generated/User";
import { ApiError, AuthedApi } from "../../src/lib/api";
import { KnockButton } from "../../src/roster/RosterPanel";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";

const user: User = {
  id: "friend", username: "friend", display_name: "Friend", is_host: false,
  style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "coral" }, effect: "none", msg_font_key: null },
  status: null, entrance_sound: null, last_seen_at: null,
};
let resolveKnock = (): void => {};
let calls = 0;
const makeApi = (baseUrl: string): AuthedApi => {
  const api = new AuthedApi(baseUrl, {
    accessToken: "fixture", refreshToken: "fixture", expiresAt: Date.now() + 60_000,
  }, { onTokens: () => {}, onSignedOut: () => {} });
  api.knock = async () => {
    document.documentElement.dataset.calls = String(++calls);
    const mode = document.documentElement.dataset.mode;
    if (mode === "pending") await new Promise<void>((resolve) => { resolveKnock = resolve; });
    if (mode === "failure") throw new Error("fixture refusal");
    if (mode === "limited") throw new ApiError(429, {
      code: "RATE_LIMITED", message: "Slow down a little.", retry_after_ms: 1_150_000,
    });
  };
  return api;
};
const first = makeApi("https://first.example");
const second = makeApi("https://second.example");
function Fixture() {
  const [shown, setShown] = useState(true);
  const [api, setApi] = useState(first);
  const [person, setPerson] = useState(user);
  return <>
    <button onClick={() => setShown(!shown)}>toggle card</button>
    <button onClick={() => setApi(api === first ? second : first)}>switch server</button>
    <button onClick={() => setPerson({ ...user, id: "other" })}>switch person</button>
    <button onClick={() => resolveKnock()}>finish request</button>
    {shown ? <KnockButton api={api} user={person} /> : null}
  </>;
}
const root = document.getElementById("root");
if (!root) throw new Error("missing fixture root");
createRoot(root).render(<StrictMode><Fixture /></StrictMode>);
