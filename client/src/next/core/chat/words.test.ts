import { describe, expect, it } from "vitest";
import { excerpt, joinList, verbFor } from "./words";

const said = (parts: ReturnType<typeof joinList<string>>) => parts.map((part) => ("item" in part ? part.item : part.text)).join("");

describe("chat window wording", () => {
  it("joins names the way people say them, and never turns them into a number", () => {
    expect(said(joinList(["Eli"]))).toBe("Eli");
    expect(said(joinList(["Eli", "Jules"]))).toBe("Eli and Jules");
    expect(said(joinList(["Eli", "Jules", "Dave"]))).toBe("Eli, Jules and Dave");
    expect(said(joinList(["Eli", "Jules", "Dave", "Callie", "Sam"]))).toBe("Eli, Jules, Dave and others");
    expect(joinList([])).toEqual([]);
  });

  it("agrees its verb with how many people it names", () => {
    expect(verbFor(1, "is", "are")).toBe("is");
    expect(verbFor(2, "is", "are")).toBe("are");
  });

  it("quotes a message's first words as plain text, trailing off", () => {
    expect(excerpt("**Perfect** timing. What are we `listening` to?")).toBe("Perfect timing. What are we listening to?");
    expect(excerpt("one\n\ntwo")).toBe("one two");
    expect(excerpt("a".repeat(200), 10)).toBe(`${"a".repeat(10)}…`);
  });
});
