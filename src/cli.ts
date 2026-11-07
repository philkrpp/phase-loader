#!/usr/bin/env node
import { check } from "./check.js";
import { PhaseLoaderError } from "./errors.js";
import { example } from "./example.js";
import { run } from "./run.js";
import { setup } from "./setup.js";

const USAGE = `Usage:
  phase-loader setup <target> [--personal | --account NAME]
      Stores the token in the OS keyring. With an account list in phase.config.json the default is the last
      account (the personal fallback); --account NAME picks another account of the target's list.
  phase-loader run <target> -- <command> [args...]
  phase-loader example [--write]
  phase-loader check [--offline]`;

/** Exit code of the command, or 2 for a usage error. */
async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const flags = (allowed: string[]): string[] | undefined =>
    args.every((a) => a.startsWith("--") && allowed.includes(a)) ? args : undefined;

  if (command === "run") {
    const [target, separator, ...rest] = args;
    if (!target || separator !== "--" || rest.length === 0) return usage();
    return run(target, rest);
  }
  if (command === "setup") {
    const [target, ...flagArgs] = args;
    if (!target || target.startsWith("--")) return usage();
    let personal = false;
    let account: string | undefined;
    for (let i = 0; i < flagArgs.length; i++) {
      const flag = flagArgs[i];
      if (flag === "--personal") personal = true;
      else if (flag === "--account" && account === undefined && flagArgs[i + 1] && !flagArgs[i + 1]!.startsWith("--")) account = flagArgs[++i];
      else return usage();
    }
    process.stderr.write(`${await setup(target, { personal, ...(account !== undefined ? { account } : {}) })}\n`);
    return 0;
  }
  if (command === "example") {
    const given = flags(["--write"]);
    if (!given) return usage();
    process.stdout.write(`${await example({ write: given.includes("--write") })}\n`);
    return 0;
  }
  if (command === "check") {
    const given = flags(["--offline"]);
    if (!given) return usage();
    const { ok, report } = await check({ offline: given.includes("--offline") });
    process.stdout.write(`${report}\n`);
    return ok ? 0 : 1;
  }
  return usage();
}

function usage(): number {
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Only our own messages are printed; anything else could carry SDK or server text.
  const message = error instanceof PhaseLoaderError ? error.message : `unexpected ${(error as Error)?.name ?? "error"}`;
  process.stderr.write(`phase-loader: ${message}\n`);
  process.exitCode = 1;
}
