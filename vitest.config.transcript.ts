import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/eval/**/*.transcript.ts"],
    testTimeout: 120000,
    reporters: ["default", "./test/eval/eval-reporter.ts"],
  },
});
