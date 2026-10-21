# Contract - optional pi runtime tools in Amber PR #22 (2026-10-21)

No load-bearing decision absent from this contract proceeds: stop and bring the question.

Pin: start commit b6b37a3dd965717157dab27d37c142df1b936329
Approval: Minseop Choi 2026-10-21 - operator said "좋아. 진행하자" after the proposal to extend existing PR #22 on pi-port with opt-in --amber-runtime and independent Claude review. Verification state at approval: target clean on pi-port tracking origin/pi-port; PR #22 is open against main; standalone source at /home/remote3/dev/pi-model-tools commit 814562b has 24 passing mock tests and independent PASS reviews. Integrated flag behavior and Amber interactions are not yet tested.

## Goal and background

Bring the existing model handoff and priority-request controls into Amber's pi host as optional execution-environment helpers, not mandatory enforcement policy. Continue the existing PR https://github.com/minsubb13/amber/pull/22, not a new PR/branch. Claude Code and Codex behavior remains unchanged.

Reference implementation (read-only): /home/remote3/dev/pi-model-tools/src/{switch-model,fast}.ts, test/helpers/pi.ts, test/e2e/*.test.ts and docs/findings.md. The standalone real check used two operator-authorized requests: first HTTP400 on unsupported reasoning.effort=none, corrected HTTP200 with completed service_tier=default despite a priority request. This is evidence of payload acceptance, NOT priority execution or speed benefit. Preserve that caveat and provenance; do not repeat real-provider tests.

## Completion conditions

All conditions must hold. Partial progress is not completion.

1. **Opt-in pi integration.** Amber advertises the boolean CLI flag `--amber-runtime`, default false. Without it, existing Amber behavior is preserved: no runtime switch tool, fast command/status, priority injection, tier notifications or fallback. With it, Amber loads the two helpers from dedicated pi-only modules, separate from its enforcement adapter. No runtime npm dependency or additional install step is introduced. Other hosts are unaffected.
2. **Model handoff.** Opted-in `switch_model` preserves the standalone interface and fixed allowlist (`openai/gpt-6.1-sol`, `anthropic/claude-opus-5-5`), optional pi thinking level, no confirmation, session-only default selection, session transcript recording, next-request pickup in both directions and takeover result. Invalid target/thinking or unusable credentials yields a tool error without changing model/thinking. Amber's model attribution follows the switch.
3. **Fast controls.** Opted-in runtime defaults fast on per process, supports `/fast [on|off]`, shows `fast` while on, and injects priority only on OpenAI agent-loop requests. Completed-response tier is authoritative, with at most one downgrade/unknown notice per process. HTTP400 errors naming service_tier turn fast off, notify and continue once at default tier, without loops or duplicate continuation when native pi retry already started. Other errors retain normal pi handling. Preserve process state across reload as applicable, and historical wording of retry context. Summary/compaction behavior is not changed.
4. **Coexistence and safety.** Amber S0/S1/S2/S3/E1 behavior is preserved; switching or fast recovery cannot bypass write refusals or declare incomplete work complete. Mock-driven integration covers enforcement after a switch and interaction between tier recovery and the completion gate. Do not silently override an independently installed `switch_model` or register competing `/fast` handlers: detect the standalone conflict and clearly refuse/disable the new runtime, or otherwise fail closed before duplicate handlers operate. Document removing the old standalone package before enabling Amber runtime; never edit settings to remove it automatically.
5. **Tests and documentation.** Local isolated real-pi mock tests port the existing behavioral coverage and add flag-off/on, standalone conflict, and Amber interaction cases. No test sends a real OpenAI/Anthropic request, reads real auth, changes real agent settings or writes real session files. `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and the new runtime test command pass with existing dependencies. Build artifacts match a fresh build if affected. README and DEVELOPMENT explain opt-in use, controls, migration, test prerequisites/commands and real-tier limitations. Preserve the original raw real receipts as evidence under docs if copied, with explicit quoted provenance.
6. **Independent review and existing PR.** Claude via `claude -p` reviews the pinned commit, contract, actual artifacts and evidence read-only, not an author-summary substitute. No MUST-FIX open, every finding disposed; applied fixes are re-reviewed. Record review in docs/2026-10-21-pi-runtime-review.md. Commit changes on pi-port, use a normal push to origin pi-port to extend PR #22, and append/update its body to include the opt-in runtime and actual verification evidence without discarding the existing pi-port description. No new PR, merge or release.

Verification (oracles): existing package checks; isolated real-pi mock runtime tests; flag-off/on prompt-free registration; recorded interaction tests; review verdict/dispositions; clean git tree and gh PR #22 head/description after normal push.
Not answered: priority speed or quota consumption; new model targets/configurable routing; audit support for pi transcripts; other host runtime features; releasing or merging PR #22.

## Forbidden rows

- Write scope: pi host source [machine: write-scope plugin/pi/**]
- Write scope: package manifest [machine: write-scope package.json]
- Write scope: operator docs [machine: write-scope README.md]
- Write scope: development docs [machine: write-scope DEVELOPMENT.md]
- Write scope: tests [machine: write-scope test/**]
- Write scope: test tooling if needed [machine: write-scope tools/test/**]
- Write scope: run docs and evidence [machine: write-scope docs/**]
- Write scope: ignore rules for temporary runtime test files [machine: write-scope .gitignore]
- Do not change shared enforcement, recorders, compiled plugin/lib or other-host behavior; no new dependencies or lockfile edits [self-report]
- Source repository /home/remote3/dev/pi-model-tools is read-only. Preserve its real-request receipts, never rerun its real probe. No real provider requests by tests or verification scripts; Claude review and the driving pi session are not test probes [self-report]
- Outside this repository, do not edit settings, credentials, installed pi, installed Amber, other repositories or session files. Tests use disposable isolated directories; their temporary data is the only exception. No automatic uninstall of pi-model-tools [self-report]
- Remote writes are limited to normal push of pi-port and editing existing PR #22 body; do not create PRs, merge, release, or push other branches [self-report]
- Do not add npm packages [machine: bash-deny (?:^|[\n;&|])\s*(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\s+(?:-\S+\s+)*[^\s;&|-]]
- Do not force-push [machine: bash-deny (?:^|[\n;&|])\s*git(?:\s+-[Cc]\s+\S+|\s+--\S+)*\s+push\b(?:[^\n;&|"']|"[^"\n]*"|'[^'\n]*')*(?:--force\b|--force-with-lease\b|-f\b|--mirror\b|--delete\b|\s\+[a-zA-Z0-9_/-])]
- Do not rewrite history or hard-reset [machine: bash-deny (?:^|[\n;&|])\s*git(?:\s+-[Cc]\s+\S+|\s+--\S+)*\s+(?:commit\b(?:[^\n;&|"']|"[^"\n]*"|'[^'\n]*')*--amend\b|rebase\b|filter-branch\b|filter-repo\b|reset\b(?:[^\n;&|"']|"[^"\n]*"|'[^'\n]*')*--hard\b)]
- Specify files explicitly when staging or committing [machine: bash-deny (?:^|[\n;&|])\s*git(?:\s+-[Cc]\s+\S+|\s+--\S+)*\s+(?:commit|add)\b(?:[^\n;&|"']|"[^"\n]*"|'[^'\n]*')*\s(?:-[aA]\b|-am\b|--all\b|\.(?=\s|$)|:/(?=\s|$))]

## Budget

At most 3 failed oracle attempts per unit before holding. On reaching it: INCOMPLETE - RESUME REQUIRED (resume: open pi in /home/remote3/dev/amber-pi on openai/gpt-6.1-sol, read this contract and docs/2026-10-21-pi-runtime-plan.md, then resume the first open unit via record.cjs).

## Settled decisions

- Extend existing PR #22 on pi-port, not a separate PR (operator 2026-10-21).
- Optional runtime, activated only by --amber-runtime; otherwise existing behavior unchanged (operator approved 2026-10-21).
- Preserve current switch_model and /fast behavior and limits, with Claude read-only independent review (operator approved 2026-10-21).
- Execution runs in a pi session rooted in /home/remote3/dev/amber-pi so Amber enforces the correct zone; preparation from /home/remote3/dev/pi-model-tools transfers ownership to that session without executing target implementation in the source zone.

## Discretion

Module/test layout within allowed paths, flag registration lifecycle consistent with pi 1.3.0, diagnostic wording, native test script name, reversible mock fixture structure, and exact PR-body section formatting. The original typed source may be adapted to Amber's conventions without changing required behavior. Keep core-policy integration minimal; no generalized profiles/settings framework.

## Standing rules

- End the run with the completion report (`references/reports.md`) once after the completion signal: show the deliverable, state what changed where and what verified it, and explain it for a reader with no context. The signal never replaces the report [self-report]
- Before the signal, semantically re-check the request, every required condition, current artifacts, and validation evidence. Missing, failed, unsuitable, or stale evidence means not complete; after any edit during re-check, re-validate and re-check [self-report]
- Incomplete, blocked, waiting, and status-only turns run no completion signal; the signal declares the contracted work itself complete, never an assessment, report, or attempt [self-report]
- Pass the re-check to `record.cjs done --review "<evidence summary>" --goal "<goal-test result>" --summary "<summary>"` (last tool call; no marker line in the message). On pass, S2 removes the pointer and `progress.json` [hook: S2]
- Numbers and claims carry provenance (verified / quoted / unverified) [self-report]
- Independent review: reviewer reads pinned commit, contract, artifacts and evidence read-only. Findings cite violated conditions and evidence; a disputed MUST-FIX on a required condition means incomplete [self-report]
- Plan units transition only via `record.cjs unit`; announce stops with open units via `amber:mark hold`. This run is serial, not parallel [self-report]

## Question handling

Stop and ask on any load-bearing decision not settled here. Do not repeat real-tier tests or invent another speed mechanism when priority is downgraded. If normal push is rejected, do not rebase/force; report and ask.

## Carry-over

- Source package remains installed and unchanged until operator explicitly removes it following migration docs.
- Actual priority execution/speed/quota remains unverified; the existing corrected receipt reports default.
- Next action: U1 in target-rooted pi session.
