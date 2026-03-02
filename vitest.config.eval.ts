import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/eval/**/*.eval.ts"],
    testTimeout: 30000,
  },
});
