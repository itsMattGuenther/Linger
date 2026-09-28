import { describe, expect, it } from "vitest";
import { valueParts } from "./statusLinks";

/** The links in a value, as [text, href]. */
function links(value: string): [string, string][] {
  return valueParts(value).flatMap((part) => (part.kind === "link" ? [[part.text, part.href] as [string, string]] : []));
}

describe("web addresses in a status field's value (#270)", () => {
  it("links an address typed out in full, as a message does", () => {
    expect(links("https://github.com/bendthebracket")).toEqual([["https://github.com/bendthebracket", "https://github.com/bendthebracket"]]);
    expect(links("see http://example.com/a?b=c#d")).toEqual([["http://example.com/a?b=c#d", "http://example.com/a?b=c#d"]]);
    expect(links("HTTPS://Example.com")).toEqual([["HTTPS://Example.com", "https://example.com/"]]);
  });

  it("links a bare name with a path, or starting with www., over https", () => {
    expect(links("github.com/bendthebracket")).toEqual([["github.com/bendthebracket", "https://github.com/bendthebracket"]]);
    expect(links("GitHub: github.com/bendthebracket")).toEqual([["github.com/bendthebracket", "https://github.com/bendthebracket"]]);
    expect(links("www.example.com")).toEqual([["www.example.com", "https://www.example.com/"]]);
    expect(links("open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")).toEqual([
      ["open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"],
    ]);
    expect(links("twitch.tv:8080/me")).toEqual([["twitch.tv:8080/me", "https://twitch.tv:8080/me"]]);
  });

  it("leaves the sentence's punctuation in the sentence", () => {
    expect(links("find me at github.com/you.")).toEqual([["github.com/you", "https://github.com/you"]]);
    expect(links("(github.com/you)")).toEqual([["github.com/you", "https://github.com/you"]]);
    expect(links("en.wikipedia.org/wiki/Heat_(1995_film)")).toEqual([["en.wikipedia.org/wiki/Heat_(1995_film)", "https://en.wikipedia.org/wiki/Heat_(1995_film)"]]);
    expect(links("https://linger.example, then bed")).toEqual([["https://linger.example", "https://linger.example/"]]);
  });

  it("links nothing else", () => {
    for (const words of [
      "Piranesi",
      "main.rs",
      "Node.js",
      "README.md",
      "example.com",
      "v0.4.3",
      "3.14/pi",
      "e.g. a book",
      "src/main.rs",
      "me@example.com",
      "me@example.com/x",
      "mailto:me@example.com",
      "javascript:alert(1)",
      "@matt",
      "**bold**",
      "ftp://example.com/file",
      "https://",
      "nothttps://example.com",
      "github.com9/x",
    ]) {
      expect(links(words), words).toEqual([]);
    }
    // Markdown isn't read: the address inside is an address, the words aren't a link.
    expect(links("[a link](https://example.com)")).toEqual([["https://example.com", "https://example.com/"]]);
  });

  it("gives back the value exactly, in order, when its parts are joined", () => {
    for (const value of ["GitHub: github.com/bendthebracket and https://x.example/y.", "no links at all", "", "a www.b.com c github.com/d"]) {
      expect(valueParts(value).map((part) => part.text).join("")).toBe(value);
    }
    expect(valueParts("a www.b.com c").map((part) => part.kind)).toEqual(["text", "link", "text"]);
  });

  it("finds two addresses in one value", () => {
    expect(links("github.com/a · https://b.example/c")).toEqual([
      ["github.com/a", "https://github.com/a"],
      ["https://b.example/c", "https://b.example/c"],
    ]);
  });
});
