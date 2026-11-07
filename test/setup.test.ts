import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHidden, setup } from "../src/setup.js";
import { fake } from "./fake-sdk.js";
import { validConfig, writeConfig } from "./helpers.js";

vi.mock("@napi-rs/keyring", () => import("./fake-sdk.js"));

const SECRET = "SENTINEL-typed-secret";
let cwd: string;

beforeEach(() => {
  fake.reset();
  cwd = writeConfig(validConfig());
});

afterEach(() => vi.restoreAllMocks());

describe("setup", () => {
  it("stores the trimmed input under service phase and the target account, never printing it", async () => {
    const message = await setup("dev", { cwd, ask: async () => `  ${SECRET}\n` });
    expect(fake.keyring.get("phase|repo/dev")).toBe(SECRET);
    expect(message).toContain("repo/dev");
    expect(message).not.toContain(SECRET);
  });

  it("with an account list the default is the last account (personal fallback)", async () => {
    const config = validConfig();
    (config.targets as Record<string, Record<string, unknown>>).dev!.account = ["compleadly/dev", "me/dev"];
    const message = await setup("dev", { cwd: writeConfig(config), ask: async () => SECRET });
    expect(fake.keyring.get("phase|me/dev")).toBe(SECRET);
    expect(fake.keyring.has("phase|compleadly/dev")).toBe(false);
    expect(message).toContain("me/dev");
    expect(message).not.toContain(SECRET);
  });

  it("--account stores into that account of the list; an unknown one is rejected", async () => {
    const config = validConfig();
    (config.targets as Record<string, Record<string, unknown>>).dev!.account = ["compleadly/dev", "me/dev"];
    const dir = writeConfig(config);
    await setup("dev", { cwd: dir, account: "compleadly/dev", ask: async () => SECRET });
    expect(fake.keyring.get("phase|compleadly/dev")).toBe(SECRET);
    expect(fake.keyring.has("phase|me/dev")).toBe(false);

    const error = await setup("dev", { cwd: dir, account: "other/dev", ask: async () => "x" }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/other\/dev.*compleadly\/dev.*me\/dev/);
    expect(fake.keyring.has("phase|other/dev")).toBe(false);
  });

  it("--account together with --personal is rejected", async () => {
    await expect(setup("dev", { cwd, personal: true, account: "repo/dev", ask: async () => "x" })).rejects.toThrow(
      /--account.*--personal/,
    );
  });

  it("--personal writes the personal account", async () => {
    await setup("dev", { cwd, personal: true, ask: async () => "my-personal-app" });
    expect(fake.keyring.get("phase|repo/personal-app")).toBe("my-personal-app");
    expect(fake.keyring.has("phase|repo/dev")).toBe(false);
  });

  it("empty input changes nothing", async () => {
    fake.keyring.set("phase|repo/dev", "old");
    const message = await setup("dev", { cwd, ask: async () => "  " });
    expect(fake.keyring.get("phase|repo/dev")).toBe("old");
    expect(message).toMatch(/unchanged/i);
  });

  it("unknown target and missing personal config are errors", async () => {
    await expect(setup("nope", { cwd, ask: async () => "x" })).rejects.toThrow(/nope.*dev/);
    const config = validConfig();
    delete (config.targets as Record<string, Record<string, unknown>>).dev!.personal;
    await expect(setup("dev", { cwd: writeConfig(config), personal: true, ask: async () => "x" })).rejects.toThrow(/personal/);
  });

  it("a keyring failure does not leak the value", async () => {
    fake.keyringThrows = true;
    const error = await setup("dev", { cwd, ask: async () => SECRET }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/keyring/i);
    expect(error?.message).not.toContain(SECRET);
  });
});

describe("readHidden", () => {
  it("does not echo what is typed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString();
    });
    const pending = readHidden("Token: ", input, output);
    input.write(`${SECRET}\n`);
    expect(await pending).toBe(SECRET);
    expect(written).toContain("Token: ");
    expect(written).not.toContain(SECRET);
  });
});
