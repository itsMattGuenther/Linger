// Settings: its own window, opened from the gear in the list's title bar (or
// Ctrl+,). It carries everything today's app has, regrouped for this design,
// plus the design's own choices: how conversations open, arrival cards and
// door sounds, and (with several servers) a page per server.
//
// The cheap things work: switches, the conversations choice, plain names,
// your look (saved into the list), quiet and own-window for servers, sound
// previews. The rest is drawn, not wired.

import { nameStyle } from "../shared/data.js";

const PALETTE = ["ember", "rust", "amber", "brass", "lime", "fern", "mint", "teal", "cyan", "sky", "azure", "indigo", "violet", "orchid", "rose", "slate"];
const FACES = ["Geist Sans", "Geist Mono", "IBM Plex Sans", "IBM Plex Mono", "JetBrains Mono", "Inter", "Space Grotesk", "Commit Mono", "Newsreader", "Instrument Serif", "Departure Mono", "Silkscreen"];
const MESSAGE_FACES = ["Geist Sans", "IBM Plex Sans", "Inter", "Space Grotesk"];
const SCALES = [100, 110, 125, 150, 175, 200];
const CHIMES = [
  ["voice", "voice joins, leaves and moves", "Your voice session, and the people joining or leaving it.", true],
  ["controls", "mute and deafen controls", "A quiet confirmation when you mute, unmute or deafen.", true],
  ["dms", "DM messages", "A soft note for a new personal message.", true],
  ["rooms", "room messages", "Off by default. Your conversations don’t need to compete for attention.", false],
  ["knocks", "knocks", "Two gentle taps when someone wants your attention.", true],
];

