import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { example } from "../src/example.js";
import { fake } from "./fake-sdk.js";
import { APP_ID, PERSONAL_ID, syncFake, TOKEN, useFakeChild, validConfig, writeConfig } from "./helpers.js";

vi.mock("@napi-rs/keyring", () => import("./fake-sdk.js"));

const SENTINEL = "SENTINEL-c0ffee-value";
let cwd: string;

beforeEach(() => {
  useFakeChild();
  fake.keyring.set("phase|repo/dev", TOKEN);
  vi.stubEnv("PHASE_TOKEN_SOURCE", undefined);
  vi.stubEnv("PHASE_PERSONAL_APP", undefined);
  fake.apps.push({
    id: APP_ID,
    name: "repo",
    secrets: { Development: { "/": { ZED: SENTINEL, ALPHA: SENTINEL, SHARED: SENTINEL }, "/local": { LOCAL_X: SENTINEL, SHARED: SENTINEL } } },
  });
  fake.apps.push({ id: PERSONAL_ID, name: "repo-me", secrets: { Development: { "/": { MY_OWN: SENTINEL } } } });
  fake.keyring.set("phase|repo/personal-app", "repo-me");
  cwd = writeConfig(validConfig());
  syncFake();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("example", () => {
  it("example output contains names and no value sentinel", async () => {
    const out = await example({ cwd, write: true });
    const file = readFileSync(join(cwd, ".env.example"), "utf8");
    expect(file).toBe("# repo /\nALPHA=\nSHARED=\nZED=\n\n# repo /local\nLOCAL_X=\n");
    expect(file).not.toContain(SENTINEL);
    expect(out).not.toContain(SENTINEL);
    expect(file).not.toContain("MY_OWN");
  });

  it("without --write prints a name diff and writes nothing", async () => {
    writeFileSync(join(cwd, ".env.example"), "ALPHA=\nOLD_ONE=\n");
    const out = await example({ cwd });
    expect(existsSync(join(cwd, ".env.example"))).toBe(true);
    expect(readFileSync(join(cwd, ".env.example"), "utf8")).toBe("ALPHA=\nOLD_ONE=\n");
    expect(out).toContain("+ LOCAL_X");
    expect(out).toContain("+ SHARED");
    expect(out).toContain("+ ZED");
    expect(out).toContain("- OLD_ONE");
    expect(out).not.toContain("ALPHA");
    expect(out).not.toContain(SENTINEL);
  });

  it("reports up to date when names match", async () => {
    await example({ cwd, write: true });
    expect(await example({ cwd })).toMatch(/up to date/);
  });
});
