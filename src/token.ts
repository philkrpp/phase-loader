import { Entry } from "@napi-rs/keyring";
import { PhaseLoaderError } from "./errors.js";

export const KEYRING_SERVICE = "phase";

/** Env variable that can carry the token of a keyring account: `repo/dev` → `PHASE_TOKEN_REPO_DEV`. */
export function tokenEnvVar(account: string): string {
  return `PHASE_TOKEN_${account.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Trimmed keyring entry of service `phase`, `null` when there is none. Throws when the keyring is unavailable. */
export function readKeyring(account: string): string | null {
  return new Entry(KEYRING_SERVICE, account).getPassword()?.trim() || null;
}

/** Stores `value` under service `phase`; throws a {@link PhaseLoaderError} without the value when it fails. */
export function writeKeyring(account: string, value: string): void {
  try {
    new Entry(KEYRING_SERVICE, account).setPassword(value);
  } catch {
    throw new PhaseLoaderError(`Could not write the OS keyring (service "${KEYRING_SERVICE}", account "${account}").`);
  }
}

/**
 * Token for an account or an ordered account list (first entry = project-bound, last = personal fallback).
 * The OS keyring (service `phase`) is read first, unless `PHASE_TOKEN_SOURCE=env`: the first account with an entry
 * wins. Without any keyring entry (or when the keyring is skipped or unavailable) the first set env variable
 * {@link tokenEnvVar} in list order wins. Returns the account that supplied the token; there is no retry with
 * another account later. `target` only names the setup command in the error.
 */
export function resolveToken(account: string | readonly string[], target?: string): { token: string; account: string } {
  const accounts = typeof account === "string" ? [account] : account;
  let keyring = "keyring skipped (PHASE_TOKEN_SOURCE=env)";
  if (process.env.PHASE_TOKEN_SOURCE !== "env") {
    keyring = "no keyring entry";
    for (const candidate of accounts) {
      try {
        const token = readKeyring(candidate);
        if (token) return { token, account: candidate };
      } catch {
        keyring = "keyring unavailable";
      }
    }
  }
  for (const candidate of accounts) {
    const fromEnv = process.env[tokenEnvVar(candidate)]?.trim();
    if (fromEnv) return { token: fromEnv, account: candidate };
  }
  const names = accounts.map((a) => `"${a}"`).join(", ");
  const envVars = accounts.map(tokenEnvVar).join(", ");
  throw new PhaseLoaderError(
    `No Phase token for account${accounts.length > 1 ? "s" : ""} ${names} (${keyring}, ${envVars} unset). ` +
      `Store it in the OS keyring (service "${KEYRING_SERVICE}") with "phase-loader setup ${target ?? "<target>"}", or set ${envVars}.`,
  );
}

/** Token of a keyring account or an ordered account list; see {@link resolveToken}. */
export function readToken(account: string | readonly string[]): string {
  return resolveToken(account).token;
}
