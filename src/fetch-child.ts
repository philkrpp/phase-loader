// Child process entry (dist/fetch-child.js): isolates the Phase SDK, see fetch-protocol.ts.
import Phase from "@phase.dev/phase-node";
import { runFetchChild } from "./fetch-core.js";

await runFetchChild(Phase);
