import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/fetch-child.ts"],
  format: "esm",
  platform: "node",
  dts: true,
  // `.js`/`.d.ts` (package is `type: module`), matching `bin` and `exports` in package.json.
  fixedExtension: false,
});
