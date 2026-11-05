# @philkrpp/phase-loader

Load env values from a self-hosted [Phase](https://phase.dev) secrets manager at dev time, without the Phase CLI.
Values go into a child process (`phase-loader run`) or are returned to your code (`loadPhaseEnv`); they are never
written to disk or printed. Built on the official SDK [`@phase.dev/phase-node`](https://github.com/phasehq/node-sdk).

Requires Node.js 22 or newer.

## Install

```sh
pnpm add -D @philkrpp/phase-loader
```

## Configure: `phase.config.json`

Commit one `phase.config.json` at the repository root (found by walking up from the current directory). It holds no
secrets: host, app ids, paths and keyring account names only.

```json
{
  "host": "https://phase.example.com",
  "targets": {
    "dev": {
      "env": "Development",
      "account": "my-repo/dev",
      "layers": [
        { "app": "my-repo", "appId": "00000000-0000-4000-8000-000000000000", "path": "/" },
        { "app": "my-repo", "appId": "00000000-0000-4000-8000-000000000000", "path": "/local" }
      ],
      "personal": { "account": "my-repo/personal-app" }
    }
  },
  "require": ["DATABASE_URL"],
  "allowLiteral": []
}
```

| Field | Meaning |
| --- | --- |
| `host` | Phase host, `https://` only, no credentials in the URL. |
| `targets.<name>.env` | Phase environment name, e.g. `Development`. |
| `targets.<name>.account` | OS keyring account (service `phase`) holding the service token for this target. |
| `targets.<name>.layers` | Apps (`appId` = Phase app UUID; `app` = name for messages) and paths, exported in order; later layers win. |
| `targets.<name>.personal.account` | Optional keyring account holding a personal app id or name; exported last (path `/`). |
| `require` | Keys the merged export must contain; otherwise loading fails and lists the missing names. |
| `allowLiteral` | Keys whose value may start with `${`. Any other value starting with `${` is an unresolved Phase reference and fails the load. |

## Tokens

The token of a target is read from the OS keyring: service `phase`, account `targets.<name>.account`.

The env variable `PHASE_TOKEN_<ACCOUNT>` (account upper-cased, every non-alphanumeric character replaced by `_`,
e.g. `my-repo/dev` → `PHASE_TOKEN_MY_REPO_DEV`) is used instead when `PHASE_TOKEN_SOURCE=env` is set, or when the
keyring is unavailable or has no entry.

The personal app comes from `PHASE_PERSONAL_APP` (app id or name), else from the keyring account
`personal.account`. If neither is set, the layer is skipped and a line on stderr says why. The same token reads it.

## Run a command

```sh
phase-loader run dev -- node server.js
```

Spawns the command through `cross-spawn` (Windows `.cmd` shims such as pnpm work), never with `shell: true`. Its env is `process.env` plus the Phase values plus `PHASE_ENV_LOADED=<target>`.
SIGINT and SIGTERM are forwarded; the exit code is the child's. On stderr:

```
[env] loaded 12 keys from Phase (dev: my-repo / + my-repo /local + personal /)
```

## Set up a token

```sh
phase-loader setup dev              # hidden prompt, stores the service token in the OS keyring
phase-loader setup dev --personal   # stores the personal app id or name
```

The value is written to service `phase`, account `targets.<name>.account` (or `personal.account`). Empty input
changes nothing; the value is never printed. Consumer repos typically add `"phase:setup": "phase-loader setup"`.

## `.env.example` and drift check

```sh
phase-loader example            # name diff between Phase (target dev) and .env.example
phase-loader example --write    # write .env.example: sections "# <app> <path>", sorted KEY= lines, no values
phase-loader check --offline    # .env.example vs env reads in git-tracked files; no token, no network
phase-loader check              # additionally vs the key names in Phase
```

`check` recognises `process.env.X`, `process.env["X"]`, `import.meta.env.X`, `os.environ["X"]`, `os.environ.get("X")`
and `os.getenv("X")` in tracked `.js/.ts/.vue/.py` files (not under `node_modules`), ignores runtime built-ins such as
`NODE_ENV`, prints names only and exits 1 on any undocumented or orphan name. A name from `.env.example` that appears
quoted anywhere in that code (`optional('KEY')`, `env("KEY")`) counts as read, so env helpers cause no orphans; a new
key read only through such a helper is not reported as undocumented. The personal app is not part of `.env.example`.

## API

```ts
import { loadPhaseEnv, PhaseLoaderError } from "@philkrpp/phase-loader";

const { env, layers } = await loadPhaseEnv("dev", { keep: ["PORT"] });
Object.assign(process.env, env);
```

- `loadConfig(cwd)` returns the validated config.
- `readToken(account)` returns the token of a keyring account.
- `loadPhaseEnv(target, { cwd?, keep? })` returns `{ env, layers }` and does not touch `process.env`. `keep` lists
  keys whose existing `process.env` value wins; they are left out of `env`.
- `loadPhaseEnvSync(target, { cwd?, keep? })` blocks, assigns the values to `process.env` (keys in `keep` that are
  already set stay untouched) and returns `{ env, layers }`. It runs the same SDK child through `execFileSync`; use it
  where nothing can be awaited, e.g. a config module evaluated at import time.
- `run(target, argv)` resolves with the child's exit code.
- Every expected failure is a `PhaseLoaderError` whose message names keys, apps, paths, accounts or status codes,
  never a value or a token.

The SDK runs in a short-lived child process (token via stdin, its stderr discarded, 60 s timeout, minimal env: `PATH`, home, proxy and CA variables only), so SDK errors
and hangs end as a `PhaseLoaderError` naming the app, path and status. Phase cross-app references (`${app::Env.KEY}`)
are resolved by the SDK. A reference the token cannot read stays
literal in Phase's output, so `phase-loader` fails on it and names the key instead of starting with `${…}`.

## License

MIT
