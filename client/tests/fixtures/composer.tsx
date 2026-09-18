import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Room } from "../../src/generated/Room";
import { AuthedApi } from "../../src/lib/api";
import { Composer } from "../../src/stream/Stream";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/app.css";

const api = new AuthedApi("https://fixture.invalid", {
  accessToken: "fixture", refreshToken: "fixture", expiresAt: Date.now() + 60_000,
}, { onTokens: () => {}, onSignedOut: () => {} });
// An accidental submit must be observable, but must never send a request.
api.post = async () => {
  document.documentElement.dataset.submitted = "yes";
  throw new Error("fixture does not send messages");
};
const room: Room = {
  id: "fixture", slug: "fixture", name: "fixture", topic: null,
  kind: "room", member_ids: null, position: 0, archived_at: null, last_message_id: null,
};
function Fixture() {
  useEffect(() => { document.querySelector("textarea")?.focus(); }, []);
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <Composer api={api} room={room} title="#fixture" isDm={false} replyTo={null}
        onClearReply={() => {}} onEditLast={() => {}} />
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("missing fixture root");
createRoot(root).render(<StrictMode><Fixture /></StrictMode>);
