import { describe, expect, it } from "vitest";

import { releaseNotesUrl, updateLine, type UpdateCheck } from "./updates";

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
