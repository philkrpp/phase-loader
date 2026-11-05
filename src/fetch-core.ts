// Runs inside the SDK child process. Only type imports from local modules: tests run this file with Node's type
// stripping and a fake SDK (test/fake-child.ts).
import type { FetchedLayer, FetchMessage, FetchRequest } from "./fetch-protocol.js";

export interface PhaseClient {
  init(): Promise<void>;
  get(options: { appId: string; envName: string; path?: string }): Promise<{ key: string; value: string }[]>;
}
export type PhaseConstructor = new (token: string, host?: string) => PhaseClient;

const UNREACHABLE =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|Network Error|timeout|Failed to initialize session/i;

/** Short reason for an SDK error; nothing of the error text itself leaves the child. */
export function failureReason(error: unknown): string {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const status = /^Error: (\d{3}):/.exec(text)?.[1];
  if (status) return status;
  if (text === "Invalid app id") return "invalid-app";
  if (text.startsWith("Invalid environment name")) return "invalid-env";
  if (text.startsWith("Invalid token format")) return "invalid-token";
  if (UNREACHABLE.test(text)) return "unreachable";
  return "error";
}

/** Reads a FetchRequest from stdin, exports every layer, writes FetchMessages to stdout and exits. */
export async function runFetchChild(Phase: PhaseConstructor): Promise<void> {
  let current = "init";
  let finished = false;
  const finish = (message: FetchMessage, code: number): void => {
    if (finished) return;
    finished = true;
    process.stdout.write(`${JSON.stringify(message)}\n`, () => process.exit(code));
  };
  const fail = (error: unknown): void => finish({ ok: false, error: `${current} (${failureReason(error)})` }, 1);
  const progress = (label: string): void => {
    current = label;
    process.stdout.write(`${JSON.stringify({ progress: label } satisfies FetchMessage)}\n`);
  };
  // The SDK throws inside `new Promise(async …)` executors (phase-node 3.2.0 dist/index.js:4474, :4584): such errors
  // never reject the returned promise and only surface here.
  process.on("unhandledRejection", fail);
  process.on("uncaughtException", fail);

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FetchRequest;

    progress("init");
    const phase = new Phase(request.token, request.host);
    await phase.init();

    const layers = request.layers.map((l) => ({ label: `${l.app} ${l.path}`, appId: l.appId, path: l.path }));
    if (request.personal) {
      progress("personal /");
      // shortcut: the SDK keeps its app list in the TS-private `apps` field (filled by init(), phase-node 3.2.0
      // dist/index.js:4437); re-check on every SDK upgrade.
      const apps = (phase as unknown as { apps?: { id: string; name: string }[] }).apps ?? [];
      const byId = apps.filter((a) => a.id === request.personal);
      const matches = byId.length > 0 ? byId : apps.filter((a) => a.name === request.personal);
      if (matches.length !== 1) {
        finish({ ok: false, error: `personal / (${matches.length === 0 ? "invalid-app" : "ambiguous-app"})` }, 1);
        return;
      }
      layers.push({ label: "personal /", appId: matches[0]!.id, path: "/" });
    }

    const fetched: FetchedLayer[] = [];
    for (const layer of layers) {
      progress(layer.label);
      const result = await phase.get({ appId: layer.appId, envName: request.envName, path: layer.path });
      fetched.push({ label: layer.label, entries: result.map((s) => [s.key, s.value]) });
    }
    finish({ ok: true, layers: fetched }, 0);
  } catch (error) {
    fail(error);
  }
}
