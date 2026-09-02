import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
