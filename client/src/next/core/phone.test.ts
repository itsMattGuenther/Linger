import { describe, expect, it } from "vitest";
import { isPhone, thisDevice } from "./phone";
import { windowRole } from "./role";

describe("the phone app", () => {
  it("is the page the phone's window opens, and nothing else", () => {
    expect(isPhone("?shell=phone")).toBe(true);
    expect(isPhone("")).toBe(false);
    expect(isPhone("?shell=desktop")).toBe(false);
    expect(isPhone("?window=chat&server=x&room=y")).toBe(false);
  });

  it("is still the list, the owner: its address names no other window", () => {
    expect(windowRole("?shell=phone", "main")).toBe("list");
    expect(windowRole("?shell=phone", null)).toBe("list");
  });

  it("calls the device what it is", () => {
    expect(thisDevice(true)).toBe("this phone");
    expect(thisDevice(false)).toBe("this computer");
  });
});
