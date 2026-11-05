import { PhaseLoaderError } from "./errors.js";

/**
 * Protocol between the parent and the SDK child (`dist/fetch-child.js`). The child reads one {@link FetchRequest}
 * as JSON from stdin (the token travels only there) and writes one JSON message per line to stdout: zero or more
 * `{ progress: "<label>" }`, then exactly one {@link FetchResponse}. Its stderr is drained and discarded by the parent.
 */
export interface FetchRequest {
  host: string;
  token: string;
  envName: string;
  layers: { app: string; appId: string; path: string }[];
  /** Personal app id or name, resolved by the child after `init()` and exported last with path `/`. */
  personal?: string;
}

export interface FetchedLayer {
  /** `<app> <path>` or `personal /`. */
  label: string;
  entries: [key: string, value: string][];
}

/** `error`: `<label> (<reason>)`, label `init`, `personal /` or `<app> <path>`. */
export type FetchResponse = { ok: true; layers: FetchedLayer[] } | { ok: false; error: string };

export type FetchMessage = { progress: string } | FetchResponse;

export const FETCH_TIMEOUT_MS = 60_000;

export interface FetchContext {
  host: string;
  account: string;
  /** Where the personal app came from, for the error hint. */
  personalSource?: string | undefined;
}

const LABEL = /^(?:init|personal \/|[A-Za-z0-9][A-Za-z0-9._-]* \/[A-Za-z0-9._/-]*)$/;
const REASON = /^(?:\d{3}|timeout|unreachable|invalid-app|invalid-env|invalid-token|ambiguous-app|crashed|invalid-response|error)$/;
const FAILURE = /^(.+) \(([a-z0-9-]+)\)$/;

/**
 * Turns the child's stdout and exit into the fetched layers, or throws a {@link PhaseLoaderError} built only from
 * validated labels and reasons (never from free text of the child).
 */
export function readFetchOutput(
  stdout: string,
  outcome: { timedOut: boolean; exitCode: number | null },
  ctx: FetchContext,
): FetchedLayer[] {
  let last = "init";
  let response: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue; // blank or foreign output
    }
    if (!isObject(message)) continue;
    if (typeof message.progress === "string" && LABEL.test(message.progress)) last = message.progress;
    else if (typeof message.ok === "boolean") response = message;
  }

  if (outcome.timedOut) throw fetchFailure(last, "timeout", ctx);
  if (response?.ok === true) {
    if (isLayers(response.layers)) return response.layers;
    throw fetchFailure(last, "invalid-response", ctx);
  }
  if (response?.ok === false) {
    const match = typeof response.error === "string" ? FAILURE.exec(response.error) : null;
    if (match && LABEL.test(match[1]!) && REASON.test(match[2]!)) throw fetchFailure(match[1]!, match[2]!, ctx);
    throw fetchFailure(last, "invalid-response", ctx);
  }
  throw fetchFailure(last, outcome.exitCode === 0 ? "invalid-response" : "crashed", ctx);
}

function fetchFailure(label: string, reason: string, ctx: FetchContext): PhaseLoaderError {
  if (label === "init") {
    if (/^\d{3}$/.test(reason)) {
      return new PhaseLoaderError(`Phase rejected the token for account "${ctx.account}" at ${ctx.host} (${reason}).`);
    }
    if (reason === "invalid-token") {
      return new PhaseLoaderError(`The Phase token for account "${ctx.account}" has an invalid format.`);
    }
    if (reason === "unreachable" || reason === "timeout") {
      return new PhaseLoaderError(`Phase not reachable at ${ctx.host} (${reason}; tailnet?).`);
    }
  }
  const hint = label === "personal /" && ctx.personalSource ? ` Check the personal app from ${ctx.personalSource}.` : "";
  return new PhaseLoaderError(`Phase export failed: ${label} (${reason})${hint}`);
}

function isLayers(value: unknown): value is FetchedLayer[] {
  return (
    Array.isArray(value) &&
    value.every(
      (layer) =>
        isObject(layer) &&
        typeof layer.label === "string" &&
        LABEL.test(layer.label) &&
        Array.isArray(layer.entries) &&
        layer.entries.every(
          (s: unknown) => Array.isArray(s) && s.length === 2 && typeof s[0] === "string" && typeof s[1] === "string",
        ),
    )
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
