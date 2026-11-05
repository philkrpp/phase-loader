import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "../src/check.js";
import { fake } from "./fake-sdk.js";
import { APP_ID, syncFake, TOKEN, useFakeChild, validConfig, writeConfig } from "./helpers.js";

vi.mock("@napi-rs/keyring", () => import("./fake-sdk.js"));

const SENTINEL = "SENTINEL-c0ffee-value";

/** A git repo with phase.config.json, .env.example and the given files; `tracked` ones are committed-staged. */
function repo(files: Record<string, string>, tracked: string[]): string {
  const dir = writeConfig(validConfig());
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-q");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git("add", "--", ...tracked);
  return dir;
}

beforeEach(() => {
  useFakeChild();
  fake.keyring.set("phase|repo/dev", TOKEN);
  vi.stubEnv("PHASE_TOKEN_SOURCE", undefined);
  vi.stubEnv("PHASE_PERSONAL_APP", undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("check --offline", () => {
  it("check offline counts a documented name read through a helper as used", async () => {
    const dir = repo(
      {
        ".env.example": "KEY_HELPER=\nKEY_DQ=\nKEY_TPL=\nKEY_GONE=\nKEY_PYGET=\n",
        "server/env.ts":
          "function optional(n: string) { return process.env[n] }\n" +
          "const a = optional('KEY_HELPER'); const b = required(\"KEY_DQ\"); const c = flag(`KEY_TPL`);\n",
        "tool.py": 'import os\nv = os.environ.get("KEY_PYGET")\nw = os.environ.get("KEY_PYNEW", "x")\n',
      },
      [".env.example", "server/env.ts", "tool.py", "phase.config.json"],
    );
    const { ok, report } = await check({ cwd: dir, offline: true });
    expect(ok).toBe(false);
    expect(report).toMatch(/orphan[^\n]*\n\s*KEY_GONE$/im);
    expect(report).toMatch(/undocumented[^\n]*\n\s*KEY_PYNEW$/im);
    for (const name of ["KEY_HELPER", "KEY_DQ", "KEY_TPL", "KEY_PYGET"]) expect(report).not.toContain(name);
  });

  it("check offline finds undocumented KEY_A and orphan KEY_B", async () => {
    const dir = repo(
      {
        ".env.example": "KEY_B=\nKEY_OK=\nKEY_PY=\n",
        "src/a.ts": "const a = process.env.KEY_A; const b = process.env['KEY_OK']; const m = import.meta.env.KEY_META;",
        "app/x.py": 'import os\nx = os.environ["KEY_PY"]\ny = os.getenv("KEY_PY2")\n',
      },
      [".env.example", "src/a.ts", "app/x.py", "phase.config.json"],
    );
    const { ok, report } = await check({ cwd: dir, offline: true });
    expect(ok).toBe(false);
    expect(report).toMatch(/undocumented[^\n]*\n[^\n]*KEY_A/);
    expect(report).toContain("KEY_META");
    expect(report).toContain("KEY_PY2");
    expect(report).toMatch(/orphan[^\n]*\n[^\n]*KEY_B/i);
    expect(report).not.toContain("KEY_OK");
    expect(report).not.toMatch(/^.*KEY_PY\b(?!2).*$/m);
  });

  it("check ignores node_modules and untracked files", async () => {
    const dir = repo(
      {
        ".env.example": "KEY_OK=\n",
        "src/a.ts": "process.env.KEY_OK",
        "node_modules/pkg/index.js": "process.env.IN_MODULES",
        "src/untracked.ts": "process.env.UNTRACKED",
      },
      [".env.example", "src/a.ts"],
    );
    const { ok, report } = await check({ cwd: dir, offline: true });
    expect(ok).toBe(true);
    expect(report).not.toContain("IN_MODULES");
    expect(report).not.toContain("UNTRACKED");
  });

  it("ignores runtime built-ins like NODE_ENV and works without a token or network", async () => {
    fake.keyring.clear();
    fake.keyringThrows = true;
    const dir = repo({ ".env.example": "KEY_OK=\n", "src/a.ts": "process.env.NODE_ENV; process.env.KEY_OK; import.meta.env.DEV" }, [
      ".env.example",
      "src/a.ts",
    ]);
    const { ok } = await check({ cwd: dir, offline: true });
    expect(ok).toBe(true);
  });

  it("works when git ls-files prints more than 1 MB", async () => {
    const dir = repo({ ".env.example": "KEY_OK=\n", "src/a.ts": "process.env.KEY_OK" }, [".env.example", "src/a.ts"]);
    // index entries only (no files on disk): cheap, and check skips tracked files missing in the working tree
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: "", encoding: "utf8" }).trim();
    const entries = Array.from({ length: 9000 }, (_, i) => `100644 ${blob}\tbulk/${"f".repeat(120)}-${i}.txt\n`).join("");
    execFileSync("git", ["update-index", "--index-info"], { cwd: dir, input: entries });
    const { ok } = await check({ cwd: dir, offline: true });
    expect(ok).toBe(true);
  });

  it("fails clearly without .env.example", async () => {
    const dir = repo({ "src/a.ts": "1" }, ["src/a.ts"]);
    await expect(check({ cwd: dir, offline: true })).rejects.toThrow(/\.env\.example/);
  });

  it("outside a git repository it is an error, not an empty pass", async () => {
    const dir = writeConfig(validConfig());
    writeFileSync(join(dir, ".env.example"), "A=\n");
    const empty = mkdtempSync(join(tmpdir(), "phase-loader-nogit-"));
    writeFileSync(join(empty, "phase.config.json"), JSON.stringify(validConfig()));
    writeFileSync(join(empty, ".env.example"), "A=\n");
    await expect(check({ cwd: empty, offline: true })).rejects.toThrow(/git/);
  });
});

describe("check (online)", () => {
  it("compares the example with the Phase names; never prints values", async () => {
    fake.apps.push({
      id: APP_ID,
      name: "repo",
      secrets: { Development: { "/": { IN_BOTH: SENTINEL, ONLY_PHASE: SENTINEL }, "/local": {} } },
    });
    syncFake();
    const dir = repo(
      { ".env.example": "IN_BOTH=\nONLY_EXAMPLE=\n", "src/a.ts": "process.env.IN_BOTH; process.env.ONLY_EXAMPLE" },
      [".env.example", "src/a.ts"],
    );
    const { ok, report } = await check({ cwd: dir });
    expect(ok).toBe(false);
    expect(report).toMatch(/not in Phase[^\n]*\n[^\n]*ONLY_EXAMPLE/);
    expect(report).toMatch(/not in .env.example[^\n]*\n[^\n]*ONLY_PHASE/);
    expect(report).not.toContain("IN_BOTH");
    expect(report).not.toContain(SENTINEL);
  });

  it("external names are neither undocumented, orphan nor missing in Phase", async () => {
    fake.apps.push({ id: APP_ID, name: "repo", secrets: { Development: { "/": { IN_BOTH: SENTINEL, OTEL_X: SENTINEL }, "/local": {} } } });
    syncFake();
    const dir = repo(
      {
        ".env.example": "IN_BOTH=\nOTEL_X=\nWORKER_TIER=\n",
        "src/a.ts": "process.env.IN_BOTH; process.env.WORKER_TIER; process.env.PATH; process.env.COOLIFY_ONLY",
      },
      [".env.example", "src/a.ts"],
    );
    writeFileSync(join(dir, "phase.config.json"), JSON.stringify({ ...validConfig(), external: ["WORKER_TIER", "OTEL_X", "COOLIFY_ONLY"] }));
    const { ok, report } = await check({ cwd: dir });
    expect(report).toBe("Env names are consistent.");
    expect(ok).toBe(true);
  });
});
