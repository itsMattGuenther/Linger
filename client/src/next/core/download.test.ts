import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The shell as the page meets it: whether there is one, every command asked
// of it, and the opener that hands an address to the browser.
const shell = vi.hoisted(() => ({
  here: true,
  calls: [] as { cmd: string; args: unknown }[],
  refuse: false,
  opened: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => shell.here,
  invoke: async (cmd: string, args?: unknown) => {
    shell.calls.push({ cmd, args });
    if (shell.refuse) throw new Error("Couldn't get the file.");
    return null;
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: async (url: string) => {
    shell.opened.push(url);
  },
}));

import { downloadFailedLine, downloadFile, downloadWay, gettingLine } from "./download";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";
const SIGNED = "https://cdn.good-company.example/objects/0190/report.pdf?signature=a%2Fb&part=1";

/** The page as one engine shows it: its address, and what the engine says it is. */
function pageOn(search: string, userAgent: string, maxTouchPoints = 5) {
  vi.stubGlobal("window", { location: { search } });
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints });
}

beforeEach(() => {
  shell.here = true;
  shell.calls = [];
  shell.refuse = false;
  shell.opened = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("where a download goes (#703)", () => {
  it("is the share sheet only in the iPhone app", () => {
    expect(downloadWay(true, true)).toBe("sheet");
    // A page in a browser on an iPhone has no shell to fetch it.
    expect(downloadWay(true, false)).toBe("browser");
    expect(downloadWay(false, true)).toBe("browser");
    expect(downloadWay(false, false)).toBe("browser");
  });

  it("goes to the shell's share sheet in the iPhone app, with the address exactly as it was and the file's name", async () => {
    pageOn("?shell=phone", IPHONE);
    await downloadFile(SIGNED, "report.pdf");
    expect(shell.calls).toEqual([{ cmd: "phone_save", args: { url: SIGNED, name: "report.pdf" } }]);
    expect(shell.opened).toEqual([]);
  });

  it("goes to the browser on Android, on a computer, and in a browser on an iPhone", async () => {
    pageOn("?shell=phone", ANDROID);
    await downloadFile(SIGNED, "report.pdf");
    pageOn("", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)", 0);
    await downloadFile(SIGNED, "report.pdf");
    pageOn("", IPHONE);
    shell.here = false;
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { location: { search: "" }, open });
    await downloadFile(SIGNED, "report.pdf");
    expect(shell.opened).toEqual([SIGNED, SIGNED]);
    expect(open).toHaveBeenCalledWith(SIGNED, "_blank", "noreferrer");
    expect(shell.calls).toEqual([]);
  });

  it.each(["file:///var/mobile/secret.db", "javascript:alert(1)", "data:text/html,hi", "linger://join/abc", "/objects/report.pdf"])(
    "never asks the shell for %s",
    async (address) => {
      await expect(downloadFile(address, "x", "sheet")).rejects.toThrow();
      expect(shell.calls).toEqual([]);
    },
  );

  it("passes on the shell's refusal, so the card can offer another go", async () => {
    shell.refuse = true;
    await expect(downloadFile(SIGNED, "report.pdf", "sheet")).rejects.toThrow();
  });
});

describe("what Media says about a download (#703)", () => {
  it("says it's on its way, and when it didn't come, where it was going", () => {
    expect(gettingLine("report.pdf")).toBe("Getting report.pdf…");
    expect(downloadFailedLine("sheet", "report.pdf")).toBe("Couldn't get report.pdf. Try again, or open its message for its address.");
    expect(downloadFailedLine("browser", "report.pdf")).toBe("Couldn't open your browser for report.pdf. Try again.");
  });
});
