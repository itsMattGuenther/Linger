import { describe, expect, it } from "vitest";
import { engineHidesClipboardImages, type PasteContext, type PastedData, pastedName, planPaste, shellImage } from "./paste";

/** Half past two in the afternoon, this computer's time. */
const AT = new Date(2026, 8, 28, 14, 30, 5);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A paste event's data, as an engine hands it over. */
function pasted({ files = [], items = files.map((file) => ({ kind: "file", getAsFile: () => file })), words = {} }: { files?: File[]; items?: PastedData["items"]; words?: Record<string, string> }): PastedData {
  return { files, items, getData: (format) => words[format] ?? "" };
}

const CHROMIUM: PasteContext = { shell: false, selection: false, at: AT };
const WEBKITGTK: PasteContext = { shell: true, selection: false, at: AT };

/** What Chromium makes of a picture on the clipboard: a file it names image.png. */
const clipboardPicture = () => new File([PNG], "image.png", { type: "image/png" });

describe("a paste into the message box (#276)", () => {
  it("attaches a picture from the clipboard, named for when it was pasted", () => {
    const plan = planPaste(pasted({ files: [clipboardPicture()] }), CHROMIUM);
    expect(plan.kind).toBe("files");
    if (plan.kind !== "files") return;
    expect(plan.files.map((file) => [file.name, file.type, file.size])).toEqual([["pasted-image-2026-09-28-143005.png", "image/png", PNG.length]]);
  });

  it("leaves words to the engine where it can see pictures", () => {
    expect(planPaste(pasted({ words: { "text/plain": "see you at eight" } }), CHROMIUM)).toEqual({ kind: "engine" });
  });

  it("gives the picture the win when words came with it, and drops the words", () => {
    // A browser's Copy Image: the picture, its address in words, and markup.
    const plan = planPaste(
      pasted({ files: [clipboardPicture()], words: { "text/plain": "https://example.com/cat.png", "text/html": '<img src="https://example.com/cat.png">' } }),
      CHROMIUM,
    );
    expect(plan.kind).toBe("files");
    if (plan.kind !== "files") return;
    expect(plan.files.map((file) => file.name)).toEqual(["pasted-image-2026-09-28-143005.png"]);
  });

  it("keeps the name of a copied file, picture or not", () => {
    const notes = new File(["bring chairs"], "notes.txt", { type: "text/plain" });
    const photo = new File([PNG], "porch.png", { type: "image/png" });
    const plan = planPaste(pasted({ files: [notes, photo] }), CHROMIUM);
    expect(plan.kind === "files" ? plan.files.map((file) => [file.name, file.type]) : plan).toEqual([
      ["notes.txt", "text/plain"],
      ["porch.png", "image/png"],
    ]);
  });

  it("never attaches an empty file", () => {
    const empty = new File([], "image.png", { type: "image/png" });
    expect(planPaste(pasted({ files: [empty], words: { "text/plain": "hi" } }), CHROMIUM)).toEqual({ kind: "engine" });
    expect(planPaste(pasted({ files: [empty], words: { "text/plain": "hi" } }), WEBKITGTK)).toEqual({ kind: "shell", words: "hi" });
  });

  it("finds a picture an engine lists as an item but not as a file", () => {
    const picture = clipboardPicture();
    const plan = planPaste(pasted({ files: [], items: [{ kind: "string", getAsFile: () => null }, { kind: "file", getAsFile: () => picture }] }), CHROMIUM);
    expect(plan.kind === "files" ? plan.files.map((file) => file.name) : plan).toEqual(["pasted-image-2026-09-28-143005.png"]);
  });

  it("numbers several unnamed pictures in one paste", () => {
    const plan = planPaste(pasted({ files: [clipboardPicture(), new File([PNG], "", { type: "image/jpeg" })] }), CHROMIUM);
    expect(plan.kind === "files" ? plan.files.map((file) => file.name) : plan).toEqual(["pasted-image-2026-09-28-143005.png", "pasted-image-2026-09-28-143005-2.jpg"]);
  });

  describe("in the Linux app, where WebKitGTK never shows the page a picture", () => {
    it("asks the desktop shell, carrying the words in case there's no picture", () => {
      expect(planPaste(pasted({ words: { "text/plain": "see you at eight" } }), WEBKITGTK)).toEqual({ kind: "shell", words: "see you at eight" });
    });

    it("asks with no words when the paste has none, as with a screenshot", () => {
      // What WebKitGTK hands the page for a picture: nothing at all.
      expect(planPaste(pasted({}), WEBKITGTK)).toEqual({ kind: "shell", words: "" });
      expect(planPaste(null, WEBKITGTK)).toEqual({ kind: "shell", words: "" });
    });

    it("still takes files the engine does show", () => {
      const notes = new File(["bring chairs"], "notes.txt", { type: "text/plain" });
      const plan = planPaste(pasted({ files: [notes], words: { "text/plain": "notes.txt" } }), WEBKITGTK);
      expect(plan.kind === "files" ? plan.files.map((file) => file.name) : plan).toEqual(["notes.txt"]);
    });

    it("leaves a middle-click paste to the engine, which pastes the selection", () => {
      expect(planPaste(pasted({}), { ...WEBKITGTK, selection: true })).toEqual({ kind: "engine" });
      expect(planPaste(pasted({ words: { "text/plain": "selected" } }), { ...WEBKITGTK, selection: true })).toEqual({ kind: "engine" });
    });
  });
});

