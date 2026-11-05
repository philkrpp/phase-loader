import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crossSpawn from "cross-spawn";
import { PhaseLoaderError, run } from "../src/index.js";
import { fake } from "./fake-sdk.js";
import { APP_ID, syncFake, TOKEN, useFakeChild, validConfig, writeConfig } from "./helpers.js";

vi.mock("@napi-rs/keyring", () => import("./fake-sdk.js"));
vi.mock("cross-spawn", async (importOriginal) => {
  const original = await importOriginal<{ default: typeof import("cross-spawn") }>();
  return { default: vi.fn(original.default) };
});

const SENTINEL = "SENTINEL-c0ffee-value";
let stderr: string[];
let out: string;

function repoValues(values: Record<string, string>): void {
  fake.apps.push({ id: APP_ID, name: "repo", secrets: { Development: { "/": values } } });
  syncFake();
}

beforeEach(() => {
  useFakeChild();
  fake.keyring.set("phase|repo/dev", TOKEN);
  vi.stubEnv("PHASE_PERSONAL_APP", undefined);
  vi.spyOn(process, "cwd").mockReturnValue(writeConfig(validConfig()));
  out = mkdtempSync(join(tmpdir(), "phase-loader-run-"));
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("run", () => {
  it("multiline/PEM/=/quotes value byte-exact in child env", async () => {
    const values = {
      PEM: "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBg\nkqhkiG9w0=\n-----END PRIVATE KEY-----\n",
      EQ: "a=b==c",
      QUOTES: `"double" 'single' \`back\` $HOME \\n`,
      SPACES: "  padded  ",
      UNICODE: "äöü ✓ 😀",
    };
    repoValues(values);
    const file = join(out, "env.json");
    const script =
      "const keys=['PEM','EQ','QUOTES','SPACES','UNICODE','PHASE_ENV_LOADED'];" +
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]]))))";
    const code = await run("dev", [process.execPath, "-e", script, file]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...values, PHASE_ENV_LOADED: "dev" });
    expect(stderr.join("")).toContain("[env] loaded 5 keys from Phase (dev: repo / + repo /local)");
    expect(stderr.join("")).not.toContain("BEGIN PRIVATE KEY");
  });

  it("run forwards SIGINT and returns child exit code 3", async () => {
    repoValues({ A: "1" });
    const ready = join(out, "ready");
    const script =
      "process.on('SIGINT',()=>process.exit(3));" +
      "require('node:fs').writeFileSync(process.argv[1],'');setInterval(()=>{},1000)";
    const pending = run("dev", [process.execPath, "-e", script, ready]);
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000, interval: 20 });
    process.emit("SIGINT");
    await expect(pending).resolves.toBe(3);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("a spawn error (NUL byte in a value) never quotes the value", async () => {
    repoValues({ BAD: `a\u0000${SENTINEL}` });
    const error = await run("dev", [process.execPath, "-e", "1"]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PhaseLoaderError);
    expect((error as Error).message).toBe(`Could not start "${process.execPath}" (ERR_INVALID_ARG_VALUE).`);
    expect(stderr.join("")).not.toContain(SENTINEL);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("starts the command through cross-spawn (Windows .cmd shims) without shell: true", async () => {
    repoValues({ A: "1" });
    expect(await run("dev", [process.execPath, "-e", "1"])).toBe(0);
    const [command, args, options] = vi.mocked(crossSpawn).mock.calls.at(-1) as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(["-e", "1"]);
    expect(options.stdio).toBe("inherit");
    expect(options.shell).toBeUndefined();
  });

  it("rejects an empty command", async () => {
    await expect(run("dev", [])).rejects.toThrow(/command/);
  });
});
