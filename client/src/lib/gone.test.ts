import { describe, expect, it } from "vitest";
import { DELETED_ACCOUNT, nameless } from "./gone";

describe("nameless (#650)", () => {
  it("calls a deleted account Deleted account, and anybody else unknown someone", () => {
    const gone = new Set(["u-gone"]);
    expect(nameless("u-gone", gone)).toBe(DELETED_ACCOUNT);
    expect(nameless("u-removed", gone)).toBe("someone");
    expect(nameless("u-removed", gone, "Somebody")).toBe("Somebody");
    expect(nameless("u-gone", undefined)).toBe("someone");
  });
});
