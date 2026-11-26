import { describe, expect, it } from "vitest";
import { type AppIconShell, appIconShell, changeIcon, DEFAULT_LOOK, ICON_LOOKS, type IconLook, isIconLook, keepChoice, memoryIconShell } from "./appIcon";

describe("the app icon (#961)", () => {
  it("knows its six looks, the door first", () => {
    expect(ICON_LOOKS.map((look) => look.id)).toEqual(["door", "after-dark", "porch-light", "daylight", "dusk", "original"]);
    expect(DEFAULT_LOOK).toBe("door");
    for (const look of ICON_LOOKS) expect(isIconLook(look.id)).toBe(true);
    for (const other of ["", "Door", "porch", null, 3, undefined]) expect(isIconLook(other)).toBe(false);
  });

  it("reads the look on the home screen, and a phone that can't say is on the door", async () => {
    const asked: string[] = [];
    const answering = (answer: unknown) =>
      appIconShell("android", (command) => {
        asked.push(command);
        return Promise.resolve(answer);
      });
    expect(await answering("dusk").current()).toBe("dusk");
    expect(await answering("something-new").current()).toBe("door");
    expect(await answering(null).current()).toBe("door");
    expect(await appIconShell("iphone", () => Promise.reject(new Error("no shell"))).current()).toBe("door");
    expect(asked).toEqual(["phone_icon", "phone_icon", "phone_icon"]);
  });

  it("asks the shell for the look by name, and only its yes is a yes", async () => {
    const sent: Array<[string, unknown]> = [];
    const shell = (answer: unknown) =>
      appIconShell("iphone", (command, args) => {
        sent.push([command, args]);
        return Promise.resolve(answer);
      });
    expect(await shell(true).set("porch-light")).toBe(true);
    expect(sent).toEqual([["phone_icon_set", { look: "porch-light" }]]);
    expect(await shell(false).set("dusk")).toBe(false);
    expect(await shell("true").set("dusk")).toBe(false);
    expect(await appIconShell("android", () => Promise.reject(new Error("no shell"))).set("dusk")).toBe(false);
  });

  it("asks the phone one thing at a time, in the order they came", async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const started: unknown[] = [];
    const answers: Array<(answer: unknown) => void> = [];
    const shell = appIconShell("android", (command, args) => {
      started.push(args ?? command);
      return new Promise((resolve) => answers.push(resolve));
    });
    const first = shell.set("daylight");
    const second = shell.set("porch-light");
    const after = shell.current();
    await settle();
    expect(started).toEqual([{ look: "daylight" }]);
    answers[0]?.(true);
    await settle();
    expect(started).toEqual([{ look: "daylight" }, { look: "porch-light" }]);
    answers[1]?.(true);
    await settle();
    expect(started).toEqual([{ look: "daylight" }, { look: "porch-light" }, "phone_icon"]);
    answers[2]?.("porch-light");
    expect([await first, await second, await after]).toEqual([true, true, "porch-light"]);
  });

  it("keeps a choice in memory outside the app", async () => {
    const shell = memoryIconShell("android");
    expect(await shell.current()).toBe("door");
    expect(await shell.set("daylight")).toBe(true);
    expect(await shell.current()).toBe("daylight");
  });

  it("moves the picker's choice with the look in use, unless the person chose another meanwhile", () => {
    expect(keepChoice("door", "door", "dusk")).toBe("dusk");
    expect(keepChoice("daylight", "door", "dusk")).toBe("daylight");
    // A change put back: the choice that was the change goes back too.
    expect(keepChoice("dusk", "dusk", "door")).toBe("door");
  });

  describe("changing it", () => {
    const refusing = (shows: IconLook): AppIconShell => ({ phone: "iphone", set: () => Promise.resolve(false), current: () => Promise.resolve(shows) });

    it("is the look asked for when the phone takes it", async () => {
      expect(await changeIcon(memoryIconShell("android"), "dusk", () => true)).toEqual({ look: "dusk", refused: false });
    });

    it("puts back the look the phone shows when it refuses, and says so", async () => {
      expect(await changeIcon(refusing("door"), "dusk", () => true)).toEqual({ look: "door", refused: true });
    });

    it("isn't a refusal when the phone shows the look asked for after all", async () => {
      expect(await changeIcon(refusing("dusk"), "dusk", () => true)).toEqual({ look: "dusk", refused: false });
    });

    it("leaves the picker to a newer change", async () => {
      let newer = false;
      const slow: AppIconShell = {
        phone: "iphone",
        set: () => Promise.resolve(false),
        current: () => {
          newer = true;
          return Promise.resolve("door");
        },
      };
      expect(await changeIcon(slow, "dusk", () => !newer)).toBeNull();
      expect(await changeIcon(refusing("door"), "dusk", () => false)).toBeNull();
    });

    it("lets only the newest of two changes move the picker, whichever answers first", async () => {
      for (const order of [
        [0, 1],
        [1, 0],
      ]) {
        let change = 0;
        const answers: Array<(yes: boolean) => void> = [];
        const shell: AppIconShell = {
          phone: "android",
          set: () => new Promise((resolve) => answers.push(resolve)),
          // Not either look asked for, so a fall into the refused path shows.
          current: () => Promise.resolve("door"),
        };
        const first = ++change;
        const older = changeIcon(shell, "daylight", () => first === change);
        const second = ++change;
        const newer = changeIcon(shell, "porch-light", () => second === change);
        for (const at of order) answers[at]?.(true);
        expect(await older).toBeNull();
        expect(await newer).toEqual({ look: "porch-light", refused: false });
      }
    });
  });
});
