// The overview docs keep up with the project's shape (AGENTS.md, "The
// overview docs"). No feature's pull request reads them, so they went stale
// unnoticed: by 2026-11-01 ARCHITECTURE.md §3 and the README's layout had two
// crates where there were three, and §5's schema was missing three tables and
// two columns, though a rule already said to update the README's layout.
//
// Checked here, because a script can check them: every workspace crate and
// every top-level directory git tracks is named in ARCHITECTURE.md §3 and in
// the README's layout, and §5's SQL has exactly the tables and columns the
// migrations leave behind. What runs where and milestone status can't be
// read from the code; the rule alone covers those.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

/**
 * The text of a Markdown section: from the heading that `heading` matches to
 * the next heading at the same level or above. Throws when it isn't there, so
 * a renamed heading fails here rather than checking nothing.
 */
export function section(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) throw new Error(`no heading matching ${heading}`);
  const level = /^#+/.exec(lines[start])[0].length;
  const end = lines.findIndex((line, i) => i > start && /^#+ /.test(line) && /^#+/.exec(line)[0].length <= level);
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** The fenced blocks in some Markdown, of one language or of any. */
export function fenced(markdown, language = "") {
  const blocks = [];
  let open = null;
  for (const line of markdown.split("\n")) {
    if (open === null) {
      const fence = /^```(\S*)\s*$/.exec(line);
      if (fence && (!language || fence[1] === language)) open = [];
    } else if (/^```\s*$/.test(line)) {
      blocks.push(open.join("\n"));
      open = null;
    } else open.push(line);
  }
  return blocks;
}

/** A table or column name: bare, or quoted any of the three ways SQLite takes. */
const NAME = String.raw`("[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|\w+)`;
const unquote = (name) => name.replace(/^["`[]|["`\]]$/g, "");

/** A statement that changes which tables or columns there are. */
const SCHEMA = /^(?:CREATE (?:TEMP |TEMPORARY )?(?:VIRTUAL )?TABLE|ALTER TABLE|DROP TABLE)\b/i;

/**
 * The column names in a CREATE TABLE's parentheses. Table constraints
 * (PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK, CONSTRAINT) and an FTS5 table's
 * options (`tokenize = 'porter'`, `content='messages'`) aren't columns.
 */
function columns(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter((part) => part && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(part) && !/^\w+\s*=/.test(part))
    .map((part) => unquote(new RegExp(`^${NAME}`).exec(part)?.[1] ?? part.split(/\s+/)[0]));
}

const CREATE = new RegExp(String.raw`^CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?${NAME} ?(?:USING \w+ ?)?\((.*)\)(?: ?(?:WITHOUT ROWID|STRICT))*$`, "i");
const ADD = new RegExp(String.raw`^ALTER TABLE ${NAME} ADD (?:COLUMN )?${NAME}`, "i");
const DROP_COLUMN = new RegExp(String.raw`^ALTER TABLE ${NAME} DROP (?:COLUMN )?${NAME}$`, "i");
const RENAME_TABLE = new RegExp(String.raw`^ALTER TABLE ${NAME} RENAME TO ${NAME}$`, "i");
const RENAME_COLUMN = new RegExp(String.raw`^ALTER TABLE ${NAME} RENAME (?:COLUMN )?${NAME} TO ${NAME}$`, "i");
const DROP_TABLE = new RegExp(String.raw`^DROP TABLE (IF EXISTS )?${NAME}$`, "i");

/**
 * The tables, and each one's columns, that some SQL leaves behind, applied in
 * order to `tables` (a Map of name to a Set of columns). Order matters: a
 * migration that rebuilds a table makes the new one, drops the old one and
 * renames the new one into its place.
 *
 * A statement that changes the tables in a way this can't follow throws,
 * naming it, rather than being passed over: a table this couldn't read is a
 * table the check would say nothing about (#807's review).
 */
export function applySql(sql, tables = new Map()) {
  const statements = sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim().replace(/\s+/g, " "));
  const unreadable = (statement) => new Error(`can't follow this schema change, so the check can't vouch for the schema: ${statement.slice(0, 120)}`);
  const known = (name, statement) => {
    const table = tables.get(unquote(name));
    if (!table) throw unreadable(statement);
    return table;
  };
  for (const statement of statements) {
    let m;
    if ((m = CREATE.exec(statement))) {
      tables.set(unquote(m[1]), new Set(columns(m[2])));
    } else if ((m = ADD.exec(statement))) {
      known(m[1], statement).add(unquote(m[2]));
    } else if ((m = RENAME_TABLE.exec(statement))) {
      tables.set(unquote(m[2]), known(m[1], statement));
      tables.delete(unquote(m[1]));
    } else if ((m = RENAME_COLUMN.exec(statement))) {
      const table = known(m[1], statement);
      if (!table.delete(unquote(m[2]))) throw unreadable(statement);
      table.add(unquote(m[3]));
    } else if ((m = DROP_COLUMN.exec(statement))) {
      if (!known(m[1], statement).delete(unquote(m[2]))) throw unreadable(statement);
    } else if ((m = DROP_TABLE.exec(statement))) {
      if (!tables.delete(unquote(m[2])) && !m[1]) throw unreadable(statement);
    } else if (SCHEMA.test(statement)) {
      throw unreadable(statement);
    }
  }
  return tables;
}

/** What doesn't match between the migrations' tables and a doc's, in words. */
export function schemaDifferences(migrations, doc) {
  const found = [];
  for (const [table, cols] of migrations) {
    const documented = doc.get(table);
    if (!documented) {
      found.push(`table ${table} is missing (${[...cols].join(", ")})`);
      continue;
    }
    for (const col of cols) if (!documented.has(col)) found.push(`${table}.${col} is missing`);
    for (const col of documented) if (!cols.has(col)) found.push(`${table}.${col} is in the doc, but no migration leaves it`);
  }
  for (const table of doc.keys()) if (!migrations.has(table)) found.push(`table ${table} is in the doc, but no migration leaves it`);
  return found;
}

/** Whether a layout names `dir/` as a whole word, not inside another name. */
const names = (text, dir) => new RegExp(String.raw`(^|[\s/(,])${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "m").test(text);

test("a section runs to the next heading at its level, and a missing heading throws", () => {
  const markdown = "# A\n## 3. Layout\nkeep\n### deeper\nkeep too\n## 4. Next\ngone";
  assert.equal(section(markdown, /^## 3\. /), "## 3. Layout\nkeep\n### deeper\nkeep too");
  assert.throws(() => section(markdown, /^## 9\. /), /no heading/);
});

test("fenced blocks are read whole, and only of the language asked for", () => {
  const markdown = "```sql\nCREATE TABLE a (x);\n```\ntext\n```\nplain\n```";
  assert.deepEqual(fenced(markdown, "sql"), ["CREATE TABLE a (x);"]);
  assert.deepEqual(fenced(markdown), ["CREATE TABLE a (x);", "plain"]);
});

test("the schema reader follows migrations in order", () => {
  const tables = applySql(`
    CREATE TABLE users (
      id BLOB PRIMARY KEY,            -- a comment, with a comma
      name TEXT NOT NULL CHECK (length(name) > 0),
      old TEXT,
      UNIQUE (name, id)
    );
    CREATE VIRTUAL TABLE fts USING fts5(body, title UNINDEXED, tokenize = 'porter', content='users');
    CREATE TABLE nonces (n BLOB PRIMARY KEY) WITHOUT ROWID;
    ALTER TABLE users ADD COLUMN time_zone TEXT;
    ALTER TABLE users DROP COLUMN old;
    ALTER TABLE users RENAME COLUMN name TO username;
    CREATE TABLE gone (x);
    DROP TABLE IF EXISTS gone;
    DROP TABLE IF EXISTS never_made;
    CREATE TABLE rooms (id BLOB, old TEXT);
    CREATE TABLE rooms_new (id BLOB, topic TEXT);
    DROP TABLE rooms;
    ALTER TABLE rooms_new RENAME TO rooms;
    CREATE TRIGGER t AFTER INSERT ON users BEGIN
      INSERT INTO fts(rowid, body) VALUES (new.rowid, new.username);
    END;
  `);
  assert.deepEqual(
    Object.fromEntries([...tables].map(([name, cols]) => [name, [...cols].sort()])),
    {
      users: ["id", "time_zone", "username"],
      fts: ["body", "title"],
      nonces: ["n"],
      rooms: ["id", "topic"],
    },
  );
});

test("quoted names are read as the names they quote", () => {
  const tables = applySql(`
    CREATE TABLE "quoted" ("id" BLOB PRIMARY KEY, [name] TEXT, \`kind\` TEXT);
    ALTER TABLE \`quoted\` ADD COLUMN "extra" TEXT;
    ALTER TABLE quoted RENAME COLUMN [name] TO "label";
  `);
  assert.deepEqual([...tables.get("quoted")].sort(), ["extra", "id", "kind", "label"]);
});

test("a schema change it can't follow fails, naming it, rather than being passed over (#807)", () => {
  const known = "CREATE TABLE users (id BLOB, name TEXT);";
  for (const sql of [
    "CREATE TEMP TABLE scratch (x);",
    "CREATE TABLE main.users2 (id BLOB);",
    "CREATE TABLE copy AS SELECT * FROM users;",
    `${known} ALTER TABLE missing ADD COLUMN x TEXT;`,
    `${known} ALTER TABLE users RENAME COLUMN nope TO x;`,
    `${known} ALTER TABLE users DROP COLUMN nope;`,
    "DROP TABLE never_made;",
  ]) {
    assert.throws(() => applySql(sql), /can't follow this schema change/, sql);
  }
  assert.doesNotThrow(() => applySql(`${known} CREATE INDEX i ON users(name); UPDATE users SET name = 'x'; INSERT INTO users VALUES (1, 'a');`));
});

test("a missing table, a missing column and one the migrations dropped are all named", () => {
  const migrations = new Map([["users", new Set(["id", "deleted_at"])], ["exports", new Set(["id"])]]);
  const doc = new Map([["users", new Set(["id", "old"])], ["gone", new Set(["x"])]]);
  assert.deepEqual(schemaDifferences(migrations, doc), [
    "users.deleted_at is missing",
    "users.old is in the doc, but no migration leaves it",
    "table exports is missing (id)",
    "table gone is in the doc, but no migration leaves it",
  ]);
});

test("a layout names a directory only as a whole word", () => {
  assert.ok(names("├─ crates/\n│  └─ linger-sfu/", "linger-sfu"));
  assert.ok(names("packaging/arch/  the package", "packaging"));
  assert.ok(!names("crates/linger-sfu-old/", "linger-sfu"));
  assert.ok(!names("subassets/", "assets"));
  assert.ok(names("└─ .github/              # CI", ".github"));
  assert.ok(!names("x.github/", ".github"));
});

test("ARCHITECTURE.md §5's schema has every table and column the migrations leave, and no others", () => {
  const dir = "crates/linger-server/migrations";
  const migrations = new Map();
  for (const file of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".sql")).sort()) {
    applySql(read(join(dir, file)), migrations);
  }
  assert.ok(migrations.has("users"), "the migrations were read");
  const doc = new Map();
  for (const block of fenced(section(read("ARCHITECTURE.md"), /^## 5\. /), "sql")) applySql(block, doc);
  assert.deepEqual(schemaDifferences(migrations, doc), [], "ARCHITECTURE.md §5 is out of step with the migrations");
});

test("ARCHITECTURE.md §3 and the README's layout name every crate and top-level directory", () => {
  const members = /members\s*=\s*\[([^\]]*)\]/.exec(read("Cargo.toml"));
  assert.ok(members, "Cargo.toml lists the workspace's members");
  const crates = [...members[1].matchAll(/"crates\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(crates.length > 0, "the workspace has crates");
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0");
  const top = [...new Set(tracked.filter((path) => path.includes("/")).map((path) => path.split("/")[0]))];
  assert.ok(top.includes(".github"), "dot-directories are checked too (#807's review)");
  const layouts = {
    "ARCHITECTURE.md §3": fenced(section(read("ARCHITECTURE.md"), /^## 3\. /)).join("\n"),
    "the README's layout": fenced(section(read("README.md"), /^## .*Development/))[0] ?? "",
  };
  for (const [where, text] of Object.entries(layouts)) {
    const missing = [...crates, ...top].filter((dir) => !names(text, dir));
    assert.deepEqual(missing, [], `${where} doesn't name these`);
  }
});
