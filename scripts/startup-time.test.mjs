import assert from "node:assert/strict";
import { test } from "node:test";
import { cpuTicks, flat, memory, parentPid, parsePpm, plan, settled, shrink, startTicks, summary } from "./startup-time.mjs";

/** A width × height image of one colour, as RGB bytes. */
const image = (width, height, rgb = [20, 26, 40]) => {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) data.set(rgb, i);
  return { width, height, data };
};
/** The same image with a block of rows painted, like a name appearing in the list. */
const withRows = (base, from, to, rgb = [230, 230, 230]) => {
  const copy = { ...base, data: Uint8Array.from(base.data) };
  for (let y = from; y < to; y++) for (let x = 0; x < base.width; x++) copy.data.set(rgb, (y * base.width + x) * 3);
  return copy;
};
const frames = (list) => list.map(([at, picture]) => ({ at, image: picture }));

test("median and worst, ignoring runs that measured nothing", () => {
  assert.deepEqual(summary([300, 100, 200]), { n: 3, median: 200, worst: 300 });
  assert.deepEqual(summary([100, 200, 300, 400]), { n: 4, median: 250, worst: 400 });
  assert.deepEqual(summary([null, 120, Number.NaN]), { n: 1, median: 120, worst: 120 });
  assert.deepEqual(summary([]), { n: 0, median: null, worst: null });
});

test("a PPM from grim, comment and all", () => {
  const pixels = Buffer.from([1, 2, 3, 4, 5, 6]);
  const parsed = parsePpm(Buffer.concat([Buffer.from("P6\n# from grim\n2 1\n255\n"), pixels]));
  assert.equal(parsed.width, 2);
  assert.equal(parsed.height, 1);
  assert.deepEqual([...parsed.data], [...pixels]);
  assert.throws(() => parsePpm(Buffer.from("P3\n1 1\n255\n0 0 0")), /binary PPM/);
  assert.throws(() => parsePpm(Buffer.concat([Buffer.from("P6\n2 2\n255\n"), pixels])), /short/);
});

test("shrinking keeps every other pixel each way", () => {
  const small = shrink({ width: 3, height: 2, data: Uint8Array.from({ length: 18 }, (_, i) => i) });
  assert.equal(small.width, 2);
  assert.equal(small.height, 1);
  assert.deepEqual([...small.data], [0, 1, 2, 6, 7, 8]);
});

test("a flat window has nothing drawn in it yet, whatever shows in its corners", () => {
  assert.equal(flat(image(40, 40), 24), true);
  assert.equal(flat(withRows(image(40, 40), 10, 12), 24), false);
  const corner = image(40, 40);
  corner.data.set([200, 30, 30], 0);
  assert.equal(flat(corner, 24), true);
});

test("open is the first photograph from which the window stays as it ends up", () => {
  const empty = image(10, 40);
  const waiting = withRows(empty, 18, 20);
  const list = withRows(withRows(empty, 2, 30), 18, 20);
  const result = settled(frames([[0, empty], [100, waiting], [200, waiting], [300, list], [400, list], [2000, list]]));
  assert.equal(result.done, 3);
  assert.equal(result.blank, 1);
  assert.equal(result.moving, 0);
});

test("a moment that only looked finished doesn't count", () => {
  const empty = image(10, 40);
  const list = withRows(empty, 2, 30);
  const flicker = withRows(empty, 2, 10);
  const result = settled(frames([[0, empty], [100, list], [200, flicker], [300, list], [2000, list]]));
  assert.equal(result.done, 3);
});

test("something that never stops moving is left out, and the rest still decides", () => {
  const empty = image(10, 40);
  const list = withRows(empty, 2, 30);
  // One row keeps changing colour, as a shimmering name does.
  const shimmer = (shade) => withRows(list, 35, 36, [shade, 100, 100]);
  const result = settled(frames([[0, empty], [100, shimmer(10)], [400, shimmer(90)], [900, shimmer(170)], [1500, shimmer(250)], [2100, shimmer(10)]]), { tailMs: 1500 });
  assert.equal(result.done, 1);
  assert.ok(result.moving > 0 && result.moving < 0.05);
});

test("the scrollbar showing for a moment on the right edge doesn't hold up open", () => {
  const empty = image(50, 40);
  const list = withRows(empty, 2, 30);
  const scrollbar = { ...list, data: Uint8Array.from(list.data) };
  for (let y = 5; y < 35; y++) for (let x = 48; x < 50; x++) scrollbar.data.set([120, 120, 120], (y * 50 + x) * 3);
  const result = settled(frames([[0, empty], [100, scrollbar], [1000, scrollbar], [1200, list], [3000, list]]));
  assert.equal(result.done, 1);
  // Anywhere else, the same change would.
  const elsewhere = withRows(list, 32, 34, [120, 120, 120]);
  assert.equal(settled(frames([[0, empty], [100, elsewhere], [1000, elsewhere], [1200, list], [3000, list]])).done, 3);
});

test("a window still changing at the end hasn't settled", () => {
  const empty = image(10, 40);
  const list = withRows(empty, 2, 30);
  assert.equal(settled(frames([[0, empty], [100, empty], [1000, list]])).done, null);
  assert.equal(settled([]).done, null);
});

test("/proc numbers, names with spaces and parentheses included", () => {
  const stat = "4242 (Web Content (x)) S 4100 4242 4242 0 -1 4194560 100 0 0 0 1234 567 0 0 20 0 30 0 99 0 0";
  assert.equal(parentPid(stat), 4100);
  assert.equal(cpuTicks(stat), 1234 + 567);
  assert.equal(startTicks(stat), 99);
  assert.deepEqual(memory("Rss:              227000 kB\nPss:              107000 kB\nPrivate_Clean:        1000 kB\nPrivate_Dirty:      99000 kB\n"), { rss: 227000, pss: 107000, uss: 100000 });
});

test("the friend group is the same every time, and within the server's rules", () => {
  const settings = { seed: 1, name: "The Porch", people: 22, rooms: ["general", "games", "music"], messages: 400, dms: [2, 4], online: 7 };
  const one = plan(settings);
  assert.deepEqual(plan(settings), one);
  assert.equal(one.names.length, 22);
  assert.equal(new Set(one.names).size, 22);
  assert.equal(one.names[one.me], "wren");
  assert.equal(one.posts.length, 400);
  assert.ok(one.posts.every((post) => post.body.length > 0 && post.body.length <= 8000 && post.room < 3 && post.author < 22));
  assert.deepEqual(one.dms.map((dm) => dm.members.length), [2, 4]);
  assert.ok(one.dms.every((dm) => dm.members[0] === one.me && new Set(dm.members).size === dm.members.length));
  assert.equal(one.around.filter(Boolean).length, 7);
  assert.equal(one.around[one.me], false);
  assert.equal(one.looks.filter((look) => look.style.effect === "shimmer").length, 1);
  assert.equal(plan({ ...settings, shimmer: false }).looks.filter((look) => look.style.effect === "shimmer").length, 0);
  const palette = new Set(["ember", "rust", "amber", "brass", "lime", "fern", "mint", "teal", "cyan", "sky", "azure", "indigo", "violet", "orchid", "rose", "slate"]);
  for (const { style } of one.looks) {
    const colors = style.fill.kind === "solid" ? [style.fill.color] : [style.fill.from, style.fill.to];
    assert.ok(colors.every((color) => palette.has(color)), JSON.stringify(style.fill));
  }
});
