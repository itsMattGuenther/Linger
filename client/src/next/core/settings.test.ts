import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NotifyRule } from "../../generated/NotifyRule";
import type { Room } from "../../generated/Room";
import {
  CHIMES,
  deviceOptions,
  draftSlug,
  HEADINGS,
  INVITE_EXPIRY,
  INVITE_USES,
  isTitleCase,
  leftOf,
  nameTyped,
  NEW_ROOM_DRAFT,
  quietChoices,
  ROOM_SLUG_MAX,
  roomSlugOf,
  ruleSummary,
  SECTION_LABELS,
  sectionLabel,
  sectionLead,
  type SettingsScope,
  settingsEntries,
  settingsKeys,
  showable,
  slugLeft,
  slugNeeded,
  slugTyped,
  SYSTEM_DEFAULT,
} from "./settings";

const MEMBER: SettingsScope = { hosting: null, severalServers: false, windows: true };
const HOST: SettingsScope = { hosting: "The Good Company", severalServers: false, windows: true };

function room(id: string, name: string): Room {
  return { id, slug: name, name, topic: null, kind: "room", member_ids: null, position: 0, archived_at: null, last_message_id: null };
}

describe("the Settings sidebar", () => {
  it("shows a member the six everyday sections, in the design's order", () => {
    expect(settingsKeys(MEMBER)).toEqual(["profile", "appearance", "windows", "sound", "notifications", "account"]);
  });

  it("adds Hosting under the server's name only for the host", () => {
    expect(settingsKeys(HOST).slice(-4)).toEqual(["rooms", "invites", "people", "server"]);
    expect(settingsEntries(HOST)).toContainEqual({ kind: "group", label: "Hosting", sub: "The Good Company" });
    expect(settingsEntries(MEMBER).some((entry) => entry.kind === "group" && entry.label === "Hosting")).toBe(false);
  });

  it("adds Servers only with more than one, and drops Windows when there's nothing to choose", () => {
    expect(settingsKeys({ ...MEMBER, severalServers: true })).toContain("servers");
    expect(settingsKeys(MEMBER)).not.toContain("servers");
    expect(settingsKeys({ ...MEMBER, windows: false })).not.toContain("windows");
  });

  it("leaves the phone without Windows and Notifications, and keeps the host's sections (SPEC §4.15)", () => {
    const phone = { ...HOST, phone: true };
    expect(settingsKeys(phone)).toEqual(["profile", "appearance", "sound", "account", "rooms", "invites", "people", "server"]);
    expect(showable(phone, "notifications")).toBe("profile");
  });

  it("calls Sound just that on the phone, which is text only for now", () => {
    expect(sectionLabel("sound", { ...MEMBER, phone: true })).toBe("Sound");
    expect(sectionLabel("sound", MEMBER)).toBe(SECTION_LABELS.sound);
    expect(sectionLead("sound", { ...MEMBER, phone: true })).not.toMatch(/voice|notification/i);
    expect(sectionLead("appearance", { ...MEMBER, phone: true })).toContain("this phone");
    expect(sectionLead("account", { ...MEMBER, phone: true })).not.toContain("updates");
  });

  it("opens on the section asked for when it exists here, and on Profile when not", () => {
    expect(showable(HOST, "invites")).toBe("invites");
    expect(showable(MEMBER, "invites")).toBe("profile");
    expect(showable(MEMBER, "servers")).toBe("profile");
  });
});

describe("the Settings copy", () => {
  const labels = [
    ...Object.values(SECTION_LABELS),
    ...Object.values(HEADINGS),
    ...settingsEntries({ hosting: "x", severalServers: true, windows: true }).flatMap((entry) => (entry.kind === "group" ? [entry.label] : [])),
  ];

  it("writes headings and navigation labels in title case (#90)", () => {
    expect(labels.filter((label) => !isTitleCase(label))).toEqual([]);
    // The check itself catches the mistakes it exists for.
    expect(isTitleCase("Who you are")).toBe(false);
    expect(isTitleCase("Make Yourself At Home")).toBe(false);
    expect(isTitleCase("Make Yourself at Home")).toBe(true);
  });

  it("uses the product's words (SPEC §1)", () => {
    const leads = settingsKeys({ hosting: "x", severalServers: true, windows: true }).map((key) =>
      sectionLead(key, { hosting: "x", severalServers: true, windows: true }),
    );
    const everything = [...labels, ...leads, ...CHIMES.flatMap((chime) => [chime.label, chime.hint])].join(" ").toLowerCase();
    // Words the copy must never use:
    for (const word of ["channel", "stoop", "shelf", "kick", "ban ", "@everyone", "@here", "encrypt", "unread"]) { // never said
      expect(everything, word).not.toContain(word);
    }
  });

  it("names every chime, with room messages and the door chime off by default", () => {
    expect(CHIMES.map((chime) => chime.category)).toEqual(["voice", "controls", "dms", "rooms", "knocks", "door"]);
    expect(CHIMES.find((chime) => chime.category === "rooms")?.hint).toMatch(/off by default/i);
    expect(CHIMES.find((chime) => chime.category === "door")?.hint).toMatch(/off by default/i);
  });

  it("offers invites for one, five or anyone, lasting a day, a week or for good (HOST-5)", () => {
    expect(INVITE_USES.map((choice) => choice.uses)).toEqual([1, 5, null]);
    expect(INVITE_EXPIRY.map((choice) => choice.hours)).toEqual([24, 168, null]);
  });
});

