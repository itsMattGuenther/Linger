import { createRoot } from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Room } from "../../src/generated/Room";
import type { User } from "../../src/generated/User";
import type { ServerFrame } from "../../src/generated/ServerFrame";
import { AuthedApi } from "../../src/lib/api";
import { connect } from "../../src/lib/gateway";
import VoiceBar from "../../src/voice/VoiceBar";
import "../../src/fonts/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/names.css";
import "../../src/generated/palette.generated.css";

const baseUrl = "https://fixture.example";
Object.defineProperty(globalThis, "isTauri", { value: true });
mockIPC((cmd, args) => {
  if (cmd === "voice_controls") {
    if (document.documentElement.dataset.refuse === "yes") throw new Error("fixture refusal");
    if (!args || !("controls" in args)) throw new Error("missing fixture controls");
    document.documentElement.dataset.controls = JSON.stringify(args.controls);
  }
  if (cmd === "voice_leave") document.documentElement.dataset.left = "yes";
  return true;
}, { shouldMockEvents: true });
localStorage.setItem("linger.voice.pushToTalk", String(new URLSearchParams(location.search).has("ptt")));
const user: User = {
  id: "me", username: "me", display_name: "Matt", is_host: true,
  style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
  status: null, entrance_sound: null, last_seen_at: null,
};
const users = [user, ...["Muted friend", "Deafened friend", "Legacy friend"].map((name) => ({ ...user, id: name, display_name: name }))];
const room: Room = { id: "garage", slug: "garage", name: "Garage", kind: "room", topic: null, member_ids: null, position: 0, archived_at: null, last_message_id: null };
const api = new AuthedApi(baseUrl, { accessToken: "fixture", refreshToken: "fixture", expiresAt: Date.now() + 60_000 }, { onTokens: () => {}, onSignedOut: () => {} });
api.accessToken = async () => ({ token: "fixture", expiresAt: Date.now() + 60_000 });
api.get = async () => { throw new Error("no fixture network requests"); };
await connect(api);
const frame = (frame: ServerFrame) => emit("gateway:frame", { server: baseUrl, frame });
await frame({ op: "ready", s: 1, d: { session_id: "mine", user, users, rooms: [room], dms: [], presence: [] } });
await frame({ op: "voice.state", s: 2, d: { room_id: room.id, peers: [
  { session_id: "muted", user_id: "Muted friend", controls: { muted: true, deafened: false } },
  { session_id: "deafened", user_id: "Deafened friend", controls: { muted: true, deafened: true } },
  { session_id: "legacy", user_id: "Legacy friend" },
] } });
document.addEventListener("fixture-seats", () => {
  void frame({ op: "voice.state", d: { room_id: room.id, peers: [
    { session_id: "mine", user_id: user.id, controls: { muted: false, deafened: false } },
    { session_id: "duplicate", user_id: user.id, controls: { muted: false, deafened: false } },
    { session_id: "muted", user_id: "Muted friend", controls: { muted: true, deafened: false } },
  ] } });
  void emit("voice:speaking", { server: baseUrl, peer: null, speaking: true });
  void emit("voice:peer", { server: baseUrl, peer: "duplicate", state: "failed" });
});
const root = document.getElementById("root");
if (!root) throw new Error("missing fixture root");
createRoot(root).render(<VoiceBar api={api} room={room} users={users} />);
