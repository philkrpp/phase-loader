import { describe, expect, it, vi } from "vitest";
import { loadConfig, PhaseLoaderError } from "../src/index.js";
import { APP_ID, nestedDir, validConfig, writeConfig } from "./helpers.js";

// Never load the real keyring, even though loadConfig does not touch it.
vi.mock("@napi-rs/keyring", () => import("./fake-sdk.js"));

function withTarget(patch: Record<string, unknown>): Record<string, unknown> {
  const config = validConfig();
  const targets = config.targets as Record<string, Record<string, unknown>>;
  targets.dev = { ...targets.dev, ...patch };
  return config;
}

describe("loadConfig", () => {
  it("walks up to the nearest phase.config.json and fills defaults", () => {
    const { require: _r, allowLiteral: _a, ...rest } = validConfig();
    const root = writeConfig(rest);
    const config = loadConfig(nestedDir(root));
    expect(config.dir).toBe(root);
    expect(config.host).toBe("https://phase.example.test");
    expect(config.targets.dev?.layers.map((l) => l.path)).toEqual(["/", "/local"]);
    expect(config.require).toEqual([]);
    expect(config.allowLiteral).toEqual([]);
  });

  it("reads an optional per-target require and validates its names", () => {
    expect(loadConfig(writeConfig(withTarget({ require: ["DB_URL"] }))).targets.dev?.require).toEqual(["DB_URL"]);
    expect(loadConfig(writeConfig(validConfig())).targets.dev?.require).toBeUndefined();
    expect(() => loadConfig(writeConfig(withTarget({ require: ["NOT-A-KEY"] })))).toThrow(/require/);
  });

  it("config rejects http host and paths without /", () => {
    const http = writeConfig({ ...validConfig(), host: "http://phase.example.test" });
    expect(() => loadConfig(http)).toThrow(PhaseLoaderError);
    expect(() => loadConfig(http)).toThrow(/https/);

    const userinfo = writeConfig({ ...validConfig(), host: "https://user:pw@phase.example.test" });
    expect(() => loadConfig(userinfo)).toThrow(/host/);
    expect(() => loadConfig(userinfo)).not.toThrow(/pw/);

    const noSlash = writeConfig(withTarget({ layers: [{ app: "repo", appId: APP_ID, path: "local" }] }));
    expect(() => loadConfig(noSlash)).toThrow(PhaseLoaderError);
    expect(() => loadConfig(noSlash)).toThrow(/path/);
  });

  it("rejects invalid app names, app ids, env names and key names", () => {
    const badApp = writeConfig(withTarget({ layers: [{ app: "../x", appId: APP_ID, path: "/" }] }));
    expect(() => loadConfig(badApp)).toThrow(/app/);
    const badId = writeConfig(withTarget({ layers: [{ app: "repo", appId: "repo", path: "/" }] }));
    expect(() => loadConfig(badId)).toThrow(/appId/);
    const badEnv = writeConfig(withTarget({ env: "" }));
    expect(() => loadConfig(badEnv)).toThrow(/env/);
    const badKey = writeConfig({ ...validConfig(), require: ["NOT-A-KEY"] });
    expect(() => loadConfig(badKey)).toThrow(/require/);
  });

  it("names the file when the JSON is invalid and when none exists", () => {
    const broken = writeConfig("{ not json");
    expect(() => loadConfig(broken)).toThrow(/phase\.config\.json/);
    expect(() => loadConfig("/")).toThrow(/No phase\.config\.json/);
  });
});
