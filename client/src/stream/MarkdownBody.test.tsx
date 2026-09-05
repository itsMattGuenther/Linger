/**
 * The accept criterion for T-304: an XSS attempt renders inert.
 *
 * These tests render the real component and read the markup a browser would be
 * handed, which is the only place the claim can actually be checked.
 * `renderToStaticMarkup` produces exactly the string React would put in the
 * document, with no browser involved.
 *
 * The two general assertions are the interesting ones. Every element in the
 * output has to come from a short list, and so does every attribute — which is
 * the allowlist ARCHITECTURE §7 asks for, stated as a property of the output
 * rather than as a list of tags somebody remembered to strip. A message body
 * that could contribute one element or one attribute would fail them, whatever
 * the trick was.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import MarkdownBody, { type MentionLookup } from "./MarkdownBody";

function render(source: string): string {
  return renderToStaticMarkup(<MarkdownBody source={source} />);
}

/** A server with two people on it: `matt` is you, `callie` is not. */
const lookup: MentionLookup = (handle) => {
  if (handle === "matt") return { name: "Matt", me: true };
  if (handle === "callie") return { name: "Callie", me: false };
  return null;
};

function renderWithPeople(source: string): string {
  return renderToStaticMarkup(<MarkdownBody source={source} mentions={lookup} />);
}

/** Every element in the markup. Escaped text has no `<` in it, so it is skipped
 *  here for the same reason a browser skips it: it is not an element. */
function elementsIn(markup: string): Set<string> {
  return new Set([...markup.matchAll(/<\/?([a-z][a-z0-9]*)/g)].map((found) => found[1] ?? ""));
}

/** Every attribute name in the markup. */
function attributesIn(markup: string): Set<string> {
  const tags = markup.matchAll(/<[a-z][a-z0-9]*((?:\s+[a-zA-Z-]+="[^"]*")*)\s*\/?>/g);
  return new Set(
    [...tags].flatMap((tag) =>
      [...(tag[1] ?? "").matchAll(/([a-zA-Z-]+)=/g)].map((found) => found[1] ?? ""),
    ),
  );
}

/** What `MarkdownBody.tsx` is allowed to draw, and nothing else. */
const ELEMENTS = [
  "p",
  "blockquote",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "del",
  "a",
  "span",
];
const ATTRIBUTES = ["class", "href", "title", "rel", "start"];

function assertInert(source: string): string {
  const markup = render(source);
  for (const element of elementsIn(markup)) expect(ELEMENTS).toContain(element);
  for (const attribute of attributesIn(markup)) expect(ATTRIBUTES).toContain(attribute);
  return markup;
}

describe("a message body cannot become markup", () => {
  it("renders a tag as the characters of a tag", () => {
    const markup = assertInert('<img src=x onerror="alert(1)">');
    expect(markup).toContain("&lt;img");
    // The word is on screen. It is text in a paragraph, which is the point:
    // nothing was stripped, and nothing was executed either.
    expect(markup).toContain("onerror=&quot;alert(1)&quot;");
  });

  it("renders a script tag as the characters of a script tag", () => {
    const markup = assertInert("<script>alert(document.cookie)</script>");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("renders a tag hidden inside formatting as characters too", () => {
    const markup = assertInert("**bold <svg onload=alert(1)>** and `<b>code</b>`");
    expect(markup).toContain("<strong>");
    expect(markup).toContain("&lt;svg");
    expect(markup).toContain("&lt;b&gt;code&lt;/b&gt;");
  });

  it("renders a tag inside a code fence as characters", () => {
    const markup = assertInert("```\n<iframe src=evil></iframe>\n```");
    expect(markup).toContain("&lt;iframe");
  });

  it("cannot be talked into a second attribute by breaking out of the first", () => {
    const markup = assertInert('[x](https://linger.example" onmouseover="alert(1))');
    expect(markup).toContain("onmouseover=&quot;");
  });

  it("stays inert through every shape at once", () => {
    assertInert(
      [
        "<img src=x onerror=alert(1)>",
        "> <svg/onload=alert(2)>",
        "- [a](javascript:alert(3))",
        "`<script>4</script>`",
        "***<a href=x>5</a>***",
        "```html\n<body onload=alert(6)>\n```",
      ].join("\n\n"),
    );
  });
});

describe("links", () => {
  it("will not build one out of a scheme that executes", () => {
    const markup = assertInert("[click me](javascript:alert(1))");
    expect(markup).not.toContain("<a");
    expect(markup).toContain("click me");
  });

  it("will not build one out of a data URL", () => {
    const markup = assertInert(
      "[report](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    );
    expect(markup).not.toContain("<a");
  });

  it("builds one out of an address, and says where it really goes", () => {
    const markup = assertInert("[the porch](https://linger.example/porch)");
    expect(markup).toContain('href="https://linger.example/porch"');
    // The text of a link is whatever the sender wrote; the title is the truth.
    expect(markup).toContain('title="https://linger.example/porch"');
    expect(markup).toContain('rel="noreferrer noopener"');
  });
});

describe("formatting", () => {
  it("draws the elements the subset allows", () => {
    const markup = assertInert(
      "**b** *i* ~~s~~ `c`\n\n> quoted\n\n- one\n- two\n\n1. first\n\n```\nblock\n```",
    );
    expect(markup).toContain("<strong>b</strong>");
    expect(markup).toContain("<em>i</em>");
    expect(markup).toContain("<del>s</del>");
    expect(markup).toContain(">c</code>");
    expect(markup).toContain("<blockquote");
    expect(markup).toContain("<ul");
    expect(markup).toContain("<ol");
    expect(markup).toContain("<pre");
  });

  it("keeps mono to code, and prose out of it", () => {
    // AGENTS 11: mono in a message body is a defect. SPEC §5.2 lists code as
    // one of mono's roles, so the mono classes may appear on code and nowhere
    // else — this is the test that keeps the exception from spreading.
    const markup = render("plain words `code` more words");
    expect(markup.match(/md-(inline-)?code/g)?.length).toBe(1);
  });
});

describe("mentions", () => {
  it("marks a name it knows, and says whose it is on the hover", () => {
    const markup = renderWithPeople("morning @callie");
    expect(markup).toContain('<span class="mention" title="Callie">@callie</span>');
  });

  it("marks your own name differently, because that is the whole point", () => {
    const markup = renderWithPeople("@matt did you see this");
    expect(markup).toContain('class="mention mention-me"');
  });

  it("leaves a name nobody answers to as the characters that were typed", () => {
    const markup = renderWithPeople("@nobody are you there");
    expect(markup).not.toContain("mention");
    expect(markup).toContain("@nobody");
  });

  it("cannot reach an attribute it did not choose", () => {
    // A display name is somebody else's text, and the hover is the one place it
    // lands. React escapes it into the value it was given rather than letting it
    // close the quote and start a second attribute — this is that, spelled out.
    const evil: MentionLookup = () => ({ name: '" onmouseover="alert(1)', me: false });
    const markup = renderToStaticMarkup(<MarkdownBody source="@callie" mentions={evil} />);
    expect(markup).toContain(
      '<span class="mention" title="&quot; onmouseover=&quot;alert(1)">@callie</span>',
    );
  });

  it("stays out of an inline code span, where an @ is just a character", () => {
    expect(renderWithPeople("`@matt`")).not.toContain("mention");
  });

  it("stays out of a code block too", () => {
    expect(renderWithPeople("```\n@matt\n```")).not.toContain("mention");
  });
});
