import { describe, expect, it } from "vitest";
import type { Attachment } from "../../../generated/Attachment";
import { added, filesIn, NO_DRAFTS, progressed, refused, removed, restored, sent, taken, uploaded } from "./drafts";

function attachment(id: string): Attachment {
  return { id, filename: `${id}.png`, mime: "image/png", size_bytes: 10, width: 1, height: 1, duration_ms: null, url: `/media/${id}`, poster_url: null } as Attachment;
}

const GENERAL = "home#r-general";
const JULES = "home#d-jules";

describe("files on their way into a message", () => {
  it("belong to the conversation they were added in, and report their own progress", () => {
    let drafts = added(NO_DRAFTS, GENERAL, [{ key: "a", name: "a.png" }, { key: "b", name: "b.png" }]);
    drafts = progressed(drafts, "a", 0.5);
    expect(filesIn(drafts, GENERAL).map((file) => [file.key, file.progress, file.ready])).toEqual([
      ["a", 0.5, false],
      ["b", 0, false],
    ]);
    expect(filesIn(drafts, JULES)).toEqual([]);
    // Progress only goes forward, and stops at the whole file.
    expect(filesIn(progressed(drafts, "a", 0.2), GENERAL)[0]?.progress).toBe(0.5);
    expect(filesIn(progressed(drafts, "a", 7), GENERAL)[0]?.progress).toBe(1);
  });

  it("are ready once the server has them, and say why when it refused", () => {
    let drafts = added(NO_DRAFTS, GENERAL, [{ key: "a", name: "a.png" }, { key: "b", name: "b.exe" }]);
    drafts = uploaded(drafts, "a", attachment("att-a"));
    drafts = refused(drafts, "b", "That kind of file can't go up.");
    expect(filesIn(drafts, GENERAL).map((file) => [file.ready, file.problem])).toEqual([
      [true, null],
      [false, "That kind of file can't go up."],
    ]);
  });

  it("removing a finished file hands back what the server has, so it can be let go", () => {
    let drafts = added(NO_DRAFTS, GENERAL, [{ key: "a", name: "a.png" }]);
    drafts = uploaded(drafts, "a", attachment("att-a"));
    const { drafts: after, abandoned } = removed(drafts, "a");
    expect(filesIn(after, GENERAL)).toEqual([]);
    expect(abandoned?.id).toBe("att-a");
    expect(removed(added(NO_DRAFTS, GENERAL, [{ key: "c", name: "c" }]), "c").abandoned).toBeNull();
  });

  it("a send takes its files out of the draft, and they're gone once it goes through", () => {
    let drafts = added(NO_DRAFTS, GENERAL, [{ key: "a", name: "a.png" }, { key: "b", name: "b.png" }]);
    drafts = uploaded(uploaded(drafts, "a", attachment("att-a")), "b", attachment("att-b"));
    const sending = taken(drafts, GENERAL, ["b", "a"]);
    expect(sending?.attachments.map((one) => one.id)).toEqual(["att-b", "att-a"]);
    if (!sending) return;
    expect(filesIn(sending.drafts, GENERAL)).toEqual([]);
    const done = sent(sending.drafts, ["a", "b"]);
    expect(done.held).toEqual({});
    expect(done.uploaded).toEqual({});
  });

  it("a failed send can go again with the same files, or put them back in the box", () => {
    let drafts = added(NO_DRAFTS, GENERAL, [{ key: "a", name: "a.png" }]);
    drafts = uploaded(drafts, "a", attachment("att-a"));
    const first = taken(drafts, GENERAL, ["a"]);
    if (!first) throw new Error("not taken");
    // Retry: the same keys, now held rather than in the draft.
    const again = taken(first.drafts, GENERAL, ["a"]);
    expect(again?.attachments.map((one) => one.id)).toEqual(["att-a"]);
    // Or back into the box, in the conversation it came from, once.
    const back = restored(first.drafts, ["a"]);
    expect(filesIn(back, GENERAL).map((file) => file.key)).toEqual(["a"]);
    expect(filesIn(restored(back, ["a"]), GENERAL)).toHaveLength(1);
  });

  it("won't send a file that isn't up yet", () => {
    const drafts = added(NO_DRAFTS, GENERAL, [{ key: "a", name: "a.png" }]);
    expect(taken(drafts, GENERAL, ["a"])).toBeNull();
  });
});
