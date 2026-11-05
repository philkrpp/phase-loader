import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { PhaseLoaderError } from "./errors.js";
import { EXAMPLE_FILE, exampleNames, phaseNames } from "./example.js";

const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|py)$/;
const USAGE = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /os\.environ\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /os\.getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /os\.environ\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
];
/**
 * A documented name quoted anywhere in tracked code (`optional('KEY')`, `env("KEY")`, a list of names) counts as
 * read, so helpers around `process.env[name]` do not produce orphans.
 * shortcut: undocumented detection still sees only the USAGE patterns, so a new key read only through a helper is
 * not reported; upgrade with a configurable helper list if that bites.
 */
const QUOTED = /["'`]([A-Z_][A-Z0-9_]*)["'`]/g;
/** Provided by the runtime or by phase-loader itself, never documented in `.env.example`. */
const BUILT_IN = new Set(["NODE_ENV", "MODE", "DEV", "PROD", "SSR", "BASE_URL", "CI", "PHASE_ENV_LOADED"]);

function trackedFiles(dir: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter(Boolean);
  } catch {
    throw new PhaseLoaderError(`"git ls-files" failed in ${dir}: check needs a git repository.`);
  }
}

function usedNames(dir: string): { used: Set<string>; quoted: Set<string> } {
  const used = new Set<string>();
  const quoted = new Set<string>();
  for (const file of trackedFiles(dir)) {
    if (!SOURCE.test(file) || file.split("/").includes("node_modules")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue; // tracked but deleted in the working tree
    }
    for (const pattern of USAGE) for (const m of text.matchAll(pattern)) if (!BUILT_IN.has(m[1]!)) used.add(m[1]!);
    for (const m of text.matchAll(QUOTED)) quoted.add(m[1]!);
  }
  return { used, quoted };
}

/**
 * Offline: names in `.env.example` against env reads in tracked source files (undocumented / orphan).
 * Online: also against the key names in Phase (`dev`). Names only, never values. `ok` is false on any finding.
 */
export async function check(opts: { cwd?: string; offline?: boolean } = {}): Promise<{ ok: boolean; report: string }> {
  const dir = loadConfig(opts.cwd ?? process.cwd()).dir;
  const file = join(dir, EXAMPLE_FILE);
  if (!existsSync(file)) throw new PhaseLoaderError(`${EXAMPLE_FILE} not found in ${dir} (create it with "phase-loader example --write").`);
  const documented = new Set(exampleNames(readFileSync(file, "utf8")));
  const { used, quoted } = usedNames(dir);

  const findings: [title: string, names: string[]][] = [
    [`Used in code but undocumented in ${EXAMPLE_FILE}:`, [...used].filter((n) => !documented.has(n))],
    [
      `Orphan in ${EXAMPLE_FILE} (never read in tracked code):`,
      [...documented].filter((n) => !used.has(n) && !quoted.has(n)),
    ],
  ];
  if (!opts.offline) {
    const inPhase = new Set((await phaseNames(opts.cwd ?? process.cwd())).sections.flatMap((s) => s.names));
    findings.push(
      [`In ${EXAMPLE_FILE} but not in Phase:`, [...documented].filter((n) => !inPhase.has(n))],
      [`In Phase but not in ${EXAMPLE_FILE}:`, [...inPhase].filter((n) => !documented.has(n))],
    );
  }

  const lines = findings.filter(([, names]) => names.length > 0).flatMap(([title, names]) => [title, `  ${names.sort().join(", ")}`]);
  return lines.length > 0 ? { ok: false, report: lines.join("\n") } : { ok: true, report: "Env names are consistent." };
}
