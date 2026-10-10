# Developing Amber

The plugin that users install is the `plugin/` directory. Its hooks and scripts are being moved to TypeScript in stages: sources live under `src/` and compile to the same `.cjs` paths under `plugin/`, so installs, the Node 20+ requirement, and every `scripts/record.cjs` path quoted in project instructions stay unchanged. Until a file has a source under `src/`, the `.cjs` file under `plugin/` is still the source of truth. The plugin has no runtime dependencies; everything in `package.json` is for development only.

## Layout

- `src/` - TypeScript sources of the plugin (`.cts`, compiled by `tsconfig.json` into `plugin/`). `src/types/reset.d.ts` makes `JSON.parse` return `unknown` and `Array.isArray` narrow to `unknown[]`, so external data has to be checked before use.
- `tools/` - development tools in TypeScript (`.mts`, compiled by `tools/tsconfig.json` into `build/tools/`, which is not committed).
- `plugin/tests/` - the test suites. `run-tests.cjs` is a standalone runner; every other `*-tests.cjs` file is a `node:test` file. `characterization-tests.cjs` pins the current behavior of paths the other suites do not reach.

## Scripts

Run `npm ci` once, then:

- `npm run typecheck` - type-check `src/` and `tools/`.
- `npm run lint` - typescript-eslint `strictTypeChecked` plus exhaustive switches, no type assertions, no non-null assertions, no `@ts-` directives, no `any`; zero warnings allowed.
- `npm run format:check` / `npm run format` - Prettier on `src/` and `tools/`.
- `npm run build` - compile `src/` into `plugin/`. The committed output must equal a fresh build (CI runs `npm run build && git diff --exit-code`).
- `npm test` - every suite against `plugin/`.
- `npm run coverage` - line coverage of `plugin/hooks/*.cjs` and `plugin/scripts/*.cjs` under every suite, child processes included, with the uncovered line ranges per file.
- `npm run parity -- --ref <rev>`, `npm run parity:real -- --ref <rev>`, `npm run parity:selftest -- --ref <rev>` - see below.

## Parity

The port must not change anything Amber shows to the outside: the stdout, stderr, and exit code of every entry point (hook JSON for each host and every message included), the `.amber/` files of a zone, the ledger rows, and the session state files. Three commands compare a reference build with the working tree's `plugin/`. The reference build is `plugin/` of `<rev>` (default `origin/main`) - code, `run.sh`, `hooks.json`, skills, and references - with two exceptions taken from the working tree: `tests/`, so both builds run the same suites, and the two manifests, whose version is the one outside-visible change every release makes on purpose (it reaches each ledger row as `plugin_version`). The list is `SHARED_WITH_CANDIDATE` in `tools/parity/workspace.mts`.

- `parity` runs every suite against both builds. A preload (`NODE_OPTIONS=--require`) records each product process the suites start - argv, stdin, stdout, stderr, exit code, appended ledger bytes, changed state files, the zone's `.amber` files afterwards - and the normalized records are compared as multisets. Temporary directory names and git commit dates are made deterministic at the source; the remaining normalization rules and the reason for each are listed in `tools/parity/normalize.mts`. The last line reads `PARITY invocations=<n> differences=<d>`.
- `parity:real` replays this machine's own records through both builds in scratch zones and scratch Amber homes: every `audit.cjs` command over a ledger snapshot, real tool calls from Claude Code transcripts and Codex rollouts through E1 under each zone's contracts, the S0 briefing of every contract, and `unit init` of every plan. The real ledger and transcripts are only read, and nothing from them is written to the repository. It needs those records, so it runs locally, not in CI. The last line reads `REAL audit=<n> e1=<n> s0=<n> plans=<n> differences=<d>`.
- `parity:selftest` applies four outside-visible mutations to a candidate copy (one character of a briefing, a refusal exit code, an E1 decision, a `progress.json` value) and requires each to be reported, the E1 one by the real-record replay as well. It also runs a control that only moves one message from `process.stdout.write` to `fs.writeSync(1, ...)` and requires no difference, which shows that capture follows output written through `fs` as well.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`, on Node 20, 22, and 24: `npm ci`, typecheck, lint, format check, the build check, `npm test`, and `npm run parity` against the pull request's base branch or, on a push to `main`, against the previous `main` commit.
