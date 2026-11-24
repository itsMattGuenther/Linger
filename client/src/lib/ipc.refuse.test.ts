import { describe, expect, it, vi } from "vitest";
import { refusedSignIn, refuseSignIns, saveSession } from "./ipc";

// One module, one switch: these run in order, before and after it's thrown.
describe("refusing sign-ins once the store says the person is under 13 (#953)", () => {
  it("saves as before until then", async () => {
    expect(refusedSignIn("https://a.example", "t0")).toBe(false);
    // Outside the app there's no keyring, which is what saving says.
    expect(await saveSession({ base_url: "https://a.example", refresh_token: "t0" })).toEqual({
      kind: "unavailable",
      reason: "Browser preview: sign-ins aren't saved here.",
    });
  });

  it("from then on saves nothing, and hands every sign-in to be told to its server", async () => {
    const told = vi.fn();
    refuseSignIns(told);
    expect(await saveSession({ base_url: "https://a.example", refresh_token: "late" })).toEqual({
      kind: "unavailable",
      reason: "Linger is for people 13 and older.",
    });
    expect(refusedSignIn("https://b.example", "share")).toBe(true);
    expect(told.mock.calls).toEqual([
      ["https://a.example", "late"],
      ["https://b.example", "share"],
    ]);
  });
});
