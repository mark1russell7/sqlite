import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The protocol of the power-cut test needs no Docker. The power cut itself is in vitest.power.config.ts.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "power/protocol.test.ts"],
  },
});
