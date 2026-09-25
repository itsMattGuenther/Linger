import { describe, expect, it } from "vitest";

import type { Style } from "../generated/Style";
import type { User } from "../generated/User";
import { draftOf, isDirty, previewUser, styleOf, styleRequest, withColor } from "./nameStyle";

function style(over: Partial<Style> = {}): Style {
  return {
    font_key: "geist-sans",
    weight: 500,
    italic: false,
    fill: { kind: "solid", color: "azure" },
    effect: "none",
    msg_font_key: null,
    ...over,
  };
}

describe("draftOf", () => {
  it("opens on what is saved", () => {
    const draft = draftOf(
      style({ font_key: "newsreader", weight: 700, italic: true, effect: "glow" }),
    );
    expect(draft).toMatchObject({
      fontKey: "newsreader",
      weight: 700,
      italic: true,
      effect: "glow",
      gradient: false,
      from: "azure",
      msgFontKey: null,
    });
  });

  it("keeps a gradient's second color", () => {
    const draft = draftOf(style({ fill: { kind: "gradient", from: "rose", to: "amber" } }));
    expect(draft.gradient).toBe(true);
    expect(draft.from).toBe("rose");
    expect(draft.to).toBe("amber");
  });

  it("seeds the unused second color from the first", () => {
    // So the first click on `to` is a change and not a jump from some default
    // the person never picked.
    expect(draftOf(style({ fill: { kind: "solid", color: "mint" } })).to).toBe("mint");
  });

  it("falls back for keys this build has never heard of", () => {
    // Both of these are plain strings on the wire, so a server that knows a
    // face or a color this build does not is the ordinary case, not an error.
    const draft = draftOf(
      style({ font_key: "comic-sans", fill: { kind: "solid", color: "hotpink" } }),
    );
    expect(draft.fontKey).toBe("geist-sans");
    expect(draft.from).toBe("slate");
  });

  it("keeps a message font of null as null, not as a face", () => {
    expect(draftOf(style()).msgFontKey).toBeNull();
    expect(draftOf(style({ msg_font_key: "ibm-plex-sans" })).msgFontKey).toBe("ibm-plex-sans");
  });
});

it("opens a legacy message font on the reading face without a pending save", () => {
  const saved = style({ font_key: "jetbrains-mono", msg_font_key: "jetbrains-mono" });
  const draft = draftOf(saved);
  expect(draft.msgFontKey).toBeNull();
  expect(draft.fontKey).toBe("jetbrains-mono");
  expect(isDirty(draft, saved)).toBe(false);
  expect(saved.msg_font_key).toBe("jetbrains-mono");
});

describe("styleOf", () => {
  it("writes a solid fill from the first color only", () => {
    const draft = { ...draftOf(style()), from: "teal", to: "rose", gradient: false };
    expect(styleOf(draft).fill).toEqual({ kind: "solid", color: "teal" });
  });

  it("writes both colors for a gradient", () => {
    const draft = { ...draftOf(style()), from: "teal", to: "rose", gradient: true };
    expect(styleOf(draft).fill).toEqual({ kind: "gradient", from: "teal", to: "rose" });
  });

  it("round-trips a saved style unchanged", () => {
    for (const saved of [
      style(),
      style({ fill: { kind: "gradient", from: "rose", to: "amber" }, effect: "shimmer" }),
      style({ font_key: "silkscreen", weight: 700, italic: true, msg_font_key: "inter" }),
    ]) {
      expect(styleOf(draftOf(saved))).toEqual(saved);
    }
  });
});

describe("isDirty", () => {
  it("is false for an untouched draft", () => {
    const saved = style({ fill: { kind: "gradient", from: "rose", to: "amber" } });
    expect(isDirty(draftOf(saved), saved)).toBe(false);
  });

  it("ignores the second color while the fill is solid", () => {
    // Turning the gradient off and picking a different second color changes
    // nothing that gets sent, so the save button stays down.
    const saved = style({ fill: { kind: "solid", color: "azure" } });
    const draft = withColor(draftOf(saved), "to", "rose");
    expect(isDirty(draft, saved)).toBe(false);
  });

  it("notices each of the choices", () => {
    const saved = style();
    const base = draftOf(saved);
    expect(isDirty({ ...base, fontKey: "inter" }, saved)).toBe(true);
    expect(isDirty({ ...base, weight: 700 }, saved)).toBe(true);
    expect(isDirty({ ...base, italic: true }, saved)).toBe(true);
    expect(isDirty({ ...base, effect: "shimmer" }, saved)).toBe(true);
    expect(isDirty({ ...base, from: "rose" }, saved)).toBe(true);
    expect(isDirty({ ...base, gradient: true, to: "rose" }, saved)).toBe(true);
    expect(isDirty({ ...base, msgFontKey: "ibm-plex-sans" }, saved)).toBe(true);
  });
});

describe("styleRequest", () => {
  it("touches the style and nothing else", () => {
    const request = styleRequest(draftOf(style()));
    expect(request.display_name).toBeNull();
    expect(request.status).toBeNull();
    expect(request.entrance_sound).toBeNull();
    expect(request.style).toEqual(style());
  });
});

describe("previewUser", () => {
  it("is the same person wearing the draft", () => {
    const user: User = {
      id: "u1",
      username: "dave",
      display_name: "Dave",
      is_host: false,
      entrance_sound: null,
      last_seen_at: null,
      status: null,
      style: style(),
    };
    const draft = { ...draftOf(style()), gradient: true, from: "rose", to: "amber" };
    const preview = previewUser(user, draft);
    expect(preview.display_name).toBe("Dave");
    expect(preview.style.fill).toEqual({ kind: "gradient", from: "rose", to: "amber" });
    // The real user is untouched — the preview is a copy, not an edit.
    expect(user.style.fill).toEqual({ kind: "solid", color: "azure" });
  });
});
