import { defineConfig } from "vitest/config";

// The frontend's pure logic — session labels, grouping, aging, the markdown
// parser — is arithmetic that cannot be checked by looking at the app, so it
// gets a test runner.
//
// This is not a component-testing setup: there is no DOM here and no testing
// library. Components are tested in a real browser (`tests/browser/`).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
