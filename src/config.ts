import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PhaseLoaderError } from "./errors.js";

export const CONFIG_FILE = "phase.config.json";

/** One Phase app + path exported as a layer; layers merge in order, later wins. */
export interface PhaseLayer {
  /** App name, used in messages only. */
  app: string;
  /** App id (UUID); the SDK addresses apps by id. */
  appId: string;
  path: string;
}

export interface PhaseTarget {
  /** Phase environment name, e.g. `Development`. */
  env: string;
  /** Keyring account (service `phase`) holding the token for this target. */
  account: string;
  layers: PhaseLayer[];
  /** Keyring account holding the personal app id or name; exported last with path `/`. */
  personal?: { account: string };
  /** Replaces the top-level `require` for this target (e.g. a release target without a database). */
  require?: string[];
}

export interface PhaseConfig {
  /** Directory that contains `phase.config.json`. */
  dir: string;
  host: string;
  targets: Record<string, PhaseTarget>;
  /** Keys the merged export must contain. */
  require: string[];
  /** Keys whose value may start with `${` (not a Phase reference). */
  allowLiteral: string[];
  /**
   * Names read or set outside the Phase `dev` export (Coolify-only values, CI, runtime, libraries such as OTEL_*):
   * listed in their own `.env.example` section and never reported by `check`.
   */
  external: string[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = /^\/[A-Za-z0-9._/-]*$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Free-form keyring account (e.g. `repo/dev`); printable, no control characters.
const ACCOUNT = /^[^\p{Cc}]{1,200}$/u;

/** Finds the nearest `phase.config.json` from `cwd` upwards, validates and returns it. */
export function loadConfig(cwd: string): PhaseConfig {
  let dir = resolve(cwd);
  for (;;) {
    const file = join(dir, CONFIG_FILE);
    if (existsSync(file)) return parseConfig(file, dir);
    const parent = dirname(dir);
    if (parent === dir) throw new PhaseLoaderError(`No ${CONFIG_FILE} found in ${cwd} or any parent directory.`);
    dir = parent;
  }
}

function parseConfig(file: string, dir: string): PhaseConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PhaseLoaderError(`${file} is not readable JSON.`);
  }
  const fail = (what: string): never => {
    throw new PhaseLoaderError(`Invalid ${CONFIG_FILE} (${file}): ${what}.`);
  };
  const str = (value: unknown, pattern: RegExp, what: string): string =>
    typeof value === "string" && pattern.test(value) ? value : fail(what);
  const keys = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return fail(`"${field}" must be a list of key names`);
    return value.map((key) => str(key, KEY, `"${field}" must contain env key names`));
  };

  if (!isObject(raw)) return fail("expected an object");
  const host = str(raw.host, /^https:\/\/[^\s/@]+(\/[^\s@]*)?$/, `"host" must be an https:// URL without credentials`).replace(/\/+$/, "");
  if (!isObject(raw.targets) || Object.keys(raw.targets).length === 0) return fail(`"targets" must be a non-empty object`);

  const targets: Record<string, PhaseTarget> = {};
  for (const [name, value] of Object.entries(raw.targets)) {
    const at = `target "${name}"`;
    str(name, NAME, `${at} has an invalid name`);
    if (!isObject(value)) return fail(`${at} must be an object`);
    if (!Array.isArray(value.layers) || value.layers.length === 0) return fail(`${at}: "layers" must be a non-empty list`);
    const target: PhaseTarget = {
      env: str(value.env, ENV_NAME, `${at}: "env" must be a Phase environment name`),
      account: str(value.account, ACCOUNT, `${at}: "account" must be a keyring account name`),
      layers: value.layers.map((layer: unknown, i: number) => {
        const li = `${at} layer ${i}`;
        if (!isObject(layer)) return fail(`${li} must be an object`);
        return {
          app: str(layer.app, NAME, `${li}: "app" must be a Phase app name`),
          appId: str(layer.appId, UUID, `${li}: "appId" must be a Phase app id (UUID)`),
          path: str(layer.path, PATH, `${li}: "path" must start with "/"`),
        };
      }),
    };
    if (value.personal !== undefined) {
      if (!isObject(value.personal)) return fail(`${at}: "personal" must be an object`);
      target.personal = {
        account: str(value.personal.account, ACCOUNT, `${at}: "personal.account" must be a keyring account name`),
      };
    }
    if (value.require !== undefined) target.require = keys(value.require, `targets.${name}.require`);
    targets[name] = target;
  }

  return {
    dir,
    host,
    targets,
    require: keys(raw.require, "require"),
    allowLiteral: keys(raw.allowLiteral, "allowLiteral"),
    external: keys(raw.external, "external"),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
