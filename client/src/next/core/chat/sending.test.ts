import { describe, expect, it } from "vitest";
import { afterFailure, canSend, dropUnsent, keepUnsent, type Submission } from "./sending";

const one: Submission = { key: 1, conversation: "general", body: "hello", replyTo: null, fileKeys: [] };
const box = { conversation: "general", draft: "", fileCount: 0, replying: false };

describe("what a failed send does (SPEC §4.7, L-16)", () => {
  it("puts the text back only into an untouched box", () => {
    expect(afterFailure(one, box)).toBe("restore");
  });

  it("never puts it into another conversation's box: it waits in its own", () => {
    expect(afterFailure(one, { ...box, conversation: "jules" })).toBe("keep");
  });

  it("never touches a newer draft, file or reply: it keeps the failed one apart", () => {
    expect(afterFailure(one, { ...box, draft: "next thing" })).toBe("keep");
    expect(afterFailure(one, { ...box, fileCount: 1 })).toBe("keep");
    expect(afterFailure(one, { ...box, replying: true })).toBe("keep");
  });

  it("keeps each unsent message once, and lets it go when a retry lands", () => {
    const kept = keepUnsent(keepUnsent([], one), one);
    expect(kept).toEqual([one]);
    expect(dropUnsent(kept, 1)).toEqual([]);
  });

  it("sends when there is something to send, and says why not while a file uploads", () => {
    expect(canSend("hi", 0, false)).toEqual({ ok: true });
    expect(canSend("   ", 0, false)).toEqual({ ok: false, blocked: null });
    expect(canSend("", 1, false)).toEqual({ ok: true });
    expect(canSend("hi", 0, true)).toEqual({ ok: false, blocked: "The file is still uploading. Your draft is kept here." });
  });
});
