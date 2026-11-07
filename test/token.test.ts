import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhaseLoaderError, readToken } from "../src/index.js";
import { resolveToken } from "../src/token.js";
import { fake } from "./fake-sdk.js";

vi.mock("@napi-rs/keyring", () => import("./fake-sdk.js"));

const PROJECT = "compleadly/dev";
const ME = "me/dev";

beforeEach(() => {
  fake.reset();
  vi.stubEnv("PHASE_TOKEN_SOURCE", undefined);
  vi.stubEnv("PHASE_TOKEN_COMPLEADLY_DEV", undefined);
  vi.stubEnv("PHASE_TOKEN_ME_DEV", undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("resolveToken with an account list", () => {
  it("uses the only account that has a keyring entry", () => {
    fake.keyring.set(`phase|${ME}`, "me-token");
    expect(resolveToken([PROJECT, ME])).toEqual({ token: "me-token", account: ME });
  });

  it("the first account with a keyring entry wins when both exist", () => {
    fake.keyring.set(`phase|${PROJECT}`, "project-token");
    fake.keyring.set(`phase|${ME}`, "me-token");
    expect(resolveToken([PROJECT, ME])).toEqual({ token: "project-token", account: PROJECT });
  });

  it("a keyring entry of a later account beats an env variable of an earlier one", () => {
    fake.keyring.set(`phase|${ME}`, "me-token");
    vi.stubEnv("PHASE_TOKEN_COMPLEADLY_DEV", "env-project");
    expect(resolveToken([PROJECT, ME])).toEqual({ token: "me-token", account: ME });
  });

  it("without a keyring entry the env variables are tried in list order", () => {
    vi.stubEnv("PHASE_TOKEN_COMPLEADLY_DEV", "env-project");
    vi.stubEnv("PHASE_TOKEN_ME_DEV", "env-me");
    expect(resolveToken([PROJECT, ME])).toEqual({ token: "env-project", account: PROJECT });
    expect(resolveToken([ME, PROJECT])).toEqual({ token: "env-me", account: ME });
    vi.stubEnv("PHASE_TOKEN_COMPLEADLY_DEV", undefined);
    expect(resolveToken([PROJECT, ME])).toEqual({ token: "env-me", account: ME });
  });

  it("env fallback when the keyring is unavailable", () => {
    fake.keyringThrows = true;
    vi.stubEnv("PHASE_TOKEN_ME_DEV", "env-me");
    expect(resolveToken([PROJECT, ME])).toEqual({ token: "env-me", account: ME });
  });

  it("PHASE_TOKEN_SOURCE=env skips the keyring for every account", () => {
    fake.keyring.set(`phase|${PROJECT}`, "project-token");
    vi.stubEnv("PHASE_TOKEN_SOURCE", "env");
    vi.stubEnv("PHASE_TOKEN_ME_DEV", "env-me");
    expect(resolveToken([PROJECT, ME])).toEqual({ token: "env-me", account: ME });
  });

  it("none found: the error names all accounts, their env variables and the setup command", () => {
    const fail = (): unknown => resolveToken([PROJECT, ME], "dev");
    expect(fail).toThrow(PhaseLoaderError);
    expect(fail).toThrow(/compleadly\/dev/);
    expect(fail).toThrow(/me\/dev/);
    expect(fail).toThrow(/PHASE_TOKEN_COMPLEADLY_DEV/);
    expect(fail).toThrow(/PHASE_TOKEN_ME_DEV/);
    expect(fail).toThrow(/phase-loader setup dev/);
  });

  it("a single-account list behaves like the string form", () => {
    fake.keyring.set(`phase|${ME}`, "me-token");
    expect(resolveToken([ME])).toEqual({ token: "me-token", account: ME });
    expect(readToken(ME)).toBe("me-token");
    expect(readToken([PROJECT, ME])).toBe("me-token");
  });
});