describe("quiet hours", () => {
  it("offers every half hour, and keeps a saved time that isn't on one", () => {
    expect(quietChoices(22 * 60)).toHaveLength(48);
    expect(quietChoices(22 * 60 + 15)).toHaveLength(49);
    expect(quietChoices(22 * 60 + 15)).toContain(22 * 60 + 15);
    const choices = quietChoices(95);
    expect([...choices].sort((a, b) => a - b)).toEqual(choices);
  });
});

describe("voice devices", () => {
  it("puts the system default first, naming what it is now", () => {
    expect(deviceOptions(["USB mic"], "Built-in", null)).toEqual([
      { value: SYSTEM_DEFAULT, label: "System default (Built-in)" },
      { value: "USB mic", label: "USB mic" },
    ]);
    expect(deviceOptions([], null, null)[0]?.label).toBe("System default");
  });

  it("keeps a remembered device that isn't plugged in, and says so", () => {
    expect(deviceOptions(["Built-in"], "Built-in", "Headset").at(-1)).toEqual({ value: "Headset", label: "Headset (not plugged in)" });
    expect(deviceOptions(["Headset"], "Built-in", "Headset")).toHaveLength(2);
  });
});

describe("notify rules, in words", () => {
  const rooms = [room("r-general", "general"), room("r-listening", "listening-room")];
  it("says everywhere, the rooms by name, or only mentions", () => {
    const rules: NotifyRule[] = [
      { target_user_id: "u-eli", room_id: null },
      { target_user_id: "u-eli", room_id: "r-general" },
      { target_user_id: "u-jules", room_id: "r-listening" },
      { target_user_id: "u-jules", room_id: "r-general" },
    ];
    expect(ruleSummary(rules, "u-eli", rooms)).toBe("everywhere");
    expect(ruleSummary(rules, "u-jules", rooms)).toBe("#general, #listening-room");
    expect(ruleSummary(rules, "u-sam", rooms)).toBe("only mentions");
  });
});

describe("text limits", () => {
  it("counts down near the limit and says how far over, never before", () => {
    expect(leftOf("hello", 240, 40)).toBeNull();
    expect(leftOf("x".repeat(210), 240, 40)).toBe("30 left");
    expect(leftOf("x".repeat(245), 240, 40)).toBe("5 over");
    // Emoji count once, as the server counts characters.
    expect(leftOf("🌙".repeat(240), 240, 40)).toBe("0 left");
  });
});

