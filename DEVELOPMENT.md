# Developing Amber

The plugin that users install is the `plugin/` directory. Its hooks and scripts are being moved to TypeScript in stages: sources live under `src/` and compile to the same `.cjs` paths under `plugin/`, so installs, the Node 20+ requirement, and every `scripts/record.cjs` path quoted in project instructions stay unchanged. Until a file has a source under `src/`, the `.cjs` file under `plugin/` is still the source of truth. The plugin has no runtime dependencies; everything in `package.json` is for development only.

## Layout

- `src/` - TypeScript sources of the plugin (`.cts`, compiled by `tsconfig.json` into `plugin/`). `src/types/reset.d.ts` makes `JSON.parse` return `unknown` and `Array.isArray` narrow to `unknown[]`, so external data has to be checked before use.
  - `src/hooks/*.cts` and `src/scripts/*.cts` compile to the files the hosts and the hand-written `.cjs` files load, at their old paths. A ported module there keeps the exact `module.exports` of the file it replaced (names, order, constant values) while any CommonJS caller remains, binds the clock and runs the I/O, and leaves the rules to `src/lib/`.
  - `src/lib/*.cts` compile to `plugin/lib/*.cjs`, modules with one job each: the domain types (`types`, types only), value helpers (`guards`), globs (`glob`), plan rows (`plan`), the run state's rules (`progress-model`), the progress file (`progress-store`), the clock (`clock`), git (`git`), the scope check's rules (`scope`), and the Codex rollout adapter (`codex-transcript`). `glob`, `plan`, `progress-model`, `scope`, `guards`, `types` and `codex-transcript` do no I/O and read no clock.
  - Files compiled from `src/` are generated: their first line names the source to edit, and `.gitattributes` marks them `linguist-generated`, so pull request diffs fold them and a reviewer reads the `.cts` source.
- `tools/` - development tools in TypeScript (`.mts`, compiled by `tools/tsconfig.json` into `build/tools/`, which is not committed).
- `plugin/tests/` - the test suites. `run-tests.cjs` is a standalone runner; every other `*-tests.cjs` file is a `node:test` file. `characterization-tests.cjs` pins the current behavior of paths the other suites do not reach; `characterization-s2-tests.cjs` does the same for the branches of the stage 2 modules by calling their exports directly.

## Scripts

Run `npm ci` once, then:

- `npm run typecheck` - type-check `src/` and `tools/`.
- `npm run lint` - typescript-eslint `strictTypeChecked` plus exhaustive switches, no type assertions, no non-null assertions, no `@ts-` directives, no `any`; zero warnings allowed. In `src/` it also forbids asynchronous I/O and process APIs, `async`/`await`, promises, timers, and signal handlers, with `node:fs` bound as `fs` and `node:child_process` as `childProcess` so every use is visible to the rule: the plugin is a set of short synchronous programs (only the hook reads stdin through stream events), and keeping the port that way leaves nothing the parity capture cannot observe, such as output released before a pending write or signal handling.
- `npm run format:check` / `npm run format` - Prettier on `src/` and `tools/`.
- `npm run build` - compile `src/` into `plugin/`, then put the generated-file header above tsc's `"use strict"` line (`tools/header/`). The committed output must equal a fresh build (CI runs `npm run build && git diff --exit-code`).
- `npm test` - every suite against `plugin/`.
- `npm run coverage` - line and branch coverage of `plugin/hooks/*.cjs`, `plugin/scripts/*.cjs` and `plugin/lib/*.cjs` under every suite, child processes included, with the uncovered line ranges per file. `-- --branches` also lists every branch no suite took; `-- --plugin <dir>` measures another copy, such as the reference.
- `npm run parity -- --ref <rev>`, `npm run parity:real -- --ref <rev>`, `npm run parity:selftest -- --ref <rev>` - see below.

## Parity

The port must not change anything Amber shows to the outside: the stdout, stderr, and exit code of every entry point (hook JSON for each host and every message included), the `.amber/` files of a zone, the ledger rows, and the session state files. Three commands compare a reference build with the working tree's `plugin/`. The reference build is `plugin/` of `<rev>` (default `origin/main`) - code, `run.sh`, `hooks.json`, skills, and references - with two exceptions taken from the working tree: `tests/`, so both builds run the same suites, and the two manifests, whose version is the one outside-visible change every release makes on purpose (it reaches each ledger row as `plugin_version`). The list is `SHARED_WITH_CANDIDATE` in `tools/parity/workspace.mts`.

- `parity` runs every suite against both builds. A preload (`NODE_OPTIONS=--require`, `tools/parity/capture.cts`) acts in each product process the suites start: before the product module runs, it re-runs the same command (same node flags, script path, arguments, environment, and inherited stdin) as a child with stdout and stderr piped, so whatever reaches file descriptors 1 and 2 is recorded whichever channel wrote it; it also records argv, the stdin the product read, the exit code, appended ledger bytes, changed state files, and the zone's `.amber` files afterwards, then forwards the output and ends the way the child ended (exit code or signal). The normalized records are compared as multisets. Temporary directory names and git commit dates are made deterministic at the source; the remaining normalization rules and the reason for each are listed in `tools/parity/normalize.mts`. The last line reads `PARITY invocations=<n> differences=<d>`.
- `parity:real` replays this machine's own records through both builds in scratch zones and scratch Amber homes: every `audit.cjs` command over a ledger snapshot, real tool calls from Claude Code transcripts and Codex rollouts through E1 under each zone's contracts, the S0 briefing of every contract, and `unit init` of every plan. The real ledger and transcripts are only read, and nothing from them is written to the repository. It needs those records, so it runs locally, not in CI. The last line reads `REAL audit=<n> e1=<n> s0=<n> plans=<n> differences=<d>`.
- `parity:selftest` applies four outside-visible mutations to a candidate copy (one character of a briefing, a refusal exit code, an E1 decision, a `progress.json` value) and requires each to be reported, the E1 one by the real-record replay as well. A control that only moves one message from `process.stdout.write` to `fs.writeSync(1, ...)` must report no difference, and a probe that makes `record.cjs` start a grandchild writing to the inherited stdout must be reported by the record comparison itself.

## Porting a module

Each module moves in the same order, so that the comparison has something to bite on before the code changes:

1. List what the module shows to the outside: its exports, the messages it throws or prints, the files it reads and writes with their shape and key order, and the commands it runs.
2. Measure the original's branch coverage (`npm run coverage -- --plugin <reference> --branches`) and pin every branch the suites do not take with a characterization test that asserts what the original returns or throws today, malformed input included, or record why it cannot be reached.
3. Design the types: boundary input arrives as `unknown` and passes a check before it becomes a domain type; closed sets of values are unions closed by exhaustive switches; rules without I/O live apart from the code that reads files, runs git, or reads the clock. A check never accepts or rejects more than the original did - where the original trusted a file or read a foreign format loosely, the source says so.
4. Write the `.cts` source, build, and run `npm test`, `npm run parity`, `npm run parity:selftest`, and `npm run parity:real` against the previous stage. Deliberately break one outside-visible value in the compiled output and confirm the comparison reports it, then rebuild.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`, on Node 20, 22, and 24: `npm ci`, typecheck, lint, format check, the build check, `npm test`, and `npm run parity` against the pull request's base branch or, on a push to `main`, against the previous `main` commit.
