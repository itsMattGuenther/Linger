// A little life for the prototypes: people arrive, type, talk in voice and
// answer you, so each design can show how it feels when nobody is typing and
// when somebody is. Screenshots pass `?still` and get a frozen moment instead.

import { people, messages, NOW, byId } from "./data.js";

export const still = new URLSearchParams(location.search).has("still");

export function createLife() {
  const started = Date.now();
  const now = () => new Date(NOW.getTime() + (still ? 0 : Date.now() - started));
  const state = {
    people,
    messages,
    typing: {}, // roomId -> Set(personId)
    speaking: new Set(still ? ["eli"] : []),
    knocked: null,
  };
  const subs = new Set();
  const emit = (type, detail = {}) => subs.forEach((fn) => fn(type, detail));
  const timers = [];
  const later = (s, fn) => timers.push(setTimeout(fn, s * 1000));

  function typing(roomId, who, on) {
    const set = (state.typing[roomId] ??= new Set());
    on ? set.add(who) : set.delete(who);
    emit("typing", { roomId, who, on });
  }

  function post(roomId, author, text, extra = {}) {
    typing(roomId, author, false);
    const msg = { id: `live${Math.random().toString(36).slice(2, 8)}`, author, time: now(), text, live: true, ...extra };
    (state.messages[roomId] ??= []).push(msg);
    emit("message", { roomId, msg });
    return msg;
  }

  function move(id, presence, room = null, extra = {}) {
    const p = byId[id];
    const from = p.presence;
    Object.assign(p, { presence, room }, extra);
    emit("presence", { person: p, from });
  }

  const replies = {
    question: ["good question", "hmm. yes?", "10 works for me", "I'm in if there's coffee"],
    plain: ["ha, same", "love that", "🙌", "ok that's lovely", "noted 🌧️", "this is the way"],
  };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  const api = {
    state,
    now,
    on(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    send(roomId, text) {
      const msg = post(roomId, "matt", text);
      if (still) return msg;
      const room = roomId.startsWith("dm-") ? null : roomId;
      const others = room
        ? people.filter((p) => !p.you && p.presence === "in_room" && p.room === room)
        : [byId[roomId.split("-")[1]]].filter(Boolean);
      const who = others.length ? pick(others).id : null;
      if (who) {
        later(1.2, () => typing(roomId, who, true));
        later(3.4, () => post(roomId, who, pick(text.includes("?") ? replies.question : replies.plain)));
      }
      return msg;
    },
    knock(id) {
      state.knocked = id;
      emit("knock", { id });
      later(3, () => {
        if (state.knocked === id) state.knocked = null;
        emit("knock-reset", { id });
      });
    },
    setVoice(id, on) {
      byId[id].voice = on;
      if (!on) state.speaking.delete(id);
      emit("voice", { id, on });
    },
    setAway(id, message) {
      const p = byId[id];
      if (message) Object.assign(p, { presence: "away", away: message, since: "now", room: null, voice: false });
      else Object.assign(p, { presence: "in_room", away: undefined, room: p.room ?? "general" });
      emit("presence", { person: p });
    },
    setStatus(id, text) {
      byId[id].status = text;
      emit("status", { id });
    },
    enter(roomId) {
      const me = people.find((p) => p.you);
      if (!roomId.startsWith("dm-")) move(me.id, "in_room", roomId);
      emit("enter", { roomId });
    },
    start() {
      if (still) return;
      later(3, () => typing("general", "jules", true));
      later(6, () => post("general", "jules", "ok the rain playlist is doing something to me"));
      later(10, () => move("callie", "in_room", "general"));
      later(17, () => typing("listening-room", "dave", true));
      later(20, () => post("listening-room", "dave", "flipping it. side two, for real this time"));
      later(26, () => move("sam", "around", null, { away: undefined, since: undefined }));
      later(31, () => typing("general", "callie", true));
      later(35, () => post("general", "callie", "hi hello, I have arrived. what's the rain playlist"));
      later(44, () => move("sam", "in_room", "weekend-plans"));
      later(46, () => typing("weekend-plans", "sam", true));
      later(50, () => post("weekend-plans", "sam", "10. the ducks sleep in"));
      // Voice: somebody is usually talking, rarely two at once.
      const talk = () => {
        const on = people.filter((p) => p.voice);
        state.speaking = new Set(on.filter(() => Math.random() < 0.45).slice(0, 2).map((p) => p.id));
        emit("speaking", {});
        timers.push(setTimeout(talk, 700 + Math.random() * 1800));
      };
      talk();
    },
  };
  return api;
}
