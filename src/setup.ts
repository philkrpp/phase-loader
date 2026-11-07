import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { loadConfig } from "./config.js";
import { PhaseLoaderError } from "./errors.js";
import { KEYRING_SERVICE, writeKeyring } from "./token.js";

/** Prompts on `output` and reads one line from `input` without echoing it. */
export function readHidden(prompt: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<string> {
  let muted = false;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input, output: sink, terminal: Boolean((input as NodeJS.ReadStream).isTTY) });
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer: string): void => {
      if (settled) return;
      settled = true;
      output.write("\n");
      rl.close();
      resolve(answer);
    };
    rl.once("close", () => done("")); // EOF without an answer
    rl.question(prompt, done);
    muted = true; // the prompt is out; everything typed from here on stays invisible
  });
}

/**
 * Stores a token (or, with `personal`, the personal app id/name) in the OS keyring, service `phase`, account from
 * `phase.config.json`. A target with an account list stores into its last account (the personal fallback) unless
 * `account` names another one of the list. Empty input changes nothing. Returns the message to print; it never contains the value.
 */
export async function setup(
  target: string,
  opts: { personal?: boolean; account?: string; cwd?: string; ask?: (prompt: string) => Promise<string> } = {},
): Promise<string> {
  const config = loadConfig(opts.cwd ?? process.cwd());
  const t = Object.hasOwn(config.targets, target) ? config.targets[target] : undefined;
  if (!t) {
    throw new PhaseLoaderError(
      `Unknown target "${target}" (phase.config.json defines: ${Object.keys(config.targets).join(", ")}).`,
    );
  }
  if (opts.personal && !t.personal) throw new PhaseLoaderError(`Target "${target}" has no "personal" account configured.`);
  if (opts.personal && opts.account !== undefined) {
    throw new PhaseLoaderError(`"--account" and "--personal" cannot be combined.`);
  }
  if (opts.account !== undefined && !t.account.includes(opts.account)) {
    throw new PhaseLoaderError(
      `Target "${target}" has no account "${opts.account}" (accounts: ${t.account.join(", ")}).`,
    );
  }
  const account = opts.personal ? t.personal!.account : (opts.account ?? t.account.at(-1)!);
  const what = opts.personal ? "personal app (id or name)" : "service token";
  const ask = opts.ask ?? ((prompt: string) => readHidden(prompt, process.stdin, process.stderr));

  const value = (await ask(`Phase ${what} for "${account}" (empty = keep current): `)).trim();
  if (!value) return `Unchanged: keyring account "${account}".`;
  writeKeyring(account, value);
  return `Stored in the OS keyring (service "${KEYRING_SERVICE}", account "${account}").`;
}
