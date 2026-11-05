import type { ChildProcess } from "node:child_process";
import { constants } from "node:os";
import spawn from "cross-spawn";
import { PhaseLoaderError } from "./errors.js";
import { loadPhaseEnv } from "./load.js";

const FORWARDED = ["SIGINT", "SIGTERM"] as const;

/**
 * Loads `target` and runs `argv` (no `shell: true`; cross-spawn resolves Windows `.cmd` shims) with `process.env` + the Phase values + `PHASE_ENV_LOADED=<target>`.
 * SIGINT/SIGTERM are forwarded to the child; resolves with its exit code (128 + signal number when killed).
 */
export async function run(target: string, argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command) throw new PhaseLoaderError("No command given: phase-loader run <target> -- <command> [args...]");

  const { env, layers } = await loadPhaseEnv(target);
  process.stderr.write(`[env] loaded ${Object.keys(env).length} keys from Phase (${target}: ${layers.join(" + ")})\n`);

  let child: ChildProcess;
  try {
    child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...env, PHASE_ENV_LOADED: target } });
  } catch (error) {
    // Never the raw error: e.g. ERR_INVALID_ARG_VALUE quotes an env value containing a NUL byte.
    throw new PhaseLoaderError(`Could not start "${command}" (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  const handlers = FORWARDED.map((signal) => [signal, () => child.kill(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const detach = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };

  return new Promise((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      detach();
      reject(new PhaseLoaderError(`Could not start "${command}" (${error.code ?? "error"}).`));
    });
    child.once("exit", (code, signal) => {
      detach();
      resolve(code ?? 128 + (signal ? constants.signals[signal] : 0));
    });
  });
}
