import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // work/ is gitignored scratch: copies of test files left there by a review must not run with the suite.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "work/**"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
