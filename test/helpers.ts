import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchChild } from "../src/load.js";
import { fake } from "./fake-sdk.js";

export const APP_ID = "11111111-1111-4111-8111-111111111111";
export const PERSONAL_ID = "22222222-2222-4222-8222-222222222222";
export const TOKEN = "pss_service:v2:test-token";

export function validConfig(): Record<string, unknown> {
  return {
    host: "https://phase.example.test",
    targets: {
      dev: {
        env: "Development",
        account: "repo/dev",
        layers: [
          { app: "repo", appId: APP_ID, path: "/" },
          { app: "repo", appId: APP_ID, path: "/local" },
        ],
        personal: { account: "repo/personal-app" },
      },
    },
    require: [],
    allowLiteral: [],
  };
}

/** Writes `phase.config.json` into a fresh temp dir and returns the dir. */
export function writeConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "phase-loader-test-"));
  writeFileSync(join(dir, "phase.config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return dir;
}

export function nestedDir(root: string): string {
  const dir = join(root, "a", "b");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Points the loader at test/fake-child.ts and resets the fake (call in beforeEach). */
export function useFakeChild(): void {
  fake.reset();
  fake.logFile = join(mkdtempSync(join(tmpdir(), "phase-loader-log-")), "calls.jsonl");
  fetchChild.script = join(dirname(fileURLToPath(import.meta.url)), "fake-child.ts");
  fetchChild.timeoutMs = 10_000;
  fetchChild.extraEnv = {};
}

/** Hands the current fake state to the next fetch child (call right before loading). */
export function syncFake(): void {
  const { keyring: _k, keyringThrows: _t, reset: _r, ...state } = fake;
  fetchChild.extraEnv = { FAKE_PHASE: JSON.stringify(state) };
}

/** Calls the fake SDK saw in the child. */
export function sdkCalls(): Record<string, unknown>[] {
  try {
    return readFileSync(fake.logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}
