// Builds src/lib/emoji/data.ts, the app's emoji list (#359), from Emojibase
// (MIT, a dev dependency only: nothing of it ships but what this writes).
//
//   node scripts/emoji-data.mjs
//
// Every emoji Unicode has, in Unicode's order, with what the picker and the
// `:shortcode:` list need and nothing else:
//
//   [glyph, label, group, shortcodes, tags, version, skins?]
//
// Shortcodes are Discord's own first (Discord took EmojiOne's names, which
// Emojibase keeps as JoyPixels': `:slight_smile:`, `:upside_down:`, `:rofl:`),
// then GitHub's and Slack's where they differ, so whichever someone learned
// works. `version` is the Unicode emoji version, for hiding what this
// computer's emoji font can't draw. Skin tones are the five toned glyphs, in
// order from light to dark. Components (bare skin tones, hair) and the
// regional indicator letters are left out: nobody picks them alone.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const data = require("emojibase-data/en/data.json");
const presets = ["joypixels", "github", "iamcal"].map((name) => require(`emojibase-data/en/shortcodes/${name}.json`));
const COMPONENT = 2;

const shortcodesOf = (hexcode) => {
  const names = [];
  for (const preset of presets) {
    const found = preset[hexcode];
    for (const name of Array.isArray(found) ? found : found ? [found] : []) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
};

// Emojibase writes some emoji with an emoji-style mark (U+FE0F) after a
// character that is drawn as an emoji anyway (everything from U+1F000), so
// its 👍 isn't the 👍 people type. That mark goes; the one ❤️ needs stays.
const plain = (glyph) => glyph.replace(/([\u{1F000}-\u{1FFFF}])\uFE0F/gu, "$1");

const rows = data
  .filter((emoji) => emoji.group !== undefined && emoji.group !== COMPONENT)
  .sort((a, b) => a.order - b.order)
  .map((emoji) => {
    // A handful have no shortcode anywhere: their name, written like one.
    const named = shortcodesOf(emoji.hexcode);
    const shortcodes = named.length > 0 ? named : [emoji.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")];
    const row = [plain(emoji.emoji), emoji.label, emoji.group, shortcodes, emoji.tags ?? [], emoji.version];
    if (emoji.skins) {
      // One of each tone, light to dark: the five single-tone glyphs.
      const tones = emoji.skins.filter((skin) => typeof skin.tone === "number").sort((a, b) => a.tone - b.tone);
      if (tones.length === 5) row.push(tones.map((skin) => plain(skin.emoji)));
    }
    return row;
  });

const out = join(here, "../src/lib/emoji/data.ts");
const before = (() => {
  try {
    return readFileSync(out, "utf8");
  } catch {
    return "";
  }
})();
// A .ts module, as src/lib holds only those, with the list as one JSON
// string: parsed once when it loads, which is quicker than a literal this big.
const text = `// Made by scripts/emoji-data.mjs from Emojibase (MIT). Don't edit by hand:
// run \`node scripts/emoji-data.mjs\` again. See ./index.ts for what each row is.
import type { EmojiRow } from "./index";

const rows: EmojiRow[] = JSON.parse(${JSON.stringify(JSON.stringify(rows))});
export default rows;
`;
writeFileSync(out, text);
const skins = rows.filter((row) => row.length > 6).length;
console.log(`${rows.length} emoji, ${skins} with skin tones, ${(text.length / 1024).toFixed(0)} KB${before === text ? " (unchanged)" : ""}`);
