import { defineConfig } from "vite";

// The Pages workflow sets SITE_BASE to "/sqlite". A local build uses the root.
const site = process.env["SITE_BASE"];

export default defineConfig({
  base: site ? `${site.replace(/\/$/, "")}/` : "/",
  build: { target: "es2022" },
  // The pre-bundle of the dev server loses the file sqlite3.wasm next to the module, so the dev server serves the package as it is.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
});
