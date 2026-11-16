import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["crash/**/*.test.ts"],
    // The suite starts many processes and examines files of 15 MiB, so one file at a time
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
