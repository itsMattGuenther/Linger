import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page's half of sharing through the shell (#360, T-1907): the shell's
// own half is `src-tauri/src/screen_shell.rs`. Tauri's calls are stood in for.
const shell = vi.hoisted(() => ({
  tauri: true,
  calls: [] as { command: string; args: unknown }[],
  answer: (_command: string, _args: unknown): Promise<unknown> => Promise.resolve(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => shell.tauri,
  invoke: (command: string, args?: unknown) => {
    shell.calls.push({ command, args });
    return shell.answer(command, args);
  },
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));

const { captureInShell, forgetShell, sharesThroughShell, shellPlays, shellShares } = await import("./shell");

const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

beforeEach(() => {
  shell.tauri = true;
  shell.calls = [];
  shell.answer = () => Promise.resolve(undefined);
  vi.stubGlobal("navigator", { userAgent: LINUX });
  forgetShell();
});
afterEach(() => vi.unstubAllGlobals());

interface Started {
  fps: number;
  shown: boolean;
  frames: { onmessage: (message: unknown) => void };
  pictures: { onmessage: (message: unknown) => void };
  says: { onmessage: (message: unknown) => void };
}

function started(): Started {
  const start = shell.calls.find((call) => call.command === "screen_share_start");
  if (!start) throw new Error("not started");
  return start.args as Started;
}

describe("sharing through the shell", () => {
  it("is the Linux app's way, and only the app's: not a browser, Windows or an Android phone", () => {
    expect(sharesThroughShell()).toBe(true);
    shell.tauri = false;
    expect(sharesThroughShell()).toBe(false);
    shell.tauri = true;
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0" });
    expect(sharesThroughShell()).toBe(false);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 11 Pro) Chrome/141.0 Mobile" });
    expect(sharesThroughShell()).toBe(false);
  });

  it("asks the shell once whether it can, and says nothing until it has answered", async () => {
    shell.answer = () => Promise.resolve(true);
    expect(shellShares()).toBeNull();
    expect(shellShares()).toBeNull();
    await vi.waitFor(() => expect(shellShares()).toBe(true));
    expect(shell.calls.filter((call) => call.command === "screen_share_available")).toHaveLength(1);
    forgetShell();
    shell.answer = () => Promise.reject(new Error("no such command"));
    shellShares();
    await vi.waitFor(() => expect(shellShares()).toBe(false));
  });

  it("hands over the shell's frames, and asks it for key frames and to stop", async () => {
    const capture = await captureInShell(60, true);
    if (typeof capture === "string") throw new Error(capture);
    expect(started().fps).toBe(60);
    const got: ArrayBuffer[] = [];
    capture.onFrame = (frame) => got.push(frame);
    const frame = new ArrayBuffer(16);
    started().frames.onmessage(frame);
    // Anything but bytes isn't a frame.
    started().frames.onmessage("a window's name");
    expect(got).toEqual([frame]);
    capture.keyframe();
    capture.stop();
    expect(shell.calls.map((call) => call.command)).toEqual(["screen_share_start", "screen_share_keyframe", "screen_share_stop"]);
  });

  it("offers what the shell makes, H.264 first where the card makes it, and passes on the formats wanted and which key frame (#733)", async () => {
    shell.answer = (command) => Promise.resolve(command === "screen_share_start" ? ["avc1", "vp8", "a window's name"] : undefined);
    const capture = await captureInShell(60, false);
    if (typeof capture === "string") throw new Error(capture);
    // What a share can send, in the shell's order; nothing else.
    expect(capture.codecs).toEqual(["avc1", "vp8"]);
    capture.want(["vp8"]);
    capture.keyframe("vp8");
    capture.keyframe();
    expect(shell.calls.slice(1)).toEqual([
      { command: "screen_share_want", args: { codecs: ["vp8"] } },
      { command: "screen_share_keyframe", args: { codec: "vp8" } },
      { command: "screen_share_keyframe", args: { codec: null } },
    ]);
  });

  it("is a VP8 share where the shell says nothing it makes", async () => {
    shell.answer = () => Promise.resolve(null);
    const capture = await captureInShell(30, false);
    if (typeof capture === "string") throw new Error(capture);
    expect(capture.codecs).toEqual(["vp8"]);
  });

  it("starts with the preview as you left it, hands over its pictures, and switches it", async () => {
    const capture = await captureInShell(30, false);
    if (typeof capture === "string") throw new Error(capture);
    expect(started().shown).toBe(false);
    const got: ArrayBuffer[] = [];
    capture.onPicture = (picture) => got.push(picture);
    const picture = new ArrayBuffer(8);
    started().pictures.onmessage(picture);
    started().pictures.onmessage({ not: "a picture" });
    expect(got).toEqual([picture]);
    capture.preview(true);
    expect(shell.calls.at(-1)).toEqual({ command: "screen_share_preview", args: { shown: true } });
  });

  it("says when it ended by itself, and why", async () => {
    const capture = await captureInShell(30, false);
    if (typeof capture === "string") throw new Error(capture);
    const ends: string[] = [];
    capture.onEnded = (why) => ends.push(why);
    started().says.onmessage({ op: "ended", why: "gone" });
    started().says.onmessage({ op: "ended", why: "failed" });
    started().says.onmessage({ op: "something else" });
    expect(ends).toEqual(["gone", "failed"]);
  });

  it("gives the shell's refusals as they are, and anything else as no screen", async () => {
    for (const [answer, refused] of [
      ["declined", "declined"],
      ["no-encoder", "no-encoder"],
      ["no-screen", "no-screen"],
      [new Error("the window went"), "no-screen"],
    ] as const) {
      shell.answer = () => Promise.reject(answer);
      expect(await captureInShell(30, true)).toBe(refused);
    }
  });
});

describe("whether WebKit can play a screen here (#729)", () => {
  it("is asked of the shell once, on Linux", async () => {
    shell.answer = (command) => Promise.resolve(command === "screen_watch_available");
    expect(await shellPlays()).toBe(true);
    expect(await shellPlays()).toBe(true);
    expect(shell.calls.filter((call) => call.command === "screen_watch_available")).toHaveLength(1);
  });

  it("is no where the shell says WebKit draws on the CPU, or doesn't answer: a wrong yes aborts the window", async () => {
    shell.answer = () => Promise.resolve(false);
    expect(await shellPlays()).toBe(false);
    forgetShell();
    shell.answer = () => Promise.reject(new Error("no such command"));
    expect(await shellPlays()).toBe(false);
  });

  it("is yes without asking away from the Linux app", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0" });
    expect(await shellPlays()).toBe(true);
    expect(shell.calls).toHaveLength(0);
  });
});
