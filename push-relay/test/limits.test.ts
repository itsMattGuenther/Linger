// The relay's limits are the server's, from the other side (PROTOCOL §5): a
// sealed address the relay makes has to fit what the server keeps, and what
// the server asks of the relay has to be what the relay takes. Read from the
// Rust, so a change on one side and not the other fails here.

import { describe, expect, it } from "vitest";

import limits from "../../crates/linger-core/src/limits.rs?raw";
import { MAX_TOKEN_CHARS, MAX_TTL_SECS } from "../src/index";

function constant(name: string): number {
  const found = new RegExp(`pub const ${name}: \\w+ = ([\\d_ *]+);`).exec(limits);
  if (!found?.[1]) throw new Error(`no ${name} in limits.rs`);
  return found[1]
    .split("*")
    .map((part) => Number(part.trim().replace(/_/g, "")))
    .reduce((a, b) => a * b, 1);
}

describe("the relay and the server agree", () => {
  it("on the longest sealed address", () => {
    expect(MAX_TOKEN_CHARS).toBe(constant("MAX_PUSH_SEALED_CHARS"));
  });

  it("on how long a notification may be held", () => {
    expect(constant("PUSH_KEEP_SECS")).toBeLessThanOrEqual(MAX_TTL_SECS);
    expect(constant("PUSH_KNOCK_KEEP_SECS")).toBeLessThanOrEqual(MAX_TTL_SECS);
  });
});
