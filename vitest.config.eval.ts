import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/eval/**/*.eval.ts"],
    testTimeout: 60000,
    reporters: ["default", "./test/eval/eval-reporter.ts"],
  },
});