describe("a new room's slug, from its name (HOST-1, #221)", () => {
  /** What the server takes: `linger-core::limits::ROOM_SLUG_PATTERN`, read from the source below. */
  const TAKES = /^[a-z0-9-]{1,32}$/;

  it("agrees with the server's rule, read from linger-core", () => {
    const limits = readFileSync(new URL("../../../../crates/linger-core/src/limits.rs", import.meta.url), "utf8");
    expect(limits).toContain(`pub const ROOM_SLUG_PATTERN: &str = "${TAKES.source}";`);
    expect(TAKES.source).toContain(`{1,${ROOM_SLUG_MAX}}`);
  });

  it("lowers the case and turns spaces and punctuation into single dashes", () => {
    expect(roomSlugOf("Screenshots and Clips")).toBe("screenshots-and-clips");
    expect(roomSlugOf("porch")).toBe("porch");
    expect(roomSlugOf("Rock & Roll!!")).toBe("rock-roll");
    expect(roomSlugOf("Q&A: Fridays / 8pm")).toBe("q-a-fridays-8pm");
    expect(roomSlugOf("v1.2 release_notes")).toBe("v1-2-release-notes");
    expect(roomSlugOf("Porch \t Light\n")).toBe("porch-light");
    expect(roomSlugOf("Pre-game — warm-up")).toBe("pre-game-warm-up");
    expect(roomSlugOf("1+1=2, 100%")).toBe("1-1-2-100");
  });

  it("never starts or ends with a dash", () => {
    expect(roomSlugOf("  Porch  ")).toBe("porch");
    expect(roomSlugOf("--porch--")).toBe("porch");
    expect(roomSlugOf("(the porch)")).toBe("the-porch");
    expect(roomSlugOf("...!?")).toBe("");
  });

  it("joins a word across its apostrophe", () => {
    expect(roomSlugOf("Matt's Room")).toBe("matts-room");
    expect(roomSlugOf("Matt’s room, don’t knock")).toBe("matts-room-dont-knock");
  });

  it("drops accents to their plain letters", () => {
    expect(roomSlugOf("Café")).toBe("cafe");
    expect(roomSlugOf("Crème Brûlée")).toBe("creme-brulee");
    expect(roomSlugOf("Ñandú Señor")).toBe("nandu-senor");
    expect(roomSlugOf("Łódź, Smørrebrød")).toBe("lodz-smorrebrod");
    expect(roomSlugOf("Straße Æsir Œuvre")).toBe("strasse-aesir-oeuvre");
    // Full-width letters and ligatures have plain forms too.
    expect(roomSlugOf("ＰＯＲＣＨ ﬁre")).toBe("porch-fire");
  });

  it("leaves out what has no plain form, like emoji and other scripts", () => {
    expect(roomSlugOf("🎮 Game Night 🎮")).toBe("game-night");
    expect(roomSlugOf("Clips 📸")).toBe("clips");
    expect(roomSlugOf("Tokyo 東京 trip")).toBe("tokyo-trip");
    expect(roomSlugOf("👨‍👩‍👧 family 👍🏽")).toBe("family");
    expect(roomSlugOf("Game🎮Night")).toBe("gamenight");
    expect(roomSlugOf("Linger™ © 🇫🇷")).toBe("linger");
  });

  it("gives nothing, rather than inventing a slug, when the name has nothing to use", () => {
    expect(roomSlugOf("")).toBe("");
    expect(roomSlugOf("   ")).toBe("");
    expect(roomSlugOf("🎮🎮🎮")).toBe("");
    expect(roomSlugOf("日本語")).toBe("");
    expect(roomSlugOf("Ελληνικά")).toBe("");
  });

  it("stops at the server's length, on a word's end when that keeps at least half", () => {
    // 38 characters: the last whole word that fits ends at 30.
    expect(roomSlugOf("Screenshots and clips from the weekend")).toBe("screenshots-and-clips-from-the");
    // A word ending exactly on the limit is kept whole.
    expect(roomSlugOf(`${"a".repeat(32)} more`)).toBe("a".repeat(32));
    expect(roomSlugOf(`${"a".repeat(20)} ${"b".repeat(11)} c`)).toBe(`${"a".repeat(20)}-${"b".repeat(11)}`);
    // One long word is cut at the limit.
    expect(roomSlugOf("a".repeat(40))).toBe("a".repeat(32));
    // A short first word before a long one: the cut keeps more than the word would.
    expect(roomSlugOf("The Supercalifragilisticexpialidocious Room")).toBe("the-supercalifragilisticexpialid");
  });

  it("always gives something the server takes, or nothing, and gives the same again from its own answer", () => {
    // A fixed spread of awkward characters, mixed at random from a fixed seed.
    const pool = [..."aZé ß-_.'’!🎮👍🏽東京ＡﬁÆø ‍\t—+$#%1234567890", "Ł", "İ", "ı", "ẞ", "#️⃣", "🇫🇷"];
    let seed = 221;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 2000; run += 1) {
      const name = Array.from({ length: Math.floor(next() * 60) }, () => pool[Math.floor(next() * pool.length)]).join("");
      const slug = roomSlugOf(name);
      expect(slug === "" || TAKES.test(slug), JSON.stringify(name)).toBe(true);
      expect(slug, JSON.stringify(name)).not.toMatch(/^-|-$|--/);
      expect(roomSlugOf(slug), JSON.stringify(name)).toBe(slug);
    }
  });
});

describe("the New Room form's slug, as the name is typed (#221)", () => {
  const typed = (...names: string[]) => names.reduce(nameTyped, NEW_ROOM_DRAFT);

  it("follows the name", () => {
    const draft = typed("S", "Sc", "Screenshots and Clips");
    expect(draft.slug).toBe("screenshots-and-clips");
    expect(draftSlug(draft)).toBe("screenshots-and-clips");
  });

  it("stops following once it's typed in itself", () => {
    const edited = slugTyped(typed("Screenshots and Clips"), "clips");
    const renamed = nameTyped(edited, "Screenshots, Clips and Memes");
    expect(renamed.slug).toBe("clips");
    expect(draftSlug(renamed)).toBe("clips");
  });

  it("follows again once it's emptied: from the next change to the name, or on leaving the box", () => {
    const emptied = slugTyped(slugTyped(typed("Screenshots and Clips"), "clips"), "");
    expect(emptied.slug).toBe("");
    // Emptied, it says what it will be sent as.
    expect(draftSlug(emptied)).toBe("screenshots-and-clips");
    expect(nameTyped(emptied, "Clips and Memes").slug).toBe("clips-and-memes");
    expect(slugLeft(emptied).slug).toBe("screenshots-and-clips");
    // Leaving a slug of your own keeps it.
    expect(slugLeft(slugTyped(emptied, "memes")).slug).toBe("memes");
    // Spaces alone are as good as empty.
    expect(slugTyped(emptied, "  ").follows).toBe(true);
  });

  it("asks for a slug when the name has words but none it can use, and only then", () => {
    expect(slugNeeded(typed("🎮🎮"))).toBe(true);
    expect(draftSlug(typed("🎮🎮"))).toBe("");
    expect(slugNeeded(NEW_ROOM_DRAFT)).toBe(false);
    expect(slugNeeded(typed("🎮 night"))).toBe(false);
    expect(slugNeeded(slugTyped(typed("🎮🎮"), "games"))).toBe(false);
  });
});
