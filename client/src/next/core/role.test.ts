import { describe, expect, it } from "vitest";
import { windowRole } from "./role";

describe("which window a page is", () => {
  it("is the list only in the main window, or in a plain browser", () => {
    expect(windowRole("", "main")).toBe("list");
    expect(windowRole("", null)).toBe("list");
  });

  it("never makes a second owner: any other window without a role shows nothing", () => {
    expect(windowRole("", "chat")).toBe("none");
    expect(windowRole("", "settings")).toBe("none");
    expect(windowRole("?window=list", "chat-1")).toBe("none");
  });

  it("is Settings only in the window the shell made for it", () => {
    expect(windowRole("?window=settings", "settings")).toBe("settings");
    expect(windowRole("?window=settings&section=invites", "settings")).toBe("settings");
    expect(windowRole("?window=settings", "main")).toBe("none");
    expect(windowRole("?window=settings", "chat")).toBe("none");
    // Search and Media: only in their own windows.
    expect(windowRole("?window=search", "search")).toBe("search");
    expect(windowRole("?window=media", "media")).toBe("media");
    expect(windowRole("?window=search", "main")).toBe("none");
    expect(windowRole("?window=media", "search")).toBe("none");
  });

  it("is the chat window where the shell asked for one, and never in main", () => {
    expect(windowRole("?window=chat&server=https%3A%2F%2Fhome.example&room=r-general", "chat")).toBe("chat");
    expect(windowRole("?window=chat&single=1", "chat-5f1e")).toBe("chat");
    expect(windowRole("?window=chat", "main")).toBe("none");
  });
});
