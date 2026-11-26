import { describe, expect, it } from "vitest";
import { appIconShell, DEFAULT_LOOK, ICON_LOOKS, isIconLook, memoryIconShell } from "./appIcon";

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

  it("keeps a choice in memory outside the app", async () => {
    const shell = memoryIconShell("android");
    expect(await shell.current()).toBe("door");
    expect(await shell.set("daylight")).toBe(true);
    expect(await shell.current()).toBe("daylight");
  });
});
