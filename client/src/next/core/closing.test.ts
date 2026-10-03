import { describe, expect, it } from "vitest";
import { desktopOf, firstTimeInTray, loadCloseList, saveCloseList, trayNotice } from "./closing";

function memory() {
  const held = new Map<string, string>();
  return { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => void held.set(key, value) };
}

describe("what closing the list does", () => {
  it("keeps Linger in the tray unless told to quit, and remembers the choice", () => {
    const store = memory();
    expect(loadCloseList(store)).toBe("tray");
    expect(loadCloseList(null)).toBe("tray");
    saveCloseList(store, "quit");
    expect(loadCloseList(store)).toBe("quit");
    saveCloseList(store, "tray");
    expect(loadCloseList(store)).toBe("tray");
  });

  it("reads anything else as the tray, and survives storage that refuses", () => {
    const broken = {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    expect(loadCloseList(broken)).toBe("tray");
    expect(() => saveCloseList(broken, "quit")).not.toThrow();
    const odd = memory();
    odd.setItem("linger.next.closeList", "sideways");
    expect(loadCloseList(odd)).toBe("tray");
  });
});

describe("the first time the list goes to the tray (#400)", () => {
  it("says so once ever on a computer", () => {
    const store = memory();
    expect(firstTimeInTray(store)).toBe(true);
    expect(firstTimeInTray(store)).toBe(false);
    expect(firstTimeInTray(store)).toBe(false);
  });

  it("stays quiet when storage refuses, rather than saying it on every close", () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("no storage");
      },
    };
    expect(firstTimeInTray(broken)).toBe(false);
    expect(firstTimeInTray(null)).toBe(false);
  });

  it("says where the icon is on each desktop, and how to quit", () => {
    expect(trayNotice("windows", null)).toEqual({ title: "Linger is still running", body: "It's by the clock (under ^). Quit Linger from there." });
    expect(trayNotice("mac", null).body).toBe("It's in the menu bar, at the top of the screen. Quit Linger from there.");
    expect(trayNotice("other", null).body).toBe("It's in your system tray. Quit Linger from there.");
  });

  it("adds that you're still in voice, in a room or with the people in a DM", () => {
    expect(trayNotice("windows", { where: "#general", room: true }).body).toBe("It's by the clock (under ^). Quit Linger from there. You're still in voice in #general.");
    expect(trayNotice("other", { where: "Eggnog", room: false }).body).toBe("It's in your system tray. Quit Linger from there. You're still in voice with Eggnog.");
  });

  it("tells the desktops apart by the engine's user agent", () => {
    expect(desktopOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")).toBe("windows");
    expect(desktopOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("mac");
    expect(desktopOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("other");
  });
});
