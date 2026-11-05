import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPhaseEnvSync, PhaseLoaderError } from "../src/index.js";
import { fetchChild } from "../src/load.js";
import { fake } from "./fake-sdk.js";
import { APP_ID, syncFake, TOKEN, useFakeChild, validConfig, writeConfig } from "./helpers.js";

vi.mock("@napi-rs/keyring", () => import("./fake-sdk.js"));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});

const SENTINEL = "SENTINEL-c0ffee-value";
const KEYS = ["SYNC_A", "SYNC_B", "SYNC_KEEP", "SYNC_LIT"];
let stdout: string[];

function repoApp(root: Record<string, string>): void {
  fake.apps.push({ id: APP_ID, name: "repo", secrets: { Development: { "/": root, "/local": {} } } });
}

function load(config: Record<string, unknown> = validConfig(), keep?: string[]): ReturnType<typeof loadPhaseEnvSync> {
  syncFake();
  return loadPhaseEnvSync("dev", { cwd: writeConfig(config), ...(keep ? { keep } : {}) });
}

beforeEach(() => {
  useFakeChild();
  fake.keyring.set("phase|repo/dev", TOKEN);
  vi.stubEnv("PHASE_TOKEN_SOURCE", undefined);
  vi.stubEnv("PHASE_PERSONAL_APP", undefined);
  for (const key of KEYS) vi.stubEnv(key, undefined);
  vi.mocked(execFileSync).mockClear();
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("loadPhaseEnvSync", () => {
  it("sync loader assigns env and child stdout is not inherited", () => {
    repoApp({ SYNC_A: SENTINEL, SYNC_B: "b" });
    const { env, layers } = load();
    expect(env).toEqual({ SYNC_A: SENTINEL, SYNC_B: "b" });
    expect(layers).toEqual(["repo /", "repo /local"]);
    expect(process.env.SYNC_A).toBe(SENTINEL);
    expect(process.env.SYNC_B).toBe("b");
    const [file, args, options] = vi.mocked(execFileSync).mock.calls.at(-1) as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(file).toBe(process.execPath);
    expect(args).toEqual([fetchChild.script]);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.shell).toBeUndefined();
    expect(typeof options.timeout).toBe("number");
    expect(JSON.parse(options.input as string).token).toBe(TOKEN);
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    expect(stdout.join("")).not.toContain(SENTINEL);
  });

  it("keep leaves an existing process value alone", () => {
    repoApp({ SYNC_A: "phase", SYNC_KEEP: "phase" });
    vi.stubEnv("SYNC_KEEP", "mine");
    const { env } = load(validConfig(), ["SYNC_KEEP"]);
    expect(env).toEqual({ SYNC_A: "phase" });
    expect(process.env.SYNC_KEEP).toBe("mine");
  });

  it("the SDK child gets a minimal env", () => {
    repoApp({ SYNC_A: "a" });
    vi.stubEnv("PHASE_TOKEN_SOURCE", "env");
    vi.stubEnv("PHASE_TOKEN_REPO_DEV", SENTINEL);
    vi.stubEnv("PHASE_PERSONAL_APP", "repo");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", SENTINEL);
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.test:3128");
    load();
    const options = vi.mocked(execFileSync).mock.calls.at(-1)?.[2] as unknown as { env: Record<string, string> };
    expect(Object.keys(options.env).filter((k) => /^PHASE_/.test(k))).toEqual([]);
    expect(options.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(options.env.PATH).toBe(process.env.PATH);
    expect(options.env.HTTPS_PROXY).toBe("http://proxy.example.test:3128");
    expect(JSON.stringify(options.env)).not.toContain(SENTINEL);
  });

  it("shares the checks of the async loader: ${ literal, require, allowLiteral", () => {
    repoApp({ SYNC_LIT: "${other::Development.X}" });
    expect(() => load()).toThrow(/Unresolved Phase reference in: SYNC_LIT/);
    expect(process.env.SYNC_LIT).toBeUndefined();
    expect(load({ ...validConfig(), allowLiteral: ["SYNC_LIT"] }).env.SYNC_LIT).toBe("${other::Development.X}");
    expect(() => load({ ...validConfig(), require: ["NOPE"] })).toThrow(/NOPE/);
  });

  it("child failures become PhaseLoaderError without text from the child", () => {
    repoApp({ SYNC_A: "a" });
    fake.getError = `Error: 403: ${SENTINEL}`;
    fake.getThrow = "executor-throw";
    const error = (() => {
      try {
        load();
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(PhaseLoaderError);
    expect((error as Error).message).toBe("Phase export failed: repo / (403)");
  });

  it("a hanging child is killed after the timeout", () => {
    repoApp({ SYNC_A: "a" });
    fake.getHangs = true;
    fetchChild.timeoutMs = 500;
    expect(() => load()).toThrow("Phase export failed: repo / (timeout)");
  });

  it("a missing child script is reported as crashed", () => {
    fetchChild.script = `${fetchChild.script}.missing.ts`;
    expect(() => load()).toThrow("Phase export failed: init (crashed)");
  });
});
