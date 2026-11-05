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
