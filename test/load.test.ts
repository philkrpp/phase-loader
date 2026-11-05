import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPhaseEnv, PhaseLoaderError, readToken } from "../src/index.js";
import { fetchChild } from "../src/load.js";
import { fake } from "./fake-sdk.js";
import { APP_ID, PERSONAL_ID, sdkCalls, syncFake, TOKEN, useFakeChild, validConfig, writeConfig } from "./helpers.js";

vi.mock("@napi-rs/keyring", () => import("./fake-sdk.js"));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const SENTINEL = "SENTINEL-c0ffee-value";
let stderr: string[];

function setup(config: Record<string, unknown> = validConfig()): string {
  return writeConfig(config);
}

function load(cwd: string, keep?: string[]): ReturnType<typeof loadPhaseEnv> {
  syncFake();
  return loadPhaseEnv("dev", keep ? { cwd, keep } : { cwd });
}

function repoApp(root: Record<string, string>, local: Record<string, string> = {}): void {
  fake.apps.push({ id: APP_ID, name: "repo", secrets: { Development: { "/": root, "/local": local } } });
}

function personalApp(values: Record<string, string>): void {
  fake.apps.push({ id: PERSONAL_ID, name: "repo-local-me", secrets: { Development: { "/": values } } });
}

async function errorOf(promise: Promise<unknown>): Promise<PhaseLoaderError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PhaseLoaderError);
  return error as PhaseLoaderError;
}