describe("a pasted picture's name", () => {
  it("says what it is and when, in this computer's time, sorting by when", () => {
    expect(pastedName(AT, "image/png")).toBe("pasted-image-2026-09-28-143005.png");
    expect(pastedName(new Date(2027, 0, 2, 3, 4, 5), "image/jpeg")).toBe("pasted-image-2027-01-02-030405.jpg");
    expect(pastedName(AT, "image/webp", 3)).toBe("pasted-image-2026-09-28-143005-3.webp");
    expect(pastedName(AT, "image/x-something")).toBe("pasted-image-2026-09-28-143005.png");
    expect(pastedName(AT, "")).toBe("pasted-file-2026-09-28-143005");
  });
});

describe("the desktop shell's picture", () => {
  it("is a PNG file to attach", () => {
    const file = shellImage(PNG.buffer.slice(0), AT);
    expect(file && [file.name, file.type, file.size]).toEqual(["pasted-image-2026-09-28-143005.png", "image/png", PNG.length]);
  });

  it("comes as raw bytes, a view of them, or a list of numbers", () => {
    expect(shellImage(PNG, AT)?.size).toBe(PNG.length);
    const within = new Uint8Array([9, 9, ...PNG]);
    expect(shellImage(within.subarray(2), AT)?.size).toBe(PNG.length);
    expect(shellImage([...PNG], AT)?.size).toBe(PNG.length);
  });

  it("is nothing when the clipboard had no picture, or what came isn't a PNG", () => {
    expect(shellImage(new ArrayBuffer(0), AT)).toBeNull();
    expect(shellImage(null, AT)).toBeNull();
    expect(shellImage(undefined, AT)).toBeNull();
    expect(shellImage(new TextEncoder().encode("GIF89a and then some"), AT)).toBeNull();
    expect(shellImage(PNG.subarray(0, 8), AT)).toBeNull();
    expect(shellImage(["not", "bytes"], AT)).toBeNull();
  });
});

describe("which engine hides pictures on the clipboard", () => {
  const WEBKITGTK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
  const WEBVIEW2_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

  it("is the Linux app's, and nobody else's", () => {
    expect(engineHidesClipboardImages(WEBKITGTK_UA, true)).toBe(true);
    expect(engineHidesClipboardImages(WEBVIEW2_UA, true)).toBe(false);
    // A browser has no desktop shell to ask, whatever it runs on.
    expect(engineHidesClipboardImages(WEBKITGTK_UA, false)).toBe(false);
    expect(engineHidesClipboardImages("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36", true)).toBe(false);
  });
});
