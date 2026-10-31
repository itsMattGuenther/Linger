import { describe, expect, it } from "vitest";

import { readShared, sharedDone, sharedProblem } from "./sharedFiles";

// Files shared from the phone's share sheet come from the shell (#785): the
// page asks for them, puts them in a message box, and says when it's done.

describe("what was shared, from the shell", () => {
  it("reads every file it can and says the first reason one couldn't be sent", async () => {
    const asked: string[] = [];
    const ask = (command: string, args?: Record<string, unknown>) => {
      asked.push(args ? `${command}:${String(args.index)}` : command);
      if (command === "shared_files") {
        return Promise.resolve([
          { name: "Screenshot.PNG", size: 3, problem: null },
          { name: "film.mov", size: 600_000_000, problem: "too_big" },
          { name: "gone.txt", size: 2, problem: null },
        ]);
      }
      if (args?.index === 0) return Promise.resolve(new Uint8Array([1, 2, 3]).buffer);
      return Promise.reject(new Error("that can't be sent"));
    };
    const { files, problem } = await readShared(ask);
    expect(files.map((file) => [file.name, file.type, file.size])).toEqual([["Screenshot.PNG", "image/png", 3]]);
    expect(problem).toBe("film.mov is too big to send. A file can be 500 MB at most.");
    expect(asked).toEqual(["shared_files", "shared_file:0", "shared_file:2"]);
  });

  it("asks only the shared commands, never the dropped ones", async () => {
    const asked: string[] = [];
    await readShared((command) => {
      asked.push(command);
      return Promise.resolve([]);
    });
    expect(asked).toEqual(["shared_files"]);
  });

  it("answers nothing when the shell holds nothing", async () => {
    expect(await readShared(() => Promise.resolve(null))).toEqual({ files: [], problem: null });
  });

  it("says each reason in words", () => {
    expect(sharedProblem({ name: "Photos", size: 0, problem: "folder" })).toBe("Photos is a folder. Share the files in it instead.");
    expect(sharedProblem({ name: "x.bin", size: 1, problem: "unreadable" })).toBe("Linger couldn't open x.bin.");
    expect(sharedProblem({ name: "ok.png", size: 1, problem: null })).toBeNull();
  });
});

describe("telling the shell it's done", () => {
  it("asks the shell to forget the files, and doesn't mind if it can't", async () => {
    const asked: string[] = [];
    await sharedDone((command) => {
      asked.push(command);
      return Promise.reject(new Error("gone"));
    });
    expect(asked).toEqual(["shared_done"]);
  });
});
