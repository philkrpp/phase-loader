// Fetch child for tests: the real child logic (src/fetch-core.ts) with the fake SDK, configured by FAKE_PHASE.
import { runFetchChild } from "../src/fetch-core.ts";
import FakePhase, { fake } from "./fake-sdk.ts";

Object.assign(fake, JSON.parse(process.env.FAKE_PHASE ?? "{}"));
await runFetchChild(FakePhase);