beforeEach(() => {
  useFakeChild();
  fake.keyring.set("phase|repo/dev", TOKEN);
  vi.stubEnv("PHASE_TOKEN_SOURCE", undefined);
  vi.stubEnv("PHASE_PERSONAL_APP", undefined);
  vi.stubEnv("PHASE_TOKEN_REPO_DEV", undefined);
  vi.mocked(spawn).mockClear();
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

describe("loadPhaseEnv", () => {
  it("merges layers later-wins", async () => {
    repoApp({ A: "root", B: "root" }, { B: "local", C: "local" });
    const { env, layers } = await load(setup());
    expect(env).toEqual({ A: "root", B: "local", C: "local" });
    expect(layers).toEqual(["repo /", "repo /local"]);
    const calls = sdkCalls();
    expect(calls.filter((c) => c.constructed)).toEqual([
      { constructed: { token: TOKEN, host: "https://phase.example.test" } },
    ]);
    expect(calls.filter((c) => c.init)).toHaveLength(1);
    expect(calls.filter((c) => c.get).map((c) => c.get)).toEqual([
      { appId: APP_ID, envName: "Development", path: "/" },
      { appId: APP_ID, envName: "Development", path: "/local" },
    ]);
  });

  it("runs the SDK in a node child without shell; token only on stdin, child stderr piped", async () => {
    repoApp({ A: "root" });
    vi.stubEnv("PHASE_TOKEN_SOURCE", "env");
    vi.stubEnv("PHASE_TOKEN_REPO_DEV", SENTINEL);
    await load(setup());
    const [command, args, options] = vi.mocked(spawn).mock.calls.at(-1) as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([fetchChild.script]);
    expect(options).toMatchObject({ stdio: ["pipe", "pipe", "pipe"] });
    expect(options.shell).toBeUndefined();
    expect(JSON.stringify(args)).not.toContain(SENTINEL);
  });

  it("the SDK child gets a minimal env: no PHASE_TOKEN_*, PHASE_TOKEN_SOURCE, PHASE_PERSONAL_APP; PATH, proxy and CA kept", async () => {
    repoApp({ A: "root" });
    vi.stubEnv("PHASE_TOKEN_SOURCE", "env");
    vi.stubEnv("PHASE_TOKEN_REPO_DEV", SENTINEL);
    vi.stubEnv("PHASE_PERSONAL_APP", "repo");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", SENTINEL);
    vi.stubEnv("https_proxy", "http://proxy.example.test:3128");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/etc/ca.pem");
    vi.stubEnv("SSL_CERT_FILE", "/etc/ssl.pem");
    await load(setup());
    const options = vi.mocked(spawn).mock.calls.at(-1)?.[2] as { env: Record<string, string> };
    expect(Object.keys(options.env).filter((k) => /^PHASE_/.test(k))).toEqual([]);
    expect(options.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(options.env.PATH).toBe(process.env.PATH);
    expect(options.env.https_proxy).toBe("http://proxy.example.test:3128");
    expect(options.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ca.pem");
    expect(options.env.SSL_CERT_FILE).toBe("/etc/ssl.pem");
    expect(JSON.stringify(options.env)).not.toContain(SENTINEL);
  });

  it("personal layer last, by keyring app name resolved to the app id", async () => {
    repoApp({ A: "root" }, { A: "local", B: "local" });
    personalApp({ B: "personal" });
    fake.keyring.set("phase|repo/personal-app", "repo-local-me");
    const { env, layers } = await load(setup());
    expect(env).toEqual({ A: "local", B: "personal" });
    expect(layers).toEqual(["repo /", "repo /local", "personal /"]);
    const gets = sdkCalls().filter((c) => c.get);
    expect(gets.at(-1)?.get).toEqual({ appId: PERSONAL_ID, envName: "Development", path: "/" });
    expect(sdkCalls().filter((c) => c.init)).toHaveLength(1);
  });

  it("PHASE_PERSONAL_APP overrides the keyring and accepts an app id", async () => {
    repoApp({ A: "root" });
    personalApp({ A: "personal" });
    fake.keyring.set("phase|repo/personal-app", "other-app");
    vi.stubEnv("PHASE_PERSONAL_APP", PERSONAL_ID);
    const { env } = await load(setup());
    expect(env).toEqual({ A: "personal" });
  });

  it("personal layer skipped with a reason when unset", async () => {
    repoApp({ A: "root" });
    const { env, layers } = await load(setup());
    expect(env).toEqual({ A: "root" });
    expect(layers).toEqual(["repo /", "repo /local"]);
    expect(stderr.join("")).toMatch(/personal layer skipped: .*repo\/personal-app.*PHASE_PERSONAL_APP/);
  });

  it("a target without personal ignores PHASE_PERSONAL_APP and prints nothing", async () => {
    repoApp({ A: "root" });
    personalApp({ A: "personal" });
    vi.stubEnv("PHASE_PERSONAL_APP", PERSONAL_ID);
    const config = validConfig();
    delete (config.targets as Record<string, Record<string, unknown>>).dev!.personal;
    const { env, layers } = await load(setup(config));
    expect(env).toEqual({ A: "root" });
    expect(layers).toEqual(["repo /", "repo /local"]);
    expect(stderr.join("")).toBe("");
  });

  it("personal app that the token cannot see is an error, not a silent skip", async () => {
    repoApp({ A: "root" });
    fake.keyring.set("phase|repo/personal-app", "missing-app");
    const error = await errorOf(load(setup()));
    expect(error.message).toBe(
      'Phase export failed: personal / (invalid-app) Check the personal app from keyring account "repo/personal-app".',
    );
  });

  it('throws naming KEY when a value starts with "${"', async () => {
    repoApp({ KEY: "${other::Development.KEY}", OK: "x${y}" });
    const error = await errorOf(load(setup()));
    expect(error.message).toContain("KEY");
    expect(error.message).not.toContain("OK");
    expect(error.message).not.toContain("other::");
  });

  it("allowLiteral lets KEY through", async () => {
    repoApp({ KEY: "${literal}" });
    const { env } = await load(setup({ ...validConfig(), allowLiteral: ["KEY"] }));
    expect(env.KEY).toBe("${literal}");
  });

  it("require missing key → error lists names only", async () => {
    repoApp({ PRESENT: SENTINEL });
    const cwd = setup({ ...validConfig(), require: ["PRESENT", "MISSING_ONE", "MISSING_TWO"] });
    const error = await errorOf(load(cwd));
    expect(error.message).toContain("MISSING_ONE");
    expect(error.message).toContain("MISSING_TWO");
    expect(error.message).not.toContain("PRESENT");
    expect(error.message).not.toContain(SENTINEL);
  });

  it("keep leaves an existing process value out of the result", async () => {
    repoApp({ A: "phase", B: "phase" });
    vi.stubEnv("A", "mine");
    const { env } = await load(setup(), ["A", "UNSET"]);
    expect(env).toEqual({ B: "phase" });
  });

  it("an SDK HTTP error thrown inside its async executor becomes 'Phase export failed: <app> <path> (<status>)'", async () => {
    repoApp({ A: "root" });
    fake.getError = `Error: 403: ${SENTINEL}`;
    fake.getThrow = "executor-throw";
    const error = await errorOf(load(setup()));
    expect(error.message).toBe("Phase export failed: repo / (403)");
  });

  it("a network error thrown inside the executor maps to unreachable", async () => {
    repoApp({ A: "root" });
    fake.getError = "Error fetching secrets: AxiosError: getaddrinfo ENOTFOUND phase.example.test";
    fake.getThrow = "executor-throw";
    const error = await errorOf(load(setup()));
    expect(error.message).toBe("Phase export failed: repo / (unreachable)");
  });

  it("a get() that never settles is killed after the timeout", async () => {
    repoApp({ A: "root" });
    fake.getHangs = true;
    fetchChild.timeoutMs = 500;
    const error = await errorOf(load(setup()));
    expect(error.message).toBe("Phase export failed: repo / (timeout)");
  });

  it("the SDK's clean rejection for an unknown app id maps to invalid-app", async () => {
    const config = validConfig();
    (config.targets as Record<string, Record<string, unknown>>).dev!.layers = [
      { app: "gone", appId: "33333333-3333-4333-8333-333333333333", path: "/" },
    ];
    const error = await errorOf(load(setup(config)));
    expect(error.message).toBe("Phase export failed: gone / (invalid-app)");
  });

  it("an unknown error thrown in the executor maps to error, without its text", async () => {
    repoApp({ A: "root" });
    fake.getError = { message: `boom ${SENTINEL}` };
    fake.getThrow = "executor-throw";
    const error = await errorOf(load(setup()));
    expect(error.message).toBe("Phase export failed: repo / (error)");
  });

  it("a child that exits without a response is reported as crashed", async () => {
    fetchChild.script = `${fetchChild.script}.missing.ts`;
    const error = await errorOf(load(setup()));
    expect(error.message).toBe("Phase export failed: init (crashed)");
  });

  it("reports an unreachable host and a rejected token on init", async () => {
    fake.initError = { message: "Failed to initialize session. Please check your token and network connection." };
    const unreachable = await errorOf(load(setup()));
    expect(unreachable.message).toMatch(/not reachable at https:\/\/phase\.example\.test/);
    fake.initError = `Error: 401: ${SENTINEL}`;
    const rejected = await errorOf(load(setup()));
    expect(rejected.message).toMatch(/401/);
    expect(rejected.message).toContain("repo/dev");
  });

  it("unknown target names the known targets", async () => {
    syncFake();
    const error = await errorOf(loadPhaseEnv("prod", { cwd: setup() }));
    expect(error.message).toMatch(/prod.*dev/);
  });

  it("error messages and stderr never contain a value or token", async () => {
    const cwd = setup({ ...validConfig(), require: ["NEEDED"] });
    fake.keyring.set("phase|repo/dev", SENTINEL);
    fake.keyring.set("phase|repo/personal-app", SENTINEL);
    fake.warn = `Failed to resolve reference \${${SENTINEL}}`; // SDK-style warning on the child's stderr
    const messages: string[] = [];
    const collect = async (): Promise<void> => {
      messages.push((await errorOf(load(cwd))).message);
    };

    repoApp({ A: SENTINEL, LIT: `\${${SENTINEL}}` });
    await collect(); // personal app (value = sentinel) not found
    fake.keyring.delete("phase|repo/personal-app");
    await collect(); // require missing
    fake.apps = [];
    repoApp({ NEEDED: SENTINEL, LIT: `\${${SENTINEL}}` });
    await collect(); // literal reference
    fake.getError = `Error: 500: ${SENTINEL}`;
    fake.getThrow = "executor-throw";
    await collect(); // SDK error with body, thrown in the executor
    fake.getError = undefined;
    fake.getHangs = true;
    fetchChild.timeoutMs = 300;
    await collect(); // timeout
    fake.getHangs = false;
    fake.initError = `Error: 403: ${SENTINEL}`;
    await collect(); // init error with body
    fake.keyring.delete("phase|repo/dev");
    await collect(); // no token

    expect(messages).toHaveLength(7);
    for (const message of messages) expect(message).not.toContain(SENTINEL);
    expect(stderr.join("")).not.toContain(SENTINEL);
  });
});

describe("readToken", () => {
  it("reads the keyring account of service phase", () => {
    expect(readToken("repo/dev")).toBe(TOKEN);
  });

  it("env token fallback when keyring throws", () => {
    fake.keyringThrows = true;
    vi.stubEnv("PHASE_TOKEN_REPO_DEV", "env-token");
    expect(readToken("repo/dev")).toBe("env-token");
  });

  it("env token fallback when the keyring has no entry", () => {
    fake.keyring.delete("phase|repo/dev");
    vi.stubEnv("PHASE_TOKEN_REPO_DEV", "env-token");
    expect(readToken("repo/dev")).toBe("env-token");
  });

  it("the keyring wins over the env variable when it has an entry", () => {
    vi.stubEnv("PHASE_TOKEN_REPO_DEV", "env-token");
    expect(readToken("repo/dev")).toBe(TOKEN);
  });

  it("PHASE_TOKEN_SOURCE=env skips the keyring", () => {
    vi.stubEnv("PHASE_TOKEN_SOURCE", "env");
    vi.stubEnv("PHASE_TOKEN_REPO_DEV", "env-token");
    expect(readToken("repo/dev")).toBe("env-token");
  });

  it("missing token names the account and the env variable, never a value", () => {
    fake.keyringThrows = true;
    expect(() => readToken("repo/dev")).toThrow(PhaseLoaderError);
    expect(() => readToken("repo/dev")).toThrow(/repo\/dev.*PHASE_TOKEN_REPO_DEV/);
  });
});
