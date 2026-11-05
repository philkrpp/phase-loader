import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, type PhaseConfig, type PhaseTarget } from "./config.js";
import { PhaseLoaderError } from "./errors.js";
import {
  FETCH_TIMEOUT_MS,
  readFetchOutput,
  type FetchContext,
  type FetchedLayer,
  type FetchRequest,
} from "./fetch-protocol.js";
import { readKeyring, readToken } from "./token.js";

export interface LoadedPhaseEnv {
  /** Merged values; never print them. */
  env: Record<string, string>;
  /** Exported layers in order, e.g. `["repo /", "repo /local", "personal /"]`. */
  layers: string[];
}

/** SDK child script, its timeout and extra env; internal, tests point `script` at a fake and pass its config. */
export const fetchChild: { script: string; timeoutMs: number; extraEnv: Record<string, string> } = {
  script: fileURLToPath(new URL("./fetch-child.js", import.meta.url)),
  timeoutMs: FETCH_TIMEOUT_MS,
  extraEnv: {},
};

/** Env the SDK child inherits: PATH, home, Windows root, proxy and CA settings; no token, no other secret. */
const CHILD_ENV = /^(?:PATH|HOME|USERPROFILE|SYSTEMROOT|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i;

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && CHILD_ENV.test(key)) env[key] = value;
  }
  return { ...env, ...fetchChild.extraEnv };
}

interface FetchOutcome {
  stdout: string;
  timedOut: boolean;
  exitCode: number | null;
}

interface Prepared {
  config: PhaseConfig;
  request: FetchRequest;
  ctx: FetchContext;
}

function prepare(target: string, cwd: string): Prepared {
  const config = loadConfig(cwd);
  const t = Object.hasOwn(config.targets, target) ? config.targets[target] : undefined;
  if (!t) {
    throw new PhaseLoaderError(
      `Unknown target "${target}" (phase.config.json defines: ${Object.keys(config.targets).join(", ")}).`,
    );
  }
  const token = readToken(t.account);
  const personal = personalApp(t);
  return {
    config,
    request: {
      host: config.host,
      token,
      envName: t.env,
      layers: t.layers.map(({ app, appId, path }) => ({ app, appId, path })),
      ...(personal ? { personal: personal.ref } : {}),
    },
    ctx: { host: config.host, account: t.account, personalSource: personal?.source },
  };
}

/** Exports every layer (unmerged, `personal /` last) after the shared child run; used by `example` and `check`. */
export async function fetchLayers(target: string, cwd: string): Promise<{ config: PhaseConfig; layers: FetchedLayer[] }> {
  const { config, request, ctx } = prepare(target, cwd);
  const outcome = await fetchInChild(request);
  return { config, layers: readFetchOutput(outcome.stdout, outcome, ctx) };
}

/** Merges the layers later-wins, applies `require`, `keep` and the `${` check; shared by the async and sync loader. */
function merge(target: string, config: PhaseConfig, fetched: FetchedLayer[], keep: string[] | undefined): LoadedPhaseEnv {
  const exported: Record<string, string> = {};
  for (const layer of fetched) for (const [key, value] of layer.entries) exported[key] = value;

  const missing = (config.targets[target]?.require ?? config.require).filter((key) => !Object.hasOwn(exported, key));
  if (missing.length > 0) {
    throw new PhaseLoaderError(
      `Phase export for "${target}" lacks required key(s): ${missing.join(", ")}. Check the token's access.`,
    );
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(exported)) {
    if (keep?.includes(key) && process.env[key] !== undefined) continue;
    env[key] = value;
  }

  const literal = Object.keys(env).filter((key) => env[key]?.startsWith("${") && !config.allowLiteral.includes(key));
  if (literal.length > 0) {
    throw new PhaseLoaderError(
      `Unresolved Phase reference in: ${literal.join(", ")}. Grant the token access to the referenced app, ` +
        `or list the key in "allowLiteral" if the value is meant literally.`,
    );
  }

  return { env, layers: fetched.map((l) => l.label) };
}

/**
 * Exports the layers of `target` from Phase and returns the merged values without touching `process.env`.
 * Layers merge in order (later wins), the personal app comes last. The SDK runs in a child process (it can throw
 * outside its promises) and resolves `${…}` references; a value that still starts with `${` (unreadable reference)
 * throws unless the key is in `allowLiteral`.
 * `keep`: keys whose existing `process.env` value wins; they are left out of the result.
 */
export async function loadPhaseEnv(
  target: string,
  opts: { cwd?: string; keep?: string[] } = {},
): Promise<LoadedPhaseEnv> {
  const { config, layers } = await fetchLayers(target, opts.cwd ?? process.cwd());
  return merge(target, config, layers, opts.keep);
}

/**
 * Blocking variant for code that cannot await (e.g. a config module loaded at import time): same child, same
 * checks, but the values are assigned to `process.env` (keys in `keep` that are already set stay untouched).
 * The child's output is captured through pipes, never inherited.
 */
export function loadPhaseEnvSync(target: string, opts: { cwd?: string; keep?: string[] } = {}): LoadedPhaseEnv {
  const { config, request, ctx } = prepare(target, opts.cwd ?? process.cwd());
  const fetched = readFetchOutput(...fetchSync(request), ctx);
  const loaded = merge(target, config, fetched, opts.keep);
  Object.assign(process.env, loaded.env);
  return loaded;
}

function fetchSync(request: FetchRequest): [stdout: string, outcome: Omit<FetchOutcome, "stdout">] {
  try {
    const stdout = execFileSync(process.execPath, [fetchChild.script], {
      input: JSON.stringify(request),
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv(),
      timeout: fetchChild.timeoutMs,
      killSignal: "SIGKILL",
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return [stdout, { timedOut: false, exitCode: 0 }];
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string | null; status?: number | null };
    return [e.stdout ?? "", { timedOut: e.code === "ETIMEDOUT", exitCode: e.status ?? null }];
  }
}

/**
 * Personal app reference (`PHASE_PERSONAL_APP`, else the keyring account `personal.account`), only for targets with
 * `personal`. When neither is set the layer is skipped with a stderr line.
 */
function personalApp(t: PhaseTarget): { ref: string; source: string } | undefined {
  if (!t.personal) return undefined;
  const fromEnv = process.env.PHASE_PERSONAL_APP?.trim();
  if (fromEnv) return { ref: fromEnv, source: "PHASE_PERSONAL_APP" };
  const account = t.personal.account;
  let reason: string;
  try {
    const ref = readKeyring(account);
    if (ref) return { ref, source: `keyring account "${account}"` };
    reason = `no keyring entry for account "${account}" and PHASE_PERSONAL_APP unset`;
  } catch {
    reason = `keyring unavailable for account "${account}" and PHASE_PERSONAL_APP unset`;
  }
  process.stderr.write(`[env] personal layer skipped: ${reason}\n`);
  return undefined;
}

/** Runs the SDK child: request (with the token) on stdin, messages on stdout, stderr drained and discarded. */
function fetchInChild(request: FetchRequest): Promise<FetchOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const done = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, timedOut, exitCode });
    };

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [fetchChild.script], { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
    } catch {
      done(null);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    // SDK warnings can echo `${…}` reference text: drain, never show.
    child.stderr?.resume();
    child.stdin?.on("error", () => {}); // EPIPE when the child dies early; reported through the exit
    child.once("error", () => done(null));
    child.once("close", (code) => done(code));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, fetchChild.timeoutMs);
    child.stdin?.end(JSON.stringify(request));
  });
}
