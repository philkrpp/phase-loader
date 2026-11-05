import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { fetchLayers } from "./load.js";

export const EXAMPLE_FILE = ".env.example";
const EXAMPLE_TARGET = "dev";

/** Key names of the committed layers of `dev` (the personal app is not part of the repo's contract), by section. */
export async function phaseNames(cwd: string): Promise<{ dir: string; sections: { label: string; names: string[] }[] }> {
  const { config, layers } = await fetchLayers(EXAMPLE_TARGET, cwd);
  const seen = new Set<string>();
  const sections = layers
    .filter((layer) => layer.label !== "personal /")
    .map((layer) => {
      const names = layer.entries.map(([key]) => key).filter((key) => !seen.has(key)).sort();
      for (const key of names) seen.add(key);
      return { label: layer.label, names };
    });
  return { dir: config.dir, sections };
}

/** Names (`KEY=` lines) of an `.env.example` text. */
export function exampleNames(text: string): string[] {
  return [...text.matchAll(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]!);
}

/**
 * Builds `.env.example` from the key names of target `dev` (sections `# <app> <path>`, `KEY=` lines, sorted).
 * `write` replaces the file in the config directory; otherwise the result is a name diff against the current file.
 * Returns the text to print; values are never read into the output.
 */
export async function example(opts: { cwd?: string; write?: boolean } = {}): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const { dir, sections: phase } = await phaseNames(cwd);
  const inPhase = new Set(phase.flatMap((s) => s.names));
  const external = [...new Set(loadConfig(cwd).external)].filter((n) => !inPhase.has(n)).sort();
  const sections = [...phase, { label: "external (not loaded from Phase: Coolify, CI, runtime, libraries)", names: external }];
  const text = sections
    .filter((s) => s.names.length > 0)
    .map((s) => `# ${s.label}\n${s.names.map((n) => `${n}=`).join("\n")}\n`)
    .join("\n");
  const file = join(dir, EXAMPLE_FILE);
  if (opts.write) {
    writeFileSync(file, text);
    return `Wrote ${EXAMPLE_FILE} (${sections.reduce((n, s) => n + s.names.length, 0)} names).`;
  }
  const current = new Set(existsSync(file) ? exampleNames(readFileSync(file, "utf8")) : []);
  const wanted = new Set(sections.flatMap((s) => s.names));
  const lines = [
    ...[...wanted].filter((n) => !current.has(n)).sort().map((n) => `+ ${n}`),
    ...[...current].filter((n) => !wanted.has(n)).sort().map((n) => `- ${n}`),
  ];
  return lines.length > 0 ? `${lines.join("\n")}\n(run with --write to update ${EXAMPLE_FILE})` : `${EXAMPLE_FILE} is up to date.`;
}

