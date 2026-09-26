import { describe, expect, it } from "vitest";
import type { NotifyRule } from "../../generated/NotifyRule";
import type { Room } from "../../generated/Room";
import {
  CHIMES,
  deviceOptions,
  HEADINGS,
  INVITE_EXPIRY,
  INVITE_USES,
  isTitleCase,
  leftOf,
  quietChoices,
  ruleSummary,
  SECTION_LABELS,
  sectionLead,
  type SettingsScope,
  settingsEntries,
  settingsKeys,
  showable,
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
