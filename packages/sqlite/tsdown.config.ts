import { defineConfig } from "tsdown";

// The build for npm: ES modules in build/, with types. The workspace runs the source (main is src/index.ts).
// The entry ./warning does not import node:sqlite, so a command can load it before node:sqlite.
export default defineConfig({
  entry: ["src/index.ts", "src/warning.ts"],
  outDir: "build",
  format: "esm",
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  // One output file for each source file: with `sideEffects: false`, a bundler drops each file that a user does not import.
  unbundle: true,
  publint: true,
});