const tabsArt = `<svg viewBox="0 0 44 30" aria-hidden="true"><rect x="1" y="5" width="42" height="24" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1 10h42" stroke="currentColor" stroke-width="1.2"/><rect x="3" y="1.5" width="12" height="8.5" rx="2" fill="currentColor" opacity=".9"/><rect x="16.5" y="3" width="10" height="7" rx="2" fill="currentColor" opacity=".35"/><rect x="28" y="3" width="10" height="7" rx="2" fill="currentColor" opacity=".35"/><path d="M6 15h22M6 19h28M6 23h16" stroke="currentColor" stroke-width="1.3" opacity=".5" stroke-linecap="round"/></svg>`;
const winsArt = `<svg viewBox="0 0 44 30" aria-hidden="true"><rect x="1" y="1" width="12" height="28" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="15" y="1" width="13" height="28" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="30" y="1" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="30" y="16" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M15 5.5h13M30 5.5h13M30 20.5h13M1 5.5h12" stroke="currentColor" stroke-width="1.2" opacity=".6"/><circle cx="4.5" cy="10" r="1.2" fill="currentColor" opacity=".7"/><circle cx="4.5" cy="14" r="1.2" fill="currentColor" opacity=".7"/></svg>`;
const trayArt = `<svg viewBox="0 0 44 30" aria-hidden="true"><rect x="1" y="1" width="42" height="28" rx="3" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".45"/><path d="M1 23h42" stroke="currentColor" stroke-width="1.2" opacity=".45"/><rect x="31" y="25" width="4" height="2" rx="1" fill="currentColor"/><circle cx="38.5" cy="26" r="1.3" fill="currentColor" opacity=".6"/></svg>`;
const quitArt = `<svg viewBox="0 0 44 30" aria-hidden="true"><rect x="1" y="1" width="42" height="28" rx="3" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".45"/><path d="M17 10l10 10M27 10L17 20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

export function createSettings(ctx) {
  const { I, esc, nameHTML, color } = ctx;
  const KEY = "settings";
  let section = "profile";
  let draft = null; // your look, before you save it
  const state = {
    theme: "dark",
    scale: 100,
    warmth: true,
    plain: false,
    closeList: "tray",
    muted: false,
    quiet: false,
    quietFrom: 22 * 60,
    quietUntil: 8 * 60,
    chimes: Object.fromEntries(CHIMES.map(([k, , , on]) => [k, on])),
    pushToTalk: false,
    mic: "default",
    speakers: "default",
    notify: { jules: { everywhere: false, rooms: ["general"] }, eli: { everywhere: true, rooms: [] } },
    notifyOpen: "jules",
    exportPhase: "idle",
  };

  const SECTIONS = () => [
    { group: "You" },
    { key: "profile", label: "Profile", icon: I.tag },
    { group: "This app" },
    { key: "appearance", label: "Appearance", icon: I.sun },
    { key: "windows", label: "Windows", icon: I.windows },
    { key: "sound", label: "Sound & Voice", icon: I.speaker },
    { key: "notifications", label: "Notifications", icon: I.bell },
    { key: "account", label: "Account & App", icon: I.key },
    ...(ctx.MULTI ? [{ key: "servers", label: "Servers", icon: I.stack }] : []),
    { group: "Hosting", sub: ctx.hostServer.name },
    { key: "rooms", label: "Rooms", icon: I.hash },
    { key: "invites", label: "Invites", icon: I.link },
    { key: "people", label: "People", icon: I.people },
    { key: "server", label: "Server", icon: I.house },
  ];

  const TITLES = {
    profile: ["Profile", ctx.MULTI ? `You on ${ctx.hostServer.name}. Each server has its own name and look: see Servers.` : "Who you are here, what you're up to, and how your name looks."],
    appearance: ["Appearance", "Make yourself comfortable. These choices stay on this computer."],
    windows: ["Windows", "How Linger sits on your desktop."],
    sound: ["Sound & Voice", "Choose your notification chimes. To silence people in voice, use deafen."],
    notifications: ["Notifications", "Desktop banners, for mentions and for people you choose."],
    account: ["Account & App", "Your password, your archive, updates and this computer."],
    servers: ["Servers", "Each server is its own account: its own you, its own look. The order is yours; nothing reshuffles by activity."],
    rooms: ["Rooms", `You host ${ctx.hostServer.name}. What you change here changes it for everyone.`],
    invites: ["Invites", "A link lets somebody make an account here. Make one for the person you're asking."],
    people: ["People", "Manage who can use this server. Removing someone requires confirmation."],
    server: ["Server", "Its name and its color, as everyone sees them."],
  };

  // --- little building blocks ---------------------------------------------

  const sw = (id, on, label, hint = "", extra = "") => `
    <div class="s-row">
      <div class="s-copy"><b id="lb-${id}">${label}</b>${hint ? `<small>${hint}</small>` : ""}</div>
      ${extra}
      <button class="sw" role="switch" aria-checked="${on}" aria-labelledby="lb-${id}" data-sw="${id}"><i></i></button>
    </div>`;
  const choices = (id, list, current, { style = () => "" } = {}) =>
    `<div class="s-choices" role="group" data-choice="${id}">${list
      .map(([value, label]) => `<button aria-pressed="${String(value) === String(current)}" data-v="${esc(String(value))}" style="${style(value)}">${label}</button>`)
      .join("")}</div>`;
  const field = (label, input, hint = "") => `<label class="s-field"><span class="s-flabel">${label}</span>${input}${hint ? `<small>${hint}</small>` : ""}</label>`;
  const head = (title, lead = "") => `<h3 class="s-h">${title}</h3>${lead ? `<p class="s-lead">${lead}</p>` : ""}`;
  const clock = (m) => {
    const h = Math.floor(m / 60);
    return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
  };
  const halfHours = Array.from({ length: 48 }, (_, i) => i * 30);
  const timeSelect = (id, value, disabled) =>
    `<select class="s-select" data-sel="${id}" ${disabled ? "disabled" : ""}>${halfHours.map((m) => `<option value="${m}" ${m === value ? "selected" : ""}>${clock(m)}</option>`).join("")}</select>`;

  // --- sections ------------------------------------------------------------

  function profile() {
    const me = ctx.me;
    draft ??= {
      font: me.font, weight: me.weight ?? 600, italic: me.style === "italic",
      gradient: !!me.gradient, from: me.gradient?.[0] ?? me.color, to: me.gradient?.[1] ?? "sky",
      effect: me.effect ?? "none", msgFont: me.msgFont ?? null,
    };
    const preview = { ...me, font: draft.font, weight: draft.weight, style: draft.italic ? "italic" : "normal", color: draft.from, gradient: draft.gradient ? [draft.from, draft.to] : null, size: null };
    const dirty = preview.font !== me.font || preview.weight !== (me.weight ?? 600) || preview.style !== (me.style ?? "normal") || preview.color !== me.color || JSON.stringify(preview.gradient) !== JSON.stringify(me.gradient ?? null) || draft.effect !== (me.effect ?? "none") || draft.msgFont !== (me.msgFont ?? null);
    const swatches = (slot) =>
      `<div class="s-swatches" role="group" aria-label="${slot === "to" ? "blend to" : "name color"}" data-swatch="${slot}">${PALETTE.map((k) => `<button class="sw-c" style="--c:${color(k)}" aria-label="${k}" title="${k}" aria-pressed="${draft[slot] === k}"></button>`).join("")}</div>`;
    return `
      <section class="s-sec">
        ${head("Who you are")}
        <div class="s-grid2">
          ${field("Display name", `<input class="s-input" value="${esc(me.name)}" maxlength="32" />`, "How your name reads on this server.")}
          ${field("Username", `<input class="s-input mono" value="${esc(me.id)}" readonly />`, "You sign in with this. It doesn't change.")}
        </div>
        <div class="s-actions"><button class="pill-btn" disabled>Save name</button></div>
      </section>
      <section class="s-sec">
        ${head("Your status", "Let people know what you’re up to. It shows under your name in everyone's list.")}
        ${field("Status", `<input class="s-input italic" value="${esc(me.status ?? "")}" maxlength="240" placeholder="What are you up to?" />`)}
        <div class="s-grid3">
          ${field("Reading", `<input class="s-input" value="${esc(me.reading ?? "")}" placeholder="a book, an article" />`)}
          ${field("Listening to", `<input class="s-input" value="${esc(me.listening ?? "")}" placeholder="a record, a show" />`)}
          ${field("Working on", `<input class="s-input" value="${esc(me.working ?? "")}" placeholder="a project" />`)}
        </div>
        <div class="s-row s-image">
          <div class="s-copy"><b>Image</b><small>One picture on your status card. Up to 512 KB, shown at 400 × 200.</small></div>
          <button class="pill-btn">${I.media}<span>Add an image</span></button>
        </div>
        ${field("Away message", `<input class="s-input italic" value="${esc(me.away ?? "")}" placeholder="back after work" />`, "Setting one makes you away, and it shows instead of your status. The Away button in your list does the same.")}
        <div class="s-actions"><button class="pill-btn lamp">Save status</button></div>
      </section>
      <section class="s-sec">
        ${head("Make yourself at home", "Your name, your colors. Try a look before you save it.")}
        <div class="style-preview">
          <div class="spv-top"><span class="name fx-${draft.effect}" style="${nameStyle(preview)}">${esc(me.name)}</span><span class="spv-note">Preview · only you can see this</span></div>
          <p class="spv-msg" style="${draft.msgFont ? `font-family:'${draft.msgFont}',var(--sans)` : ""}">There you are. I saved you a seat.</p>
        </div>
        ${ctx.isPlain() ? `<p class="s-note">Plain names are on in Appearance. This preview still shows your style.</p>` : ""}
        <div class="style-rows">
          <div class="st-row"><span class="st-l">font</span>${choices("font", FACES.map((f) => [f, f]), draft.font, { style: (f) => `font-family:'${f}',var(--sans)` })}</div>
          <div class="st-row"><span class="st-l">weight</span>${choices("weight", [[400, "regular"], [500, "medium"], [700, "bold"]], draft.weight >= 600 ? 700 : draft.weight, { style: (w) => `font-weight:${w}` })}<button class="s-chip ${draft.italic ? "on" : ""}" data-italic aria-pressed="${draft.italic}" style="font-style:italic">italic</button></div>
          <div class="st-row"><span class="st-l">color</span>${choices("fill", [["one", "one color"], ["two", "two, blended"]], draft.gradient ? "two" : "one")}</div>
          <div class="st-row"><span class="st-l">${draft.gradient ? "from" : ""}</span>${swatches("from")}</div>
          ${draft.gradient ? `<div class="st-row"><span class="st-l">to</span>${swatches("to")}</div>` : ""}
          <div class="st-row"><span class="st-l">effect</span>${choices("effect", [["none", "none"], ["shimmer", "shimmer"], ["glow", "glow"]], draft.effect)}</div>
          <div class="st-row"><span class="st-l">your messages</span>${choices("msgFont", [["", "the reading face"], ...MESSAGE_FACES.map((f) => [f, f])], draft.msgFont ?? "", { style: (f) => (f ? `font-family:'${f}',var(--sans)` : "") })}</div>
        </div>
        <p class="s-note">The face your messages are set in is the only thing you can change about the text itself. No colors and no sizes: your name carries who you are, and the words stay legible.</p>
        <div class="s-actions">${dirty ? `<button class="pill-btn" data-look="reset">Reset changes</button>` : ""}<button class="pill-btn lamp" data-look="save" ${dirty ? "" : "disabled"}>Save your look</button></div>
      </section>`;
  }

  function appearance() {
    const card = (key, label) => `
      <button class="theme-card" aria-pressed="${state.theme === key}" data-theme-pick="${key}">
        <span class="tc-sample tc-${key}" aria-hidden="true"><span class="tc-list"><i></i><i></i><i></i></span><span class="tc-chat"><i></i><i></i><i></i></span></span>
        <span class="tc-label">${label}${state.theme === key ? I.check.replace("<svg", '<svg class="tc-tick"') : ""}</span>
      </button>`;
    return `
      <section class="s-sec">
        ${head("Color theme", "Choose a look, or follow your desktop.")}
        <div class="theme-cards">${card("dark", "Dark")}${card("light", "Light")}${card("system", "System")}</div>
        ${sw("warmth", state.warmth, "Evening warmth", "Softer colors after sunset.")}
      </section>
      <section class="s-sec">
        ${head("Interface size", "Text, buttons and windows scale together.")}
        <div class="s-row">
          <div class="size-preview" style="--k:${state.scale / 100}"><span class="sz-aa">Aa</span><span><b>A little room to linger.</b><small>This is how your messages will read.</small></span></div>
          <select class="s-select" data-sel="scale">${SCALES.map((v) => `<option value="${v}" ${v === state.scale ? "selected" : ""}>${v}%${v === 100 ? " — default" : ""}</option>`).join("")}</select>
        </div>
      </section>
      <section class="s-sec">
        ${head("Names")}
        ${sw("plain", state.plain, "Use plain names and message fonts", "Hide custom styles in your view. Everyone else keeps theirs.")}
      </section>`;
  }

  function windows() {
    const opt = (name, value, art, title, text, current) => `
      <label class="s-card">
        <input type="radio" name="${name}" value="${value}" ${current === value ? "checked" : ""} />
        <span class="sc-art">${art}</span>
        <span class="sc-text"><b>${title}</b><small>${text}</small></span>
      </label>`;
    return `
      <section class="s-sec">
        ${head("Conversations open")}
        <fieldset class="s-cards" aria-label="Conversations open">
          ${opt("conv-mode", "tabs", tabsArt, "As tabs in one window", "The default, on any desktop. The first room you open gets a window; the next ones join it as tabs. Pop a tab out when you want two side by side.", ctx.getMode())}
          ${opt("conv-mode", "windows", winsArt, "Each in its own window", "Every room and DM gets a window of its own. Good on a tiling desktop like Omarchy, which lays them out for you.", ctx.getMode())}
        </fieldset>
        <p class="s-note with-icon">${I.speaker}<span>Voice stays on when you switch tabs or close a window. Mute, deafen and leave are in the voice bar at the bottom of your list.</span></p>
        <p class="s-note">Ctrl+Tab moves between tabs and Ctrl+W closes one. In this prototype, a browser keeps those for itself, so it's Alt+← →, Alt+1–9 and Alt+W.</p>
      </section>
      <section class="s-sec">
        ${head("When you close your list")}
        <fieldset class="s-cards" aria-label="When you close your list">
          ${opt("close-list", "tray", trayArt, "Keep Linger running", "It tucks into the system tray, so knocks and mentions still reach you. Quit from the tray.", state.closeList)}
          ${opt("close-list", "quit", quitArt, "Quit Linger", "Closing the list closes everything, and you're offline until you open it again.", state.closeList)}
        </fieldset>
      </section>`;
  }

  function sound() {
    const off = state.muted;
    const now = ctx.now();
    const mins = now.getHours() * 60 + now.getMinutes();
    const inQuiet = state.quiet && (state.quietFrom > state.quietUntil ? mins >= state.quietFrom || mins < state.quietUntil : mins >= state.quietFrom && mins < state.quietUntil);
    const status = off ? "All live chimes are off. Play still previews." : inQuiet ? `Quiet hours are silencing message and knock chimes until ${clock(state.quietUntil)}. Voice and mute/deafen sounds still play.` : "";
    return `
      <section class="s-sec">
        ${head("A familiar little sound")}
        ${sw("muted", state.muted, "Mute all notification sounds", "One switch for every chime below. Voice itself is never affected.")}
        ${sw("quiet", state.quiet, "Quiet hours", `No DM, room or knock chimes from ${clock(state.quietFrom)} to ${clock(state.quietUntil)}, on this computer’s clock. Voice and mute/deafen sounds still play.`)}
        <div class="s-quiet ${state.quiet ? "" : "dim"}">
          <label>Quiet from ${timeSelect("quietFrom", state.quietFrom, !state.quiet)}</label>
          <label>Quiet until ${timeSelect("quietUntil", state.quietUntil, !state.quiet)}</label>
        </div>
        ${status ? `<p class="s-status">${status}</p>` : ""}
        <div class="s-chimes ${off ? "dim" : ""}">
          ${CHIMES.map(([k, label, hint]) => sw(`chime-${k}`, state.chimes[k], label, hint, `<button class="pill-btn s-play" data-play="${k}" aria-label="Preview ${label}">${I.play}<span>Play</span></button>`)).join("")}
        </div>
        <p class="s-note">Play always sounds a preview. Live chimes still follow the switches and quiet hours.</p>
      </section>
      <section class="s-sec">
        ${head("Arrivals", "Like AIM's door: a small card when somebody comes in.")}
        ${sw("cards", ctx.getCards(), "Arrival cards", "A card at the corner of your screen when somebody comes in, steps away or is back. Knocks always show.")}
        ${sw("door", ctx.getDoor(), "Door sounds", "A soft two-note chime with each card. Off unless you turn it on.", `<button class="pill-btn s-play" data-play="door" aria-label="Preview the door sound">${I.play}<span>Play</span></button>`)}
      </section>
      <section class="s-sec">
        ${head("Voice", "Talking happens in a room: Join, in a room's voice strip, turns your microphone on there.")}
        <div class="s-grid2">
          ${field("Microphone", `<select class="s-select"><option>System default (Built-in microphone)</option><option>USB microphone</option><option>Headset</option></select>`)}
          ${field("Speakers", `<select class="s-select"><option>System default (Headphones)</option><option>Speakers</option><option>Headset</option></select>`)}
        </div>
        <p class="s-note">A change applies the next time you join voice. If a device you picked isn't plugged in, Linger uses the system default rather than stopping you talking.</p>
        ${sw("ptt", state.pushToTalk, "Push to talk", "Starts every call muted and opens the microphone only while you hold the key. Off by default: a room you leave running shouldn't need a key held down.", `<span class="s-key" title="The push-to-talk key">Ctrl</span>`)}
      </section>`;
  }

  function notifications() {
    const others = ctx.people.filter((p) => !p.you && ctx.srvOf(p.id) === ctx.hostServer.id);
    const hostRooms = ctx.rooms.filter((r) => ctx.srvOf(r.id) === ctx.hostServer.id);
    const rule = (p) => state.notify[p.id] ?? { everywhere: false, rooms: [] };
    const summary = (p) => {
      const r = rule(p);
      return r.everywhere ? "everywhere" : r.rooms.length ? r.rooms.map((id) => `#${hostRooms.find((x) => x.id === id)?.name ?? id}`).join(", ") : "only mentions";
    };
    return `
      <section class="s-sec">
        ${head("Desktop notifications", "Mentions can show a desktop banner. Choose people whose other messages should also notify you, across this server or in selected rooms. Banners are separate from chimes.")}
        <ul class="nt-list">${others
          .map((p) => {
            const r = rule(p);
            const open = state.notifyOpen === p.id;
            return `<li class="nt ${open ? "open" : ""}">
              <button class="nt-h" data-nt="${p.id}" aria-expanded="${open}">${I.caret.replace("<svg", '<svg class="caret"')}${nameHTML(p)}<span class="nt-sum">${esc(summary(p))}</span></button>
              ${open ? `<div class="nt-body">
                <label class="s-check"><input type="checkbox" data-nt-every="${p.id}" ${r.everywhere ? "checked" : ""} /> everywhere</label>
                ${r.everywhere ? "" : hostRooms.map((room) => `<label class="s-check"><input type="checkbox" data-nt-room="${p.id}" value="${room.id}" ${r.rooms.includes(room.id) ? "checked" : ""} /> #${esc(room.name)}</label>`).join("")}
              </div>` : ""}
            </li>`;
          })
          .join("")}</ul>
        <p class="s-note">Somebody naming you always reaches you. Nothing else does, and there is no @everyone to turn on.</p>
      </section>`;
  }

  function account() {
    const ex = state.exportPhase;
    return `
      <section class="s-sec">
        ${head("Password", `The password you sign in to ${esc(ctx.hostServer.name)} with.`)}
        <div class="s-grid2">
          ${field("Current password", `<input class="s-input" type="password" autocomplete="off" />`)}
          ${field("New password", `<input class="s-input" type="password" autocomplete="off" />`, "At least 8 characters.")}
        </div>
        <div class="s-actions"><button class="pill-btn" disabled>Change password</button></div>
      </section>
      <section class="s-sec">
        ${head("Take everything with you", "Download public rooms and your own DMs, including shared files, as a zip. Messages open in any text editor. Available once an hour.")}
        <p class="s-status ${ex === "ready" ? "ok" : ""}" aria-live="polite">${ex === "working" ? "Building your archive…" : ex === "ready" ? "Your archive is ready." : "Nothing built yet."}</p>
        <div class="s-actions left"><button class="pill-btn" data-export ${ex === "working" ? "disabled" : ""}>${ex === "working" ? "building…" : "Export everything"}</button>${ex === "ready" ? `<button class="pill-btn lamp">Download it</button>` : ""}</div>
      </section>
      <section class="s-sec">
        ${head("Updates", "Linger checks for a new version when you open this. Nothing is downloaded until you ask for it, and every update is checked against this project's signing key before it is installed.")}
        <p class="s-status ok">You are on version 0.3.6, the newest.</p>
        <div class="s-actions left"><button class="pill-btn">Check again</button></div>
      </section>
      <section class="s-sec">
        ${head("This computer", ctx.MULTI ? "Signing out forgets a server on this computer. It does not delete your account. Each server signs out on its own, in Servers." : "Signing out forgets this server on this computer. It does not delete your account.")}
        <div class="s-actions left"><button class="pill-btn danger">${I.leave}<span>Sign out${ctx.MULTI ? " of everything" : ""}</span></button></div>
      </section>`;
  }

  function servers() {
    return `
      <section class="s-sec">
        <ul class="srv-set">${ctx.order
          .map((id, i) => {
            const s = ctx.srvById[id];
            const my = ctx.meOf(id);
            const t = ctx.timeThere(s);
            const popped = ctx.poppedOut.has(id);
            return `<li class="ss" style="--acc:${color(s.accent)}">
              <div class="ss-h"><span class="srv-mark" aria-hidden="true"></span><b>${esc(s.name)}</b>${t ? `<span class="ss-there">${t.night ? I.moon : I.sun}${esc(t.text)}</span>` : ""}
                <span class="ss-move"><button class="icon-btn" data-ss-move="${id}" data-dir="-1" aria-label="Move ${esc(s.name)} up" ${i === 0 ? "disabled" : ""}>${I.up}</button><button class="icon-btn" data-ss-move="${id}" data-dir="1" aria-label="Move ${esc(s.name)} down" ${i === ctx.order.length - 1 ? "disabled" : ""}>${I.down}</button></span>
              </div>
              <div class="ss-you">you're ${nameHTML(my)} here${my.status ? `<span class="ss-st">· ${esc(my.status)}</span>` : ""}<button class="link-btn" data-ss-look="${id}">how you look here</button></div>
              ${sw(`squiet-${id}`, !!s.quiet, "Quiet", "No chimes, no bold, no arrival cards. Knocks still reach you.")}
              ${sw(`sown-${id}`, popped, "Own window", "A buddy list of its own, for raid night or a second screen.")}
              <div class="ss-foot"><button class="link-btn danger">Sign out of ${esc(s.name)}</button></div>
            </li>`;
          })
          .join("")}</ul>
        <button class="add-srv s-add" data-add-server>${I.plus}<span>Add a server</span></button>
      </section>`;
  }

  function rooms() {
    const list = ctx.rooms.filter((r) => ctx.srvOf(r.id) === ctx.hostServer.id);
    return `
      <section class="s-sec">
        ${head("New room")}
        <div class="s-grid2">
          ${field("Slug", `<input class="s-input mono" placeholder="porch" />`, "What people type after the #.")}
          ${field("Name", `<input class="s-input" placeholder="porch" />`, "Defaults to the slug.")}
        </div>
        ${field("Topic", `<input class="s-input" placeholder="Pull up a chair." />`, "Optional. Sits in the room's header.")}
        <div class="s-actions"><button class="pill-btn lamp">${I.plus}<span>Make the room</span></button></div>
      </section>
      <section class="s-sec">
        ${head("Your rooms, in order", "The order everyone's list shows them in.")}
        <ul class="host-rows">${list
          .map((r, i) => `<li class="hr"><span class="hash">#</span><span class="hr-name">${esc(r.name)}</span><span class="hr-sub">${esc(r.topic)}</span>
            <span class="hr-btns"><button class="icon-btn" aria-label="Move #${esc(r.name)} up" ${i === 0 ? "disabled" : ""}>${I.up}</button><button class="icon-btn" aria-label="Move #${esc(r.name)} down" ${i === list.length - 1 ? "disabled" : ""}>${I.down}</button><button class="pill-btn sm">edit</button><button class="pill-btn sm">archive</button></span></li>`)
          .join("")}</ul>
      </section>`;
  }

  function invites() {
    return `
      <section class="s-sec">
        ${head("New invite")}
        <div class="st-row"><span class="st-l">good for</span>${choices("inv-uses", [["1", "one person"], ["5", "five people"], ["any", "anyone"]], "1")}</div>
        <div class="st-row"><span class="st-l">expires after</span>${choices("inv-exp", [["day", "a day"], ["week", "a week"], ["never", "never"]], "week")}</div>
        <div class="s-actions"><button class="pill-btn lamp">${I.link}<span>Make a link</span></button></div>
      </section>
      <section class="s-sec">
        ${head("Links you have made")}
        <ul class="host-rows">
          <li class="hr"><span class="hr-code">goodco.example/i/7QK2-MX4P</span><span class="hr-sub">one person · expires in a week</span><span class="hr-btns"><button class="pill-btn sm">copy</button><button class="pill-btn sm">revoke</button></span></li>
          <li class="hr"><span class="hr-code">goodco.example/i/D8RW-2HNT</span><span class="hr-sub">anyone · never expires</span><span class="hr-btns"><button class="pill-btn sm">copy</button><button class="pill-btn sm">revoke</button></span></li>
        </ul>
      </section>`;
  }

  function people() {
    const members = ctx.people.filter((p) => ctx.srvOf(p.id) === ctx.hostServer.id);
    return `
      <section class="s-sec">
        ${head("Members")}
        <ul class="host-rows">${members
          .map((p) => `<li class="hr">${ctx.dotHTML(p, "sm")}${nameHTML(p)}<span class="hr-sub mono">${esc(p.id)}</span>${p.you ? `<span class="hr-tag">you · the host</span>` : `<span class="hr-btns"><button class="pill-btn sm">remove from the server</button></span>`}</li>`)
          .join("")}</ul>
      </section>
      <section class="s-sec">
        ${head("Removed")}
        <p class="s-empty">Nobody has been removed.</p>
        <p class="s-note">Letting somebody back in is not an undo. Their old sign-ins stay dead and the invite links they had made stay revoked, so they sign in again with their password. The username is the one they always had, and everything they wrote is still where they left it.</p>
      </section>`;
  }

  function serverSec() {
    const s = ctx.hostServer;
    const accent = s.accent ?? "amber";
    return `
      <section class="s-sec">
        ${head("Name")}
        ${field("", `<input class="s-input" value="${esc(s.name)}" aria-label="Server name" />`, "What the list says, and what an invite link tells a stranger.")}
      </section>
      <section class="s-sec">
        ${head("Accent", "Its color in people's lists: the stripe beside its name, and along its windows.")}
        <div class="accent-grid">${PALETTE.map((k) => `<button class="acc ${k === accent ? "on" : ""}" aria-pressed="${k === accent}" style="--c:${color(k)}"><i></i>${k}</button>`).join("")}</div>
        <div class="s-actions"><button class="pill-btn lamp" disabled>Save</button></div>
      </section>`;
  }

  const RENDER = { profile, appearance, windows, sound, notifications, account, servers, rooms, invites, people, server: serverSec };

  // --- the window ----------------------------------------------------------

  function body() {
    const [title, lead] = TITLES[section];
    return `
      <div class="set">
        <nav class="set-nav" aria-label="Settings sections">${SECTIONS()
          .map((x) =>
            x.group
              ? `<div class="sn-group ${x.sub ? "has-sub" : ""}">${esc(x.group)}${x.sub ? `<span class="sn-sub" title="${esc(x.sub)}">${esc(x.sub)}</span>` : ""}</div>`
              : `<button class="sn" data-sec="${x.key}" ${x.key === section ? 'aria-current="page"' : ""} title="${x.label}">${x.icon}<span>${x.label}</span></button>`,
          )
          .join("")}</nav>
        <div class="set-main">
          <header class="set-head"><h2>${title}</h2><p>${lead}</p></header>
          <div class="set-body">${RENDER[section]()}</div>
        </div>
      </div>`;
  }

  function paint() {
    const win = ctx.wins.get(KEY);
    if (!win) return;
    const main = win.body.querySelector(".set-main");
    const top = main?.scrollTop ?? 0;
    const same = main?.dataset.shown === section;
    win.body.innerHTML = body();
    const m = win.body.querySelector(".set-main");
    m.dataset.shown = section;
    if (same) m.scrollTop = top;
  }

  function open(which) {
    if (which) section = which;
    if (!ctx.MULTI && section === "servers") section = "profile";
    const existing = ctx.wins.get(KEY);
    if (existing) {
      paint();
      ctx.focusWin(KEY);
      return existing;
    }
    const { w, h } = ctx.deskRect();
    const ww = Math.min(820, w - 80);
    const wh = Math.min(700, h - 60);
    const win = ctx.openWindow(KEY, {
      title: `${I.gear.replace("<svg", '<svg width="15" height="15" style="color:var(--ink-3)"')}<span>Settings</span>`,
      label: "Settings",
      kind: "settings",
      x: Math.max(20, Math.round((w - ww) / 2) + 90), y: Math.max(16, Math.round((h - wh) / 2) - 6), w: ww, h: wh,
      build(win) {
        win.body.addEventListener("click", onClick);
        win.body.addEventListener("change", onChange);
      },
    });
    paint();
    ctx.syncGear(true);
    return win;
  }

  function close() {
    ctx.closeWindow(KEY);
  }

  // --- what the controls do ------------------------------------------------

  function onClick(e) {
    const nav = e.target.closest(".sn[data-sec]");
    if (nav) {
      section = nav.dataset.sec;
      paint();
      ctx.wins.get(KEY)?.body.querySelector(`[data-sec="${section}"]`)?.focus();
      return;
    }
    const s = e.target.closest("[data-sw]");
    if (s) return flip(s.dataset.sw);
    const c = e.target.closest("[data-choice] button");
    if (c) return choose(c.closest("[data-choice]").dataset.choice, c.dataset.v);
    const sw_ = e.target.closest("[data-swatch] button");
    if (sw_) {
      draft[sw_.closest("[data-swatch]").dataset.swatch] = sw_.getAttribute("aria-label");
      return paint();
    }
    if (e.target.closest("[data-italic]")) {
      draft.italic = !draft.italic;
      return paint();
    }
    const look = e.target.closest("[data-look]");
    if (look) {
      if (look.dataset.look === "reset") draft = null;
      else saveLook();
      return paint();
    }
    const theme = e.target.closest("[data-theme-pick]");
    if (theme) {
      state.theme = theme.dataset.themePick;
      return paint();
    }
    const play = e.target.closest("[data-play]");
    if (play) return ctx.preview(play.dataset.play);
    const nt = e.target.closest("[data-nt]");
    if (nt) {
      state.notifyOpen = state.notifyOpen === nt.dataset.nt ? null : nt.dataset.nt;
      return paint();
    }
    if (e.target.closest("[data-export]")) {
      state.exportPhase = "working";
      paint();
      setTimeout(() => {
        state.exportPhase = "ready";
        if (section === "account") paint();
      }, 1600);
      return;
    }
    const mv = e.target.closest("[data-ss-move]");
    if (mv) {
      const id = mv.dataset.ssMove;
      const i = ctx.order.indexOf(id);
      const j = i + Number(mv.dataset.dir);
      if (j < 0 || j >= ctx.order.length) return;
      [ctx.order[i], ctx.order[j]] = [ctx.order[j], ctx.order[i]];
      ctx.renderList();
      return paint();
    }
    const lk = e.target.closest("[data-ss-look]");
    if (lk && lk.dataset.ssLook === ctx.hostServer.id) {
      section = "profile";
      return paint();
    }
    if (e.target.closest("[data-add-server]")) return ctx.openAddServer();
  }

  function onChange(e) {
    const t = e.target;
    if (t.name === "conv-mode") return ctx.setMode(t.value);
    if (t.name === "close-list") state.closeList = t.value;
    if (t.dataset.sel === "scale") {
      state.scale = Number(t.value);
      return paint();
    }
    if (t.dataset.sel === "quietFrom" || t.dataset.sel === "quietUntil") {
      state[t.dataset.sel] = Number(t.value);
      return paint();
    }
    if (t.dataset.ntEvery) {
      const r = (state.notify[t.dataset.ntEvery] ??= { everywhere: false, rooms: [] });
      r.everywhere = t.checked;
      return paint();
    }
    if (t.dataset.ntRoom) {
      const r = (state.notify[t.dataset.ntRoom] ??= { everywhere: false, rooms: [] });
      r.rooms = t.checked ? [...new Set([...r.rooms, t.value])] : r.rooms.filter((x) => x !== t.value);
      return paint();
    }
  }

  function flip(id) {
    if (id === "plain") {
      state.plain = !state.plain;
      ctx.setPlain(state.plain);
    } else if (id === "cards") ctx.setCards(!ctx.getCards());
    else if (id === "door") {
      ctx.setDoor(!ctx.getDoor());
      if (ctx.getDoor()) ctx.preview("door");
    } else if (id.startsWith("chime-")) {
      const k = id.slice(6);
      state.chimes[k] = !state.chimes[k];
    } else if (id.startsWith("squiet-")) {
      const sid = id.slice(7);
      ctx.setQuiet(sid, !ctx.srvById[sid].quiet);
    } else if (id.startsWith("sown-")) {
      const sid = id.slice(5);
      ctx.poppedOut.has(sid) ? ctx.popIn(sid) : ctx.popOut(sid);
      ctx.focusWin(KEY);
    } else if (id === "ptt") state.pushToTalk = !state.pushToTalk;
    else if (id in state) state[id] = !state[id];
    paint();
  }

  function choose(group, v) {
    if (group === "font") draft.font = v;
    else if (group === "weight") draft.weight = Number(v);
    else if (group === "fill") draft.gradient = v === "two";
    else if (group === "effect") draft.effect = v;
    else if (group === "msgFont") draft.msgFont = v || null;
    paint();
  }

  // Your look, saved: your name changes in the list and in every conversation.
  function saveLook() {
    const me = ctx.me;
    Object.assign(me, {
      font: draft.font,
      weight: draft.weight,
      style: draft.italic ? "italic" : "normal",
      color: draft.from,
      gradient: draft.gradient ? [draft.from, draft.to] : undefined,
      effect: draft.effect,
      msgFont: draft.msgFont,
      size: undefined,
    });
    draft = null;
    ctx.refreshAll();
  }

  return {
    open,
    close,
    paint,
    isOpen: () => ctx.wins.has(KEY),
    show: (which) => {
      section = which;
      paint();
    },
    KEY,
  };
}
