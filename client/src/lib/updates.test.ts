import { describe, expect, it } from "vitest";

import { isOlderVersion, releaseNotesUrl, serverVersionLine, updateLine, type UpdateCheck } from "./updates";

describe("updateLine", () => {
  it("says what it is doing while it is doing it", () => {
    expect(updateLine(null, true)).toBe("Looking…");
    expect(updateLine({ kind: "current" }, true)).toBe("Looking…");
  });

  it("is silent before anything has been asked", () => {
    expect(updateLine(null, false)).toBe("");
  });

  it("names the version that is waiting", () => {
    const ready: UpdateCheck = { kind: "ready", version: "0.2.0", notes: null };
    expect(updateLine(ready, false)).toBe("Version 0.2.0 is ready to install.");
  });

  it("says so plainly when there is nothing to do", () => {
    expect(updateLine({ kind: "current" }, false)).toBe("This is the newest version.");
  });

  it("tells an unsigned build to go and fetch one, rather than pretending", () => {
    expect(updateLine({ kind: "unconfigured" }, false)).toMatch(/not built to update itself/);
  });

  it("passes the reason through instead of swallowing it", () => {
    const failed: UpdateCheck = { kind: "failed", reason: "the network is down" };
    expect(updateLine(failed, false)).toBe("Couldn't check for updates: the network is down");
  });
});

describe("releaseNotesUrl", () => {
  it("points at the version's tagged release", () => {
    expect(releaseNotesUrl("0.3.5")).toBe(
      "https://github.com/itsMattGuenther/Linger/releases/tag/v0.3.5",
    );
  });

  it("does not double a v the version already has", () => {
    expect(releaseNotesUrl("v0.3.5")).toBe(
      "https://github.com/itsMattGuenther/Linger/releases/tag/v0.3.5",
    );
  });

  it("keeps a pre-release suffix intact", () => {
    expect(releaseNotesUrl("0.4.0-beta.1")).toBe(
      "https://github.com/itsMattGuenther/Linger/releases/tag/v0.4.0-beta.1",
    );
  });
});

describe("a copy the system updates", () => {
  it("points pacman installs at the system update, not the install button", () => {
    expect(updateLine({ kind: "managed", by: "pacman" }, false)).toBe(
      "This copy updates with your system: use Update in the Omarchy menu, or run sudo pacman -Syu.",
    );
  });

  it("names any other manager", () => {
    expect(updateLine({ kind: "managed", by: "dnf" }, false)).toBe(
      "This copy updates with your system, through dnf.",
    );
  });
});

describe("isOlderVersion (#314)", () => {
  it("compares each part as a number, not as text", () => {
    expect(isOlderVersion("0.4.3", "0.4.4")).toBe(true);
    expect(isOlderVersion("0.4.9", "0.4.10")).toBe(true);
    expect(isOlderVersion("0.9.0", "0.10.0")).toBe(true);
    expect(isOlderVersion("0.4.10", "0.4.9")).toBe(false);
  });

  it("is false for the same release, and for a newer one", () => {
    expect(isOlderVersion("0.4.4", "0.4.4")).toBe(false);
    expect(isOlderVersion("0.5.0", "0.4.4")).toBe(false);
  });

  it("takes a v in front", () => {
    expect(isOlderVersion("v0.4.3", "0.4.4")).toBe(true);
    expect(isOlderVersion("0.4.3", "v0.4.4")).toBe(true);
  });

  it("never calls a server behind on an answer it can't read", () => {
    expect(isOlderVersion("", "0.4.4")).toBe(false);
    expect(isOlderVersion("0.4", "0.4.4")).toBe(false);
    expect(isOlderVersion("0.4.3-dev", "0.4.4")).toBe(false);
    expect(isOlderVersion("0.4.3", "latest")).toBe(false);
  });
});

describe("serverVersionLine (#314)", () => {
  it("says it's asking, and says so when it couldn't", () => {
    expect(serverVersionLine({ kind: "looking" }, "0.4.4")).toEqual({ words: "Asking the server which version it runs…", behind: false });
    expect(serverVersionLine({ kind: "unknown" }, "0.4.4")).toEqual({ words: "Couldn't ask the server which version it runs.", behind: false });
  });

  it("names both versions when the server is behind", () => {
    expect(serverVersionLine({ kind: "known", version: "0.4.3" }, "0.4.4")).toEqual({ words: "This server runs Linger 0.4.3, and 0.4.4 is out.", behind: true });
  });

  it("says it's the newest only when it is", () => {
    expect(serverVersionLine({ kind: "known", version: "0.4.4" }, "0.4.4")).toEqual({ words: "This server runs Linger 0.4.4, the newest.", behind: false });
    expect(serverVersionLine({ kind: "known", version: "0.5.0" }, "0.4.4")).toEqual({ words: "This server runs Linger 0.5.0.", behind: false });
  });

  it("gives the server's version alone when the newest couldn't be read", () => {
    expect(serverVersionLine({ kind: "known", version: "0.4.3" }, null)).toEqual({ words: "This server runs Linger 0.4.3.", behind: false });
  });
});
