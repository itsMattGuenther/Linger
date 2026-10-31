import { describe, expect, it } from "vitest";

import { isOlderVersion, releaseNotesUrl, serverVersionLine, type UpdateCheck, updateLead, updateLine, WAIT_MS } from "./updates";

describe("updateLine", () => {
  const published = 1_800_000_000_000;
  const newer: UpdateCheck = { kind: "newer", version: "0.5.4", line: null, published, downloaded: false, silent: true };

  it("says what it is doing while it is doing it", () => {
    expect(updateLine(null, true)).toBe("Looking…");
    expect(updateLine({ kind: "current", silent: true }, true)).toBe("Looking…");
  });

  it("is silent before anything has been asked", () => {
    expect(updateLine(null, false)).toBe("");
  });

  it("says a downloaded update is ready, and when it installs (#772)", () => {
    expect(updateLine({ ...newer, downloaded: true }, false)).toBe(
      "Linger 0.5.4 is ready. It installs the next time Linger starts, or while you're away from your computer.",
    );
  });

  it("says a release on its day's wait is out, and that Restart now doesn't wait", () => {
    expect(updateLine(newer, false, published + 60_000)).toBe("Linger 0.5.4 is out. It installs by itself a day after it came out, or now with Restart now.");
  });

  it("says a release past its wait is downloading", () => {
    expect(updateLine(newer, false, published + WAIT_MS)).toBe("Linger 0.5.4 is out. It's downloading, and installs the next time Linger starts.");
  });

  it("tells a copy that needs a password that it waits for Update", () => {
    expect(updateLine({ ...newer, silent: false, downloaded: true }, false)).toBe(
      "Linger 0.5.4 is out. Updating asks for your computer's password, so it waits for you to press Update.",
    );
  });

  it("says so plainly when there is nothing to do", () => {
    expect(updateLine({ kind: "current", silent: true }, false)).toBe("This is the newest version.");
  });

  it("tells an unsigned build to go and fetch one, rather than pretending", () => {
    expect(updateLine({ kind: "unconfigured" }, false)).toMatch(/not built to update itself/);
  });

  it("passes the reason through instead of swallowing it", () => {
    const failed: UpdateCheck = { kind: "failed", reason: "the network is down" };
    expect(updateLine(failed, false)).toBe("Couldn't check for updates: the network is down");
  });
});

describe("updateLead (#772)", () => {
  it("says Linger keeps itself up to date, never while you're in voice", () => {
    for (const check of [null, { kind: "current", silent: true }, { kind: "unconfigured" }] as const) {
      expect(updateLead(check)).toMatch(/^Linger keeps itself up to date\..*never restarts while you're in voice\.$/);
    }
    expect(updateLead(null)).not.toMatch(/Nothing is downloaded until you ask/);
  });

  it("tells a copy that needs a password that installing waits for Update", () => {
    expect(updateLead({ kind: "current", silent: false })).toMatch(/asks for your computer's password/);
  });

  it("tells a copy the system updates that it does", () => {
    expect(updateLead({ kind: "managed", by: "pacman", newer: null })).toBe(
      "Your system installed this copy of Linger, and updates it along with everything else.",
    );
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
  it("says a newer release comes with the system update, in words true on any Arch system (#772)", () => {
    const line = updateLine({ kind: "managed", by: "pacman", newer: { version: "0.5.4", line: null } }, false);
    expect(line).toBe("Linger 0.5.4 is out. It comes with your next system update (sudo pacman -Syu).");
    expect(line).not.toMatch(/Omarchy/);
  });

  it("says it's the newest when it is", () => {
    expect(updateLine({ kind: "managed", by: "pacman", newer: null }, false)).toBe("This is the newest version.");
  });

  it("names any other manager", () => {
    expect(updateLine({ kind: "managed", by: "dnf", newer: { version: "0.5.4", line: null } }, false)).toBe(
      "Linger 0.5.4 is out. It comes with your next system update, through dnf.",
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
