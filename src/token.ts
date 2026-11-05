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
 * Token of a keyring account: the OS keyring (service `phase`) unless `PHASE_TOKEN_SOURCE=env`; the env variable
 * {@link tokenEnvVar} when the keyring is skipped, unavailable or has no entry.
 */
export function readToken(account: string): string {
  const envVar = tokenEnvVar(account);
  let keyring = "keyring skipped (PHASE_TOKEN_SOURCE=env)";
  if (process.env.PHASE_TOKEN_SOURCE !== "env") {
    try {
      const token = readKeyring(account);
      if (token) return token;
      keyring = "no keyring entry";
    } catch {
      keyring = "keyring unavailable";
    }
  }
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv) return fromEnv;
  throw new PhaseLoaderError(
    `No Phase token for account "${account}" (${keyring}, ${envVar} unset). ` +
      `Store it in the OS keyring (service "${KEYRING_SERVICE}", account "${account}") with "phase-loader setup", or set ${envVar}.`,
  );
}
