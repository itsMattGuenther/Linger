import { describe, expect, it } from "vitest";
import type { User } from "../../generated/User";
import type { ListModel, PersonRow } from "./list";
import {
  ANDROID_SHARED,
  holdForConversation,
  listShared,
  onHeld,
  readShared,
  SHARED,
  shareHead,
  sharedDone,
  sharedProblem,
  shareTargets,
  takeHeld,
  watchShares,
} from "./shareInbox";

// Files shared to Linger from the phone's share sheet (#785): the list
// window looks in the shell's inbox, asks which conversation they're for,
// and holds them for that conversation's message box.

function person(id: string, name: string): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    is_cohost: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

function row(user: User, dm: string | null): PersonRow {
  return { user, state: "around", note: "around", line: null, inVoice: false, sharing: false, dm, fresh: false, talked: dm !== null };
}

function model(parts: Partial<ListModel>): ListModel {
  return { me: null, rooms: [], groups: [], dmMembers: [], people: { here: [], away: [], offline: [] }, ...parts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A window, its document and the shell's bus, each with events fired by hand. */
function fakeWatch() {
  const handlers = new Map<string, Set<() => void>>();
  const on = (event: string, handler: () => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
  };
  const off = (event: string, handler: () => void) => {
    handlers.get(event)?.delete(handler);
  };
  const doc = { visibilityState: "visible" as DocumentVisibilityState, addEventListener: on, removeEventListener: off };
  return {
    watch: {
      bus: {
        listen<T>(event: string, handler: (payload: T) => void) {
          const plain = () => handler(undefined as T);
          on(event, plain);
          return Promise.resolve(() => off(event, plain));
        },
      },
      window: { addEventListener: on, removeEventListener: off },
      document: doc,
    },
    doc,
    fire(event: string) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler();
    },
    listening() {
      return [...handlers.values()].reduce((sum, set) => sum + set.size, 0);
    },
  };
}

describe("what's waiting in the inbox", () => {
  it("lists names without reading any bytes", async () => {
    const asked: string[] = [];
    const waiting = await listShared((command) => {
      asked.push(command);
      return Promise.resolve([{ name: "Screenshot.png", size: 3, problem: null }]);
    });
    expect(waiting).toEqual([{ name: "Screenshot.png", size: 3, problem: null }]);
    expect(asked).toEqual(["shared_files"]);
    expect(await listShared(() => Promise.resolve(null))).toEqual([]);
  });

  it("reads every file it can once a conversation is picked, and says the first reason one couldn't be", async () => {
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

  it("says each reason in words", () => {
    expect(sharedProblem({ name: "Photos", size: 0, problem: "folder" })).toBe("Photos is a folder. Share the files in it instead.");
    expect(sharedProblem({ name: "x.bin", size: 1, problem: "unreadable" })).toBe("Linger couldn't open x.bin.");
    expect(sharedProblem({ name: "ok.png", size: 1, problem: null })).toBeNull();
  });

  it("tells the shell it's done, and doesn't mind if it can't", async () => {
    const asked: string[] = [];
    await sharedDone((command) => {
      asked.push(command);
      return Promise.reject(new Error("gone"));
    });
    expect(asked).toEqual(["shared_done"]);
  });
});

describe("looking for a share", () => {
  it("looks at once, on the shell's word, on Android's, and when the app comes forward", async () => {
    const fake = fakeWatch();
    let looks = 0;
    const seen: number[] = [];
    const stop = watchShares(
      fake.watch,
      () => {
        looks += 1;
        return Promise.resolve([]);
      },
      (waiting) => seen.push(waiting.length),
    );
    await settle();
    expect(looks).toBe(1);
    fake.fire(SHARED);
    await settle();
    fake.fire(ANDROID_SHARED);
    await settle();
    fake.doc.visibilityState = "hidden";
    fake.fire("visibilitychange");
    await settle();
    expect(looks, "going to the background isn't a reason to look").toBe(3);
    fake.doc.visibilityState = "visible";
    fake.fire("visibilitychange");
    await settle();
    expect(looks).toBe(4);
    expect(seen).toEqual([0, 0, 0, 0]);
    stop();
    expect(fake.listening()).toBe(0);
    fake.fire(SHARED);
    await settle();
    expect(looks).toBe(4);
  });

  it("never looks twice at once: a word during a look means one more look after it", async () => {
    const fake = fakeWatch();
    const answers: Array<(waiting: unknown) => void> = [];
    const seen: string[][] = [];
    watchShares(
      fake.watch,
      () => new Promise((resolve) => answers.push(resolve)),
      (waiting) => seen.push(waiting.map((file) => file.name)),
    );
    fake.fire(SHARED);
    fake.fire(ANDROID_SHARED);
    expect(answers).toHaveLength(1);
    answers[0]?.([{ name: "a.png", size: 1, problem: null }]);
    await settle();
    expect(answers).toHaveLength(2);
    answers[1]?.([]);
    await settle();
    expect(answers).toHaveLength(2);
    expect(seen).toEqual([["a.png"], []]);
  });

  it("a shell that can't answer is an empty inbox", async () => {
    const fake = fakeWatch();
    const seen: number[] = [];
    watchShares(fake.watch, () => Promise.reject(new Error("no shell")), (waiting) => seen.push(waiting.length));
    await settle();
    expect(seen).toEqual([0]);
  });
});

describe("where a share can go", () => {
  const eli = person("u-eli", "Eli");
  const jules = person("u-jules", "Jules");
  const sam = person("u-sam", "Sam");

  it("lists rooms, then group DMs, then DMs, server by server", () => {
    const sections = shareTargets([
      {
        id: "https://porch.example",
        name: "The Porch",
        model: model({
          rooms: [{ id: "r-general", name: "general", fresh: false, people: [], voice: false, screen: false }],
          groups: [
            { id: "g-trip", label: "Eli and Sam", people: [], memberIds: [], fresh: false, leavable: true, last: false },
            { id: "g-empty", label: "Dave", people: [], memberIds: [], fresh: false, leavable: true, last: true },
          ],
          people: { here: [row(eli, "d-eli"), row(sam, null)], away: [], offline: [row(jules, "d-jules")] },
        }),
      },
      { id: "https://empty.example", name: "Empty", model: model({}) },
    ]);
    expect(sections).toEqual([
      {
        server: "https://porch.example",
        name: "The Porch",
        targets: [
          { server: "https://porch.example", roomId: "r-general", label: "general", kind: "room" },
          { server: "https://porch.example", roomId: "g-trip", label: "Eli and Sam", kind: "group" },
          { server: "https://porch.example", roomId: "d-eli", label: "Eli", kind: "dm" },
          { server: "https://porch.example", roomId: "d-jules", label: "Jules", kind: "dm" },
        ],
      },
    ]);
  });

  it("says what's being shared", () => {
    expect(shareHead([{ name: "Screenshot.png", size: 1, problem: null }])).toBe("Share Screenshot.png to…");
    expect(
      shareHead([
        { name: "a.png", size: 1, problem: null },
        { name: "b.png", size: 1, problem: null },
      ]),
    ).toBe("Share 2 files to…");
  });
});

describe("files held for a conversation", () => {
  it("are taken once, by that conversation, and whoever is listening hears they're there", () => {
    let heard = 0;
    const stop = onHeld(() => (heard += 1));
    const photo = new File([new Uint8Array([1])], "photo.png", { type: "image/png" });
    holdForConversation("https://porch.example r-general", [photo]);
    holdForConversation("https://porch.example r-general", []);
    expect(heard, "nothing held, nothing to hear").toBe(1);
    expect(takeHeld("https://porch.example d-eli")).toBeNull();
    expect(takeHeld("https://porch.example r-general")).toEqual([photo]);
    expect(takeHeld("https://porch.example r-general")).toBeNull();
    stop();
    holdForConversation("https://porch.example r-general", [photo]);
    expect(heard).toBe(1);
    takeHeld("https://porch.example r-general");
  });
});
