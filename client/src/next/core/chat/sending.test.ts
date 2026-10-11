import { describe, expect, it } from "vitest";
import { afterFailure, canSend, dropUnsent, keepUnsent, nonceFor, type Submission } from "./sending";

const one: Submission = { key: 1, nonce: "first-try", conversation: "general", body: "hello", replyTo: null, fileKeys: [] };
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

describe("a send's one-time key (PROTOCOL §4, #524)", () => {
  const fresh = () => "new-key";
  const what = (sent: Submission) => ({ conversation: sent.conversation, body: sent.body, replyTo: sent.replyTo, fileKeys: sent.fileKeys });

  it("is new for a new message", () => {
    expect(nonceFor(what(one), null, fresh)).toBe("new-key");
  });

  it("is the first try's when a send put back in the box is sent again as it was", () => {
    expect(nonceFor(what(one), one, fresh)).toBe("first-try");
    const withFiles = { ...one, fileKeys: ["a", "b"] };
    expect(nonceFor({ ...what(withFiles), fileKeys: ["b", "a"] }, withFiles, fresh)).toBe("first-try");
  });

  it("is new once anything about it changed: it's another message then", () => {
    expect(nonceFor({ ...what(one), body: "hello!" }, one, fresh)).toBe("new-key");
    expect(nonceFor({ ...what(one), replyTo: "m1" }, one, fresh)).toBe("new-key");
    expect(nonceFor({ ...what(one), fileKeys: ["a"] }, one, fresh)).toBe("new-key");
    expect(nonceFor({ ...what(one), conversation: "jules" }, one, fresh)).toBe("new-key");
  });
});
