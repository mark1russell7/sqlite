import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["power/**/*.test.ts"],
    // Each case starts one privileged container, so one file at a time
    fileParallelism: false,
    testTimeout: 180_000,
    // The first lab builds the image of LazyFS
    hookTimeout: 900_000,
  },
});
