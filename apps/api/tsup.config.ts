import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  // The shared engine is TypeScript source in the monorepo, so bundle it in.
  noExternal: ["@hades/core"],
});
