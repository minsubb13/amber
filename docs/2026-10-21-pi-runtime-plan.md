# Plan - optional pi runtime tools in existing PR #22 (2026-10-21)

Contract: docs/2026-10-21-pi-runtime-contract.md. Authority: operator approved "좋아. 진행하자" to opt-in --amber-runtime, existing pi-port PR and independent review.

Execute serially in a pi session rooted in /home/remote3/dev/amber-pi, on openai/gpt-6.1-sol. Do not turn on the new runtime in the implementation session unless required by an isolated test. Source reference /home/remote3/dev/pi-model-tools is read-only. All provider test traffic must use local mocks and temporary agent/auth/HOME/AMBER_HOME directories. Never rerun scripts/real-priority.mjs.

## Work units

- [x] U1 Integrate gated runtime modules and isolated regression tests [unit: U1 scope=plugin/pi/**,package.json,test/**,tools/test/**,.gitignore,docs/2026-10-21-pi-runtime-evidence.md oracle=npm run test:pi-runtime]
- [x] U2 Document opt-in use, migration, limits and capture full verification evidence [unit: U2 scope=README.md,DEVELOPMENT.md,docs/2026-10-21-pi-runtime-evidence.md,docs/pi-runtime/** after=U1 oracle=npm test && npm run typecheck && npm run lint && npm run format:check && npm run test:pi-runtime]
- [x] U3 Independent read-only Claude review; dispose findings and re-review fixes [unit: U3 scope=docs/2026-10-21-pi-runtime-review.md after=U1,U2 oracle=grep -q '^Verdict:' docs/2026-10-21-pi-runtime-review.md && ! grep -qE '^- F[0-9]+: unresolved' docs/2026-10-21-pi-runtime-review.md]
- [ ] U4 Final integration validation and normal push to existing PR #22 [unit: U4 scope=docs/2026-10-21-pi-runtime-evidence.md,docs/2026-10-21-pi-runtime-plan.md after=U3 oracle=npm test && npm run typecheck && npm run lint && npm run format:check && npm run test:pi-runtime && gh pr view 22 --repo minsubb13/amber --json headRefName,url && gh api repos/minsubb13/amber/pulls/22 --jq .head.sha]

## Implementation notes (revisable, not extra authority)

- Inspect pi 1.3.0 flag parsing/registration lifecycle: --amber-runtime must be available to ordinary pi startup, but runtime commands/tool must not be exposed or execute when off. Do not assume getFlag is populated during extension factory evaluation; prove flag-off and flag-on in a real pi subprocess.
- Keep policy adapter in plugin/pi/index.ts minimal; optional runtime should remain separable and should not change shared modules.
- Reuse standalone mocks, but tests must load real Amber with isolated AMBER_HOME and test fixtures, not the operator's installed packages/auth/settings. Observe both runtime behavior and shared enforcer/stop state.
- Migrate existing behavior tests, then test integration: model attribution after switching, forbidden write after switching, non-complete stop after fast fallback, and no double continuation between fast, native retry and S2.
- Standalone coexistence: prefer a clear refusal/disable with migration instructions over silently registering duplicate switch_model/fast names. Do not automatically uninstall or edit real settings.
- Core regression commands are required regardless of whether handwritten pi source is outside tsc/lint. Do not claim handwritten runtime typechecking from a command that excludes it; add a suitable runtime oracle if practical without adding dependencies.
- Review invocation: claude -p '<review request with pinned commit, contract, artifacts and evidence paths>' --permission-mode dontAsk --tools 'Read,Grep,Glob'. Grant read-only --add-dir to installed pi code when needed. Review writes no files; author captures output. Applied source/test fixes re-enter the corresponding unit and are independently re-reviewed.
- Build verification: run npm run build; generated artifacts must remain unchanged since shared enforcement is out of scope.
- Final PR update: git push origin pi-port (normal only) and update existing PR #22 body by preserving the current text and appending optional-runtime summary/real validation/limits. No PR creation, merge or release. Verify remote PR head equals final pushed HEAD. Preserve docs/evidence in commits so review references are reproducible.

## Progress log

- 2026-10-21 operator clarified that existing pi port PR #22 is the destination and selected optional integration.
- 2026-10-21 operator approved the proposal: "좋아. 진행하자". Scope proposal: startup flag --amber-runtime, existing fixed allowlist and behavior, ported mocks plus Amber interaction checks, migration/conflict handling and independent Claude review.
- 2026-10-21 preparation: pi-port at b6b37a3, clean target before these docs; existing PR #22 open against main. Source standalone implementation at 814562b has 24 passing tests and PASS reviews; these are reference evidence, not proof of this integration.
- Execution: target-rooted driver on openai/gpt-6.1-sol registered through unit start U1. U1 passed 34 isolated mock tests; U2 added a strict handwritten-pi typecheck and full 412-test package regressions. A supplemental type inference finding reopened U1 serially, was fixed, and all checks passed again.
- Independent Claude review pinned `00be0e0fd2d82e73c28ebf00df2ed2e3747492e0`: PASS, no MUST-FIX; dispositions in `docs/2026-10-21-pi-runtime-review.md`.
- U4 oracle compatibility adjustment: installed gh cannot return `headRefOid`; use `gh pr view` for branch/body and GitHub REST `.head.sha`, cross-checked with `git ls-remote`. The required equality to pushed HEAD is unchanged. This is a CLI-version adaptation, not a relaxation or new remote authorization.
- U4 final tests at `fdd8ab33c2adaff62a64ebd54767e3619585e158`: 412/412 package tests, 34/34 runtime tests plus strict handwritten types, required lint/typecheck/format commands, full-tree fresh-build diff all passed. Normal push and PR update are the remaining delivery checks.
