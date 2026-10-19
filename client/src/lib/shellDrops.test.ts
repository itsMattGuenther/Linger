import { describe, expect, it } from "vitest";

import { droppedProblem, dropZone, readDropped, typeFromName, zoneAt } from "./shellDrops";

// Files dropped on the Linux app come from the shell (#673): the box under
// the drop asks for them. The browser spec (next-chat-parity.spec.ts) drops
// them; these are the rules around it.

describe("a dropped file's type, by its name", () => {
  it("shows a picture as one before it's sent", () => {
    expect(typeFromName("porch.PNG")).toBe("image/png");
    expect(typeFromName("Screenshot 2026-10-19 at 9.41.jpeg")).toBe("image/jpeg");
    expect(typeFromName("clip.mov")).toBe("video/quicktime");
    expect(typeFromName("notes")).toBe("");
    expect(typeFromName("archive.tar.xz")).toBe("");
  });
});

describe("what was dropped, from the shell", () => {
  it("reads every file it can and says the first reason one couldn't be sent", async () => {
    const asked: string[] = [];
    const ask = (command: string, args?: Record<string, unknown>) => {
      asked.push(args ? `${command}:${String(args.index)}` : command);
      if (command === "dropped_files") {
        return Promise.resolve([
          { name: "porch.png", size: 3, problem: null },
          { name: "Photos", size: 0, problem: "folder" },
          { name: "film.mov", size: 600_000_000, problem: "too_big" },
          { name: "gone.txt", size: 2, problem: null },
        ]);
      }
      if (args?.index === 0) return Promise.resolve(new Uint8Array([1, 2, 3]).buffer);
      return Promise.reject(new Error("that can't be sent"));
    };
    const { files, problem } = await readDropped(ask);
    expect(files.map((file) => [file.name, file.type, file.size])).toEqual([["porch.png", "image/png", 3]]);
    expect(problem).toBe("Photos is a folder. Drop the files in it instead.");
    expect(asked).toEqual(["dropped_files", "dropped_file:0", "dropped_file:3"]);
  });

  it("says each reason in words", () => {
    expect(droppedProblem({ name: "film.mov", size: 1, problem: "too_big" })).toBe("film.mov is too big to send. A file can be 500 MB at most.");
    expect(droppedProblem({ name: "x.bin", size: 1, problem: "unreadable" })).toBe("Linger couldn't open x.bin.");
    expect(droppedProblem({ name: "ok.png", size: 1, problem: null })).toBeNull();
  });

  it("answers nothing when the shell lists nothing", async () => {
    expect(await readDropped(() => Promise.resolve(null))).toEqual({ files: [], problem: null });
  });
});

describe("which message box a drop landed on", () => {
  it("is the one around where it landed, and none outside every box", () => {
    const form = { parentElement: null } as unknown as Element;
    const box = { parentElement: form } as unknown as Element;
    const elsewhere = { parentElement: null } as unknown as Element;
    const zone = { attach: () => undefined, say: () => undefined };
    const stop = dropZone(form, () => zone);
    expect(zoneAt(box)).toBe(zone);
    expect(zoneAt(form)).toBe(zone);
    expect(zoneAt(elsewhere)).toBeNull();
    expect(zoneAt(null)).toBeNull();
    stop();
    expect(zoneAt(box)).toBeNull();
  });
});
