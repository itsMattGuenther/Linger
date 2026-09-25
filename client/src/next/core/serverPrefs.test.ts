import { describe, expect, it } from "vitest";
import { inOrder, loadServerPrefs, type PrefsStore, saveServerPrefs } from "./serverPrefs";

function memory(): PrefsStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

const home = { baseUrl: "https://home.example" };
const guild = { baseUrl: "https://guild.example" };
const casa = { baseUrl: "https://casa.example" };

describe("your servers' order and Quiet, on this computer", () => {
  it("keeps what you chose, and starts with nothing chosen", () => {
    const store = memory();
    expect(loadServerPrefs(store)).toEqual({ order: [], quiet: [] });
    saveServerPrefs(store, { order: [guild.baseUrl, home.baseUrl], quiet: [casa.baseUrl] });
    expect(loadServerPrefs(store)).toEqual({ order: [guild.baseUrl, home.baseUrl], quiet: [casa.baseUrl] });
  });

  it("orders servers as you placed them, with new ones after, in the order they came", () => {
    expect(inOrder([home, guild, casa], [])).toEqual([home, guild, casa]);
    expect(inOrder([home, guild, casa], [casa.baseUrl, home.baseUrl])).toEqual([casa, home, guild]);
    // A server you've signed out of stays in the order without harm.
    expect(inOrder([home, guild], ["https://gone.example", guild.baseUrl])).toEqual([guild, home]);
  });

  it("throws away anything malformed, and a storage that refuses", () => {
    const store = memory();
    for (const junk of ["{", "[]", "1", '{"order":"x","quiet":[1,"y"]}']) {
      store.items.set("linger.next.servers", junk);
      const prefs = loadServerPrefs(store);
      expect(prefs.order.every((item) => typeof item === "string")).toBe(true);
      expect(prefs.quiet.every((item) => typeof item === "string")).toBe(true);
    }
    const refusing: PrefsStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadServerPrefs(refusing)).toEqual({ order: [], quiet: [] });
    expect(() => saveServerPrefs(refusing, { order: [], quiet: [] })).not.toThrow();
  });
});
