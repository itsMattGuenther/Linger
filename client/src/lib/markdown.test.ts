import { describe, expect, it } from "vitest";

import {
  type Block,
  type Inline,
  linkTargets,
  mentionCanStart,
  mentionHandles,
  parseMarkdown,
  plainText,
  safeHref,
} from "./markdown";

/** The text of a body with the formatting flattened, for terse assertions. */
function textOf(source: string): string {
  return plainText(source);
}

function firstBlock(source: string): Block | undefined {
  return parseMarkdown(source)[0];
}

function inlineKinds(source: string): string[] {
  const block = firstBlock(source);
  if (block?.kind !== "paragraph") return [];
  return block.children.map((node: Inline) => node.kind);
}

describe("safeHref", () => {
  it("keeps the three schemes a message may link to", () => {
    expect(safeHref("https://linger.example/x")).toBe("https://linger.example/x");
    expect(safeHref("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    expect(safeHref("mailto:someone@linger.example")).toBe("mailto:someone@linger.example");
  });

  it("refuses the schemes that execute", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("  javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeHref("vbscript:msgbox")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
  });

  it("refuses a scheme hidden inside whitespace the URL parser strips", () => {
    // The browser's own parser drops tabs and newlines inside a scheme, which
    // is exactly the trick a hand-rolled check gets wrong. Normalising first
    // and then testing the result is why this comes out `javascript:`.
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
  });

  it("refuses anything that is not an absolute address", () => {
    expect(safeHref("/rooms/porch")).toBeNull();
    expect(safeHref("linger.example")).toBeNull();
    expect(safeHref("")).toBeNull();
  });
});

describe("inline formatting", () => {
  it("reads bold, italic, strikethrough and code", () => {
    expect(inlineKinds("**bold**")).toEqual(["strong"]);
    expect(inlineKinds("__bold__")).toEqual(["strong"]);
    expect(inlineKinds("*italic*")).toEqual(["em"]);
    expect(inlineKinds("_italic_")).toEqual(["em"]);
    expect(inlineKinds("~~gone~~")).toEqual(["strike"]);
    expect(inlineKinds("`code`")).toEqual(["code"]);
  });

  it("nests", () => {
    const block = firstBlock("**bold with *italic* inside**");
    expect(block?.kind).toBe("paragraph");
    if (block?.kind !== "paragraph") return;
    const strong = block.children[0];
    expect(strong?.kind).toBe("strong");
    if (strong?.kind !== "strong") return;
    expect(strong.children.map((node) => node.kind)).toEqual(["text", "em", "text"]);
  });

  it("leaves a lone delimiter alone", () => {
    expect(inlineKinds("a * b")).toEqual(["text"]);
    expect(inlineKinds("**unclosed")).toEqual(["text"]);
    expect(textOf("**unclosed")).toBe("**unclosed");
  });

  it("does not italicise arithmetic", () => {
    expect(inlineKinds("2 * 3 * 4")).toEqual(["text"]);
  });

  it("leaves an identifier with underscores inside it alone", () => {
    expect(inlineKinds("snake_case_name")).toEqual(["text"]);
    expect(textOf("snake_case_name")).toBe("snake_case_name");
    expect(inlineKinds("a_b_c and x_y")).toEqual(["text"]);
  });

  it("still emphasises an identifier whose underscores are on the outside", () => {
    // `__init__` comes out bold, which is what every markdown people have used
    // does with it, and it is the one case where the word-boundary rule cannot
    // help: there is no word character on either end to hold the delimiters
    // down. Backticks are the way to write it literally, and a dunder name
    // belongs in backticks anyway.
    expect(inlineKinds("__init__")).toEqual(["strong"]);
    expect(inlineKinds("`__init__`")).toEqual(["code"]);
  });

  it("treats what is inside a code span as characters", () => {
    const block = firstBlock("`a *b* c`");
    if (block?.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(block.children[0]).toEqual({ kind: "code", text: "a *b* c" });
  });

  it("takes one space off each end of a code span, so backticks can be code", () => {
    const block = firstBlock("`` ` ``");
    if (block?.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(block.children[0]).toEqual({ kind: "code", text: "`" });
  });

  it("honours backslash escapes", () => {
    expect(inlineKinds("\\*not italic\\*")).toEqual(["text"]);
    expect(textOf("\\*not italic\\*")).toBe("*not italic*");
  });
});

describe("links", () => {
  it("reads a labelled link", () => {
    const block = firstBlock("[the server](https://linger.example)");
    if (block?.kind !== "paragraph") throw new Error("expected a paragraph");
    const link = block.children[0];
    expect(link?.kind).toBe("link");
    if (link?.kind !== "link") return;
    expect(link.href).toBe("https://linger.example/");
    expect(link.text).toBe("the server");
  });

  it("refuses to build a link out of a scheme that executes", () => {
    // The whole thing stays on screen as the characters that were typed. It is
    // not stripped, because a reader is better served seeing what they were
    // sent than seeing a hole.
    expect(inlineKinds("[click me](javascript:alert(1))")).toEqual(["text"]);
    expect(textOf("[click me](javascript:alert(1))")).toBe("[click me](javascript:alert(1))");
  });

  it("finds a bare address", () => {
    const block = firstBlock("look at https://linger.example/porch please");
    if (block?.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(block.children.map((node) => node.kind)).toEqual(["text", "link", "text"]);
  });

  it("leaves sentence punctuation out of a bare address", () => {
    const block = firstBlock("go to https://linger.example.");
    if (block?.kind !== "paragraph") throw new Error("expected a paragraph");
    const link = block.children[1];
    if (link?.kind !== "link") throw new Error("expected a link");
    expect(link.text).toBe("https://linger.example");
  });

  it("keeps a paren the address opened and drops one it did not", () => {
    const wiki = firstBlock("https://en.wikipedia.org/wiki/Bracket_(disambiguation)");
    if (wiki?.kind !== "paragraph") throw new Error("expected a paragraph");
    const first = wiki.children[0];
    if (first?.kind !== "link") throw new Error("expected a link");
    expect(first.text).toBe("https://en.wikipedia.org/wiki/Bracket_(disambiguation)");

    const aside = firstBlock("(see https://linger.example)");
    if (aside?.kind !== "paragraph") throw new Error("expected a paragraph");
    const second = aside.children[1];
    if (second?.kind !== "link") throw new Error("expected a link");
    expect(second.text).toBe("https://linger.example");
  });

  it("does not find an address in the middle of a word", () => {
    expect(inlineKinds("nothttps://linger.example")).toEqual(["text"]);
  });

  /** Every link in a body, each with the links inside it (#508). */
  function linksIn(source: string): { href: string; inside: number }[] {
    const found: { href: string; inside: number }[] = [];
    const count = (nodes: readonly Inline[]): number =>
      nodes.reduce((total, node) => {
        if (node.kind === "link") return total + 1 + count(node.children);
        if (node.kind === "strong" || node.kind === "em" || node.kind === "strike") return total + count(node.children);
        return total;
      }, 0);
    const walk = (nodes: readonly Inline[]): void => {
      for (const node of nodes) {
        if (node.kind === "link") found.push({ href: node.href, inside: count(node.children) });
        if (node.kind === "link" || node.kind === "strong" || node.kind === "em" || node.kind === "strike") walk(node.children);
      }
    };
    for (const block of parseMarkdown(source)) if (block.kind === "paragraph") walk(block.children);
    return found;
  }

  it("never puts a link inside a link: an address in a link's words is words (#508)", () => {
    // The decoy: what you read is good.example, where it goes is evil.example.
    // As two links, one click opened both and pointing at it showed the decoy.
    expect(linksIn("[https://good.example/login](https://evil.example/steal)")).toEqual([
      { href: "https://evil.example/steal", inside: 0 },
    ]);
    expect(plainText("[https://good.example/login](https://evil.example/steal)")).toBe("https://good.example/login");
    // A link written inside a link's words stays the characters typed.
    expect(linksIn("[[https://a.example](https://b.example)](https://c.example)")).toEqual([
      { href: "https://c.example/", inside: 0 },
    ]);
    expect(plainText("[[https://a.example](https://b.example)](https://c.example)")).toBe("[https://a.example](https://b.example)");
    // Formatting in a link's words is still formatting, but no way in.
    expect(linksIn("[**https://a.example** and [b](https://b.example)](https://c.example)")).toEqual([
      { href: "https://c.example/", inside: 0 },
    ]);
    // What gets a card is what draws as a link: the real destination only.
    expect(linkTargets("[https://good.example/login](https://evil.example/steal)")).toEqual(["https://evil.example/steal"]);
  });

  it("keeps formatting, code, mentions and emoji in a link's words", () => {
    const block = firstBlock("[**bold** `code` @callie :fire:](https://linger.example)");
    if (block?.kind !== "paragraph") throw new Error("expected a paragraph");
    const link = block.children[0];
    if (link?.kind !== "link") throw new Error("expected a link");
    expect(link.children.map((node) => node.kind)).toEqual(["strong", "text", "code", "text", "mention", "text", "shortcode"]);
  });

  it("takes a link's title off its address rather than reading it as part of it (#508)", () => {
    // `[text](https://x "title")` became `https://x%20"title"/`.
    for (const title of [`"the trail"`, `'the trail'`, `(the trail)`, `"say \\"hi\\""`]) {
      expect(linksIn(`[text](https://linger.example/porch ${title})`)).toEqual([
        { href: "https://linger.example/porch", inside: 0 },
      ]);
      expect(linksIn(`[text](https://linger.example ${title})`)).toEqual([{ href: "https://linger.example/", inside: 0 }]);
    }
    expect(plainText(`[text](https://linger.example/porch "the trail")`)).toBe("text");
    // The title is dropped, not checked: a scheme that executes is still refused.
    expect(inlineKinds(`[text](javascript:alert(1) "title")`)).toEqual(["text"]);
  });
});

describe("blocks", () => {
  it("splits paragraphs on a blank line and keeps single newlines", () => {
    const blocks = parseMarkdown("one\nstill one\n\ntwo");
    expect(blocks.length).toBe(2);
    expect(textOf("one\nstill one\n\ntwo")).toBe("one still one two");
    const first = blocks[0];
    if (first?.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(first.children[0]).toEqual({ kind: "text", text: "one\nstill one" });
  });

  it("reads a fenced code block and keeps it literal", () => {
    const blocks = parseMarkdown("```rust\nlet x = *y;\n```");
    expect(blocks).toEqual([{ kind: "code", text: "let x = *y;" }]);
  });

  it("runs an unclosed fence to the end of the message", () => {
    expect(parseMarkdown("```\nstill code\nand this")).toEqual([
      { kind: "code", text: "still code\nand this" },
    ]);
  });

  it("reads a blockquote, and stops nesting before the stack does", () => {
    const one = firstBlock("> quoted");
    expect(one?.kind).toBe("quote");

    // A thousand `>` is something a person can type into a room, so the depth
    // cap is a correctness property, not a nicety.
    const deep = parseMarkdown(`${"> ".repeat(1000)}bottom`);
    expect(deep.length).toBe(1);
    expect(textOf(`${"> ".repeat(1000)}bottom`)).toContain("bottom");
  });

  it("reads bullet and numbered lists", () => {
    const bullets = firstBlock("- one\n- two");
    expect(bullets?.kind).toBe("list");
    if (bullets?.kind !== "list") return;
    expect(bullets.ordered).toBe(false);
    expect(bullets.items.length).toBe(2);

    const numbered = firstBlock("7. seven\n8. eight");
    if (numbered?.kind !== "list") throw new Error("expected a list");
    expect(numbered.ordered).toBe(true);
    expect(numbered.start).toBe(7);
    expect(numbered.items.length).toBe(2);
  });

  it("does not turn emphasis at the start of a line into a bullet", () => {
    expect(firstBlock("*emphasis* at the start")?.kind).toBe("paragraph");
  });

  it("survives what a person can hold a key down to produce", () => {
    expect(() => parseMarkdown("*".repeat(5000))).not.toThrow();
    expect(() => parseMarkdown("[".repeat(5000))).not.toThrow();
    expect(() => parseMarkdown("`".repeat(5000))).not.toThrow();
    expect(() => parseMarkdown("~~".repeat(5000))).not.toThrow();
  });
});

describe("plainText", () => {
  it("flattens a body to one line with the formatting off", () => {
    expect(plainText("**hi** _there_\n\n> quoted\n\n- a\n- b")).toBe("hi there quoted a b");
  });

  it("uses a link's label, not its address", () => {
    expect(plainText("see [the porch](https://linger.example/porch)")).toBe("see the porch");
  });
});

describe("mentions", () => {
  it("finds a name at the start of a word", () => {
    expect(mentionHandles("morning @callie")).toEqual(["callie"]);
    expect(mentionHandles("@callie!")).toEqual(["callie"]);
    expect(mentionHandles("(@callie)")).toEqual(["callie"]);
  });

  it("is not an email address", () => {
    expect(mentionHandles("write to matt@example.com")).toEqual([]);
  });

  it("does not stop short inside a longer word", () => {
    // The shape `[a-z0-9_]{2,24}` would happily match `matt` out of `matthews`,
    // and that would put a notification on the wrong person's name.
    expect(mentionHandles("@matthews")).toEqual(["matthews"]);
  });

  it("holds usernames to the shape the server enforces", () => {
    // Uppercase is not a username here: the server rejects rather than
    // normalizes, so `@Callie` is a word somebody typed.
    expect(mentionHandles("@Callie")).toEqual([]);
    expect(mentionHandles("@a")).toEqual([]);
    expect(mentionHandles("@m_42")).toEqual(["m_42"]);
  });

  it("is not a mention inside code", () => {
    expect(mentionHandles("`@callie`")).toEqual([]);
    expect(mentionHandles("```\n@callie\n```")).toEqual([]);
  });

  it("is not a mention when it was escaped", () => {
    expect(mentionHandles("\\@callie")).toEqual([]);
    expect(textOf("\\@callie")).toBe("@callie");
  });

  it("finds names inside formatting, quotes and lists", () => {
    expect(mentionHandles("**@callie** said")).toEqual(["callie"]);
    expect(mentionHandles("> @callie said")).toEqual(["callie"]);
    expect(mentionHandles("- ask @callie")).toEqual(["callie"]);
  });

  it("reports each name once, in the order they appear", () => {
    expect(mentionHandles("@dave and @callie and @dave")).toEqual(["dave", "callie"]);
  });

  it("flattens back to the characters that were typed", () => {
    expect(plainText("hey @callie look")).toBe("hey @callie look");
  });

  it("says where an @ can begin one, by the same rules (#267's @ list)", () => {
    expect(mentionCanStart("@", 0)).toBe(true);
    expect(mentionCanStart("hey @Jus", 4)).toBe(true);
    expect(mentionCanStart("> ask @", 6)).toBe(true);
    expect(mentionCanStart("**@", 2)).toBe(true);
    expect(mentionCanStart("you@example.com", 3)).toBe(false);
    expect(mentionCanStart("`@ju` said", 1)).toBe(false);
    expect(mentionCanStart("```\n@ju", 4)).toBe(false);
    expect(mentionCanStart("\\@ju", 1)).toBe(false);
    expect(mentionCanStart("hey", 1)).toBe(false);
    // A stand-in the body already holds can't fool it.
    expect(mentionCanStart("`zz0` @", 6)).toBe(true);
  });
});

describe("linkTargets", () => {
  it("finds what will draw as a link, normalised the way the server stores it", () => {
    expect(linkTargets("look at https://example.com and https://example.com/a")).toEqual([
      "https://example.com/",
      "https://example.com/a",
    ]);
    expect(linkTargets("[label](https://example.com/b)")).toEqual(["https://example.com/b"]);
  });

  it("agrees with what is drawn: a code span is not a link", () => {
    expect(linkTargets("`https://example.com`")).toEqual([]);
    expect(linkTargets("no addresses here")).toEqual([]);
  });

  it("has nothing to preview for an email address", () => {
    expect(linkTargets("[write](mailto:someone@example.com)")).toEqual([]);
  });

  it("says the same link once, and stops at four", () => {
    expect(linkTargets("https://a.example https://a.example")).toEqual(["https://a.example/"]);
    const many = [0, 1, 2, 3, 4, 5].map((n) => `https://s${n}.example`).join(" ");
    expect(linkTargets(many)).toHaveLength(4);
  });
});

describe("shortcodes (#359)", () => {
  const names = (source: string) =>
    (parseMarkdown(source)[0] as { children: { kind: string; name?: string }[] }).children.filter((node) => node.kind === "shortcode").map((node) => node.name);

  it("reads :name: at the start of a word, and one straight after another", () => {
    expect(names("hi :party_parrot: there")).toEqual(["party_parrot"]);
    expect(names(":party_parrot::party_parrot::fire:")).toEqual(["party_parrot", "party_parrot", "fire"]);
    expect(names(":+1: and :-1:")).toEqual(["+1", "-1"]);
  });

  it("leaves a time, an address and code alone", () => {
    expect(names("at 12:30:45")).toEqual([]);
    expect(names("see http://a:b:c")).toEqual([]);
    expect(names("`:fire:`")).toEqual([]);
    expect(plainText("great :fire: night")).toBe("great :fire: night");
  });
});
