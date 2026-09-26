import { describe, expect, it } from "vitest";
import { cardOnly, excerpt, joinList, verbFor } from "./words";

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

describe("a message that is only a link", () => {
  const url = "https://millrace-trail.org/river-loop";
  const known = (href: string) => href === url;

  it("shows just the card when there is one", () => {
    expect(cardOnly(url, [url], known)).toBe(true);
    expect(cardOnly(`  ${url}\n`, [url], known)).toBe(true);
  });

  it("keeps the words when there are words, more links, or no card", () => {
    expect(cardOnly(`look: ${url}`, [url], known)).toBe(false);
    expect(cardOnly(`${url} ${url}/2`, [url, `${url}/2`], known)).toBe(false);
    expect(cardOnly(url, [url], () => false)).toBe(false);
    expect(cardOnly("", [], known)).toBe(false);
  });
});
