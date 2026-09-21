import { describe, expect, it } from "vitest";

import type { Style } from "../generated/Style";
import type { User } from "../generated/User";
import { FONT_KEYS, fontVar } from "./fonts";
import { nameProps, paletteKey, personStyle } from "./names";

function person(style: Partial<Style>): User {
  return {
    id: "u1",
    username: "dave",
    display_name: "Dave",
    is_host: false,
    entrance_sound: null,
    last_seen_at: null,
    status: null,
    style: {
      font_key: "geist-sans",
      weight: 500,
      italic: false,
      fill: { kind: "solid", color: "azure" },
      effect: "none",
      msg_font_key: null,
      ...style,
    },
  };
}

describe("personStyle", () => {
  it("points a solid fill at the generated palette variable", () => {
    const style = personStyle(person({ fill: { kind: "solid", color: "azure" } }));
    expect(style["--person-name"]).toBe("var(--name-azure, var(--text-primary))");
    expect(style["--person-rule"]).toBe("var(--name-azure, var(--hairline-strong))");
    // A solid fill has no second stop, so the paint stays flat.
    expect(style["--person-to"]).toBeUndefined();
  });

  it("gives a gradient both stops, and the rule the first of them", () => {
    const style = personStyle(person({ fill: { kind: "gradient", from: "rose", to: "amber" } }));
    expect(style["--person-name"]).toBe("var(--name-rose, var(--text-primary))");
    expect(style["--person-rule"]).toBe("var(--name-rose, var(--hairline-strong))");
    expect(style["--person-to"]).toBe(
      "var(--name-amber, var(--name-rose, var(--text-primary)))",
    );
  });

  it("carries weight, slant and both fonts", () => {
    const style = personStyle(
      person({ font_key: "silkscreen", weight: 700, italic: true, msg_font_key: "ibm-plex-sans" }),
    );
    expect(style["--person-font"]).toBe("var(--font-silkscreen, var(--font-ui))");
    expect(style["--person-weight"]).toBe(700);
    expect(style["--person-slant"]).toBe("italic");
    expect(style["--person-msg-font"]).toBe("var(--font-ibm-plex-sans, var(--font-body))");
  });

  it.each(["geist-mono", "ibm-plex-mono", "jetbrains-mono", "commit-mono",
    "departure-mono", "silkscreen", "newsreader", "instrument-serif"])(
    "renders legacy %s message fonts in sans without changing the name or saved style",
    (key) => {
      const user = person({ font_key: key, msg_font_key: key });
      const result = personStyle(user);
      expect(result["--person-msg-font"]).toBe("var(--font-body)");
      expect(result["--person-font"]).toBe(`var(--font-${key}, var(--font-ui))`);
      expect(user.style.msg_font_key).toBe(key);
    },
  );

  it("falls back for somebody the store has never heard of", () => {
    const style = personStyle(undefined);
    expect(style["--person-name"]).toBe("var(--text-primary)");
    expect(style["--person-rule"]).toBe("var(--hairline-strong)");
    expect(style["--person-font"]).toBe("var(--font-ui)");
    expect(style["--person-weight"]).toBe(500);
    expect(style["--person-msg-font"]).toBe("var(--font-body)");
  });

  it("refuses a key that would escape the variable name", () => {
    // The server validates against linger-core::PALETTE (AGENTS rule 8); this is
    // the second lock, because user content is hostile and the key is about to
    // be interpolated into CSS.
    const nasty = person({ fill: { kind: "solid", color: "azure); color: red; --x:(" } });
    expect(paletteKey(nasty)).toBeNull();
    expect(personStyle(nasty)["--person-name"]).toBe("var(--text-primary)");

    const half = person({ fill: { kind: "gradient", from: "rose", to: "#ff00ff" } });
    expect(personStyle(half)["--person-to"]).toBeUndefined();
  });

  it("falls back for a font key this build has never heard of", () => {
    const style = personStyle(person({ font_key: "comic-sans" }));
    expect(style["--person-font"]).toBe("var(--font-ui)");
  });
});

describe("nameProps", () => {
  it("keeps the surface's own class and adds the person's", () => {
    expect(nameProps(person({}), "msg-author").className).toBe("name msg-author");
    expect(nameProps(person({})).className).toBe("name");
  });

  it("marks a gradient so the stylesheet can clip it, and leaves a solid alone", () => {
    expect(nameProps(person({ fill: { kind: "gradient", from: "rose", to: "amber" } }))[
      "data-name-fill"
    ]).toBe("gradient");
    expect(nameProps(person({}))["data-name-fill"]).toBeUndefined();
  });

  it("writes an effect only when there is one", () => {
    expect(nameProps(person({ effect: "shimmer" }))["data-name-effect"]).toBe("shimmer");
    expect(nameProps(person({ effect: "glow" }))["data-name-effect"]).toBe("glow");
    expect(nameProps(person({ effect: "none" }))["data-name-effect"]).toBeUndefined();
    expect(nameProps(undefined)["data-name-effect"]).toBeUndefined();
  });
});

describe("fontVar", () => {
  it("covers every key in the curated set", () => {
    // The mirror of `linger-core::FONTS`. If the Rust set grows, this is the
    // test that notices the stack in tokens.css was never added.
    expect(FONT_KEYS).toHaveLength(12);
    for (const key of FONT_KEYS) {
      expect(fontVar(key, "var(--font-ui)")).toBe(`var(--font-${key}, var(--font-ui))`);
    }
  });

  it("hands back the fallback for null and for anything else", () => {
    expect(fontVar(null, "var(--font-body)")).toBe("var(--font-body)");
    expect(fontVar("../../evil", "var(--font-body)")).toBe("var(--font-body)");
  });
});
