import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("package exports", () => {
  // Bundled apps load the package with createRequire (no top-level await, which deadlocks in esbuild's lazy ESM
  // wrappers); require(esm) needs a non-"import" condition to resolve.
  it("resolves for require as well as import, to the same ESM entry", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    const root = pkg.exports["."];
    expect(root.import).toBe("./dist/index.js");
    expect(root.default).toBe(root.import);
  });
});
