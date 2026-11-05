// Test double for `@phase.dev/phase-node` (used inside the fetch child via test/fake-child.ts) and for
// `@napi-rs/keyring` (`Entry`, mocked in-process). Shapes follow the installed SDK 3.2.0. No TS-only runtime syntax:
// Node runs this file with type stripping.
import { appendFileSync } from "node:fs";
import type { GetSecretOptions, Secret } from "@phase.dev/phase-node/dist/types";

/** A thrown string (the SDK throws strings) or an Error with this message. */
type FakeError = string | { message: string };

interface FakeApp {
  id: string;
  name: string;
  /** env name -> path -> key -> value */
  secrets: Record<string, Record<string, Record<string, string>>>;
}

export const fake = {
  apps: [] as FakeApp[],
  /** In-process only (keyring mock), not passed to the child. */
  keyring: new Map<string, string>(),
  keyringThrows: false,
  initError: undefined as FakeError | undefined,
  getError: undefined as FakeError | undefined,
  /**
   * "reject": a rejected promise, like the SDK's `reject("Invalid app id")` (index.js:4480).
   * "executor-throw": thrown inside `new Promise(async …)`, like the SDK's HTTP errors (index.js:4584): the
   * returned promise never settles and the error is an unhandled rejection.
   */
  getThrow: "reject" as "reject" | "executor-throw",
  getHangs: false,
  /** Text written with console.warn on every get(), like the SDK's reference warning (index.js:3901). */
  warn: "",
  /** JSON-lines call log written by the child. */
  logFile: "",
  reset(): void {
    fake.apps = [];
    fake.keyring = new Map();
    fake.keyringThrows = false;
    fake.initError = undefined;
    fake.getError = undefined;
    fake.getThrow = "reject";
    fake.getHangs = false;
    fake.warn = "";
    fake.logFile = "";
  },
};

function thrown(error: FakeError): unknown {
  return typeof error === "string" ? error : new Error(error.message);
}

function log(entry: Record<string, unknown>): void {
  if (fake.logFile) appendFileSync(fake.logFile, `${JSON.stringify(entry)}\n`);
}

export default class FakePhase {
  apps: { id: string; name: string }[] = [];

  constructor(token: string, host?: string) {
    log({ constructed: { token, host } });
  }

  async init(): Promise<void> {
    log({ init: true });
    if (fake.initError !== undefined) throw thrown(fake.initError);
    this.apps = fake.apps.map(({ id, name }) => ({ id, name }));
  }

  get(options: GetSecretOptions): Promise<Secret[]> {
    log({ get: options });
    if (fake.warn) console.warn(fake.warn);
    if (fake.getHangs) {
      setInterval(() => {}, 1000); // an open socket keeps the real SDK's process alive
      return new Promise(() => {});
    }
    const error = fake.getError;
    if (error !== undefined && fake.getThrow === "executor-throw") {
      // Same shape as the SDK: async executor that throws.
      // biome-ignore lint: intentional async executor
      return new Promise(async () => {
        await null;
        throw thrown(error);
      });
    }
    return (async () => {
      if (error !== undefined) throw thrown(error);
      const app = fake.apps.find((a) => a.id === options.appId);
      if (!app) throw "Invalid app id";
      const path = options.path ?? "/";
      const values = app.secrets[options.envName]?.[path] ?? {};
      return Object.entries(values).map(([key, value]) => ({
        id: `${app.id}:${key}`,
        key,
        value,
        comment: "",
        environment: options.envName,
        path,
        tags: [],
        keyDigest: "",
        version: 1,
      }));
    })();
  }
}

export class Entry {
  service: string;
  account: string;

  constructor(service: string, account: string) {
    this.service = service;
    this.account = account;
  }

  getPassword(): string | null {
    if (fake.keyringThrows) throw new Error("Platform secure storage failure");
    return fake.keyring.get(`${this.service}|${this.account}`) ?? null;
  }

  setPassword(value: string): void {
    if (fake.keyringThrows) throw new Error("Platform secure storage failure");
    fake.keyring.set(`${this.service}|${this.account}`, value);
  }
}
