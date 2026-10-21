# Independent Claude runtime review (2026-10-21)

Verdict: PASS

Pinned implementation/evidence commit: `00be0e0fd2d82e73c28ebf00df2ed2e3747492e0`. Reviewer: independent `claude -p`, permission mode `dontAsk`, tools restricted to `Read,Grep,Glob`; settings sources and MCP discovery disabled. Read-only added directories were installed pi packages and the source reference. Reviewer authored no files; driver captured the output below. No source/test edits were made after this review.

The first invocation timed out after 300 seconds with no output and no surviving reviewer process; this was not treated as a verdict. The second invocation, with a 600-second budget and isolated settings discovery, returned the complete PASS below. No MUST-FIX was reported. All findings are dispositioned here; final validation/remote conditions remain U4, not a claim made by the review.

## Driver dispositions

- E1 (LOW): accepted. U4 will capture the full-tree `git diff --exit-code` immediately across a fresh build, not just the generated directories; the concrete result goes in the final evidence section.
- E2 (LOW): accepted. U4 will bind final command evidence to a committed HEAD/tree and preserve raw output.
- E3 (oracle compatibility): accepted equivalent oracle. Installed gh lacks `headRefOid`; use `gh pr view 22 --json headRefName,url,body,state` and `gh api repos/minsubb13/amber/pulls/22 --jq .head.sha` plus `git ls-remote origin refs/heads/pi-port`. Equality to final pushed HEAD is still mandatory. Record this substitution in the plan and U4 evidence; no new remote operation is authorized.
- E4 (remaining delivery): accepted. This file supplies the independent review artifact. Normal push and existing PR update/equality will be evidenced in U4 before completion.
- S1 (optional lazy import): deferred. pi 1.3.0 supplies the aliased module; default-off real-pi tests pass. No current required-condition violation; avoid post-review implementation churn.
- S2 (optional settle comment): deferred. Runtime error recovery and Amber completed-only S2 have disjoint outcomes, independently inspected in pi implementation and covered by mock interactions.
- S3 (optional stronger assertions): deferred. Reviewer explicitly identifies the exact four-request oracle as proving S2 continuation independently of the broad text assertion; forbidden file absence and tool error prove write refusal. No MUST-FIX or disputed required condition.
- S4 (style): deferred. Existing adapter style and ported helper style differ; strict supplemental typechecking covers handwritten sources, and the required existing format command passes.
- S5 (fail-closed command matching): accepted as conservative conflict refusal. Any existing fast command refuses opt-in registration, never competes with one.

## Verbatim reviewer output

**Verdict: PASS.** I found no MUST-FIX. Conditions 1–5 hold against the artifacts at the pinned commit. Condition 6 is still open and I don't count it as met: `docs/2026-10-21-pi-runtime-review.md` doesn't exist yet, and U4 (normal push and PR #22 update) is pending.

**Pinned SHA:** `00be0e0fd2d82e73c28ebf00df2ed2e3747492e0`. `.git/HEAD` points to `refs/heads/pi-port`, which equals this SHA. I had only Read/Grep/Glob, so I could not run git, tests, builds or hashes myself. Wherever a claim depends on those, I say so below.

## Files inspected
- **Contract and plan:** `docs/2026-10-21-pi-runtime-contract.md` and `docs/2026-10-21-pi-runtime-plan.md`, read in full.
- **Runtime source:** `plugin/pi/index.ts` and `plugin/pi/runtime/{index,switch-model,fast}.ts`.
- **Tooling and tests:** `tools/test/pi-runtime-types.mjs`, `test/pi-runtime/helpers/pi.ts`, and `test/pi-runtime/e2e/{integration,fast,switch,reload}.test.ts`.
- **Docs and evidence:** `README.md` (opt-in section), `DEVELOPMENT.md` (layout and runtime tests sections), `package.json`, `docs/2026-10-21-pi-runtime-evidence.md`, and `docs/pi-runtime/{README.md, *.log, real-priority*.json}`.
- **pi 1.3.0:** `core/extensions/loader.js` and `runner.js` read in full; in `agent-session.js`, the boundary, settle, retry, abort, model_select and bindCore sections; the extension-flag handling in `agent-session-services.js`; the `remove` and `list` commands in `package-manager-cli.js`.
- **Standalone source:** `/home/remote3/dev/pi-model-tools` `src/{fast,switch-model}.ts`, `package.json`, and `scripts/real-priority*.json`.

## Findings, condition by condition

**C1, default off: met.**
- `runtime/index.ts:7-11` registers a boolean flag defaulting to false. In pi 1.3.0, factory-time `registerFlag` stores the default only provisionally; the parsed CLI value is applied after loading (`loader.js:260-275, 433-445`; `main.js:607`). So reading the flag at `session_start` instead of in the factory is the right lifecycle choice.
- Nothing optional is registered unless the flag is `true` (`index.ts:14`).
- Tests `integration.test.ts:61-116` show, with the flag off: no `/fast`, no fast status, no `switch_model` in the request, no `service_tier`, no notices, and a single request on a 400 error. They also show no HTTP requests before the first prompt.
- `package.json` adds no dependencies.

**C4, standalone conflict before duplicate handlers: met.**
- The conflict check runs at `session_start`, after every extension factory has loaded. If a standalone `switch_model` or `/fast` exists, it returns before `switchModel(pi)` or `fast(pi, ctx)` is called (`index.ts:18-24`). So no competing tool, command or event handler is ever registered.
- This matters because pi lets the first-registered tool win (`runner.js:411-421`) and renames duplicate commands as `fast:1`/`fast:2` (`runner.js:556-584`). Overriding silently would therefore depend on load order; refusing avoids that.
- Tests cover both tool and command, with the standalone loaded before and after Amber (`integration.test.ts:118-168`). Each asserts exactly one warning, the standalone sentinel kept, a single `fast` command, and no priority injection.
- README:71 documents manual removal with `pi list` / `pi remove`; both commands exist in 1.3.0. Nothing is uninstalled or edited automatically.

**C2, switch semantics and model attribution: met.**
- The tool is identical to the standalone except that the schema uses explicit literal tuples, which fixes a `never` type for the parameters. The accepted values are unchanged.
- `pi.setModel` checks credentials before changing anything (`agent-session.js:2776-2781`) and emits `model_select`. Amber's existing handler then writes `event.model.id` into the session state (`plugin/pi/index.ts:182-194`), so attribution follows the switch. This holds even though the runtime is a separate module.
- Tests cover:
  - both directions of handoff;
  - the transcript `model_change` and `thinking_level_change` entries;
  - unchanged settings and fresh-process defaults;
  - refusals for allowlist, missing credentials and invalid thinking;
  - session-state attribution after a switch in both directions (`integration.test.ts:217-219`).

**C3/C4, enforcement and the S2/native-retry interaction: met.**
- The completion gate (S2) and the fast recovery never fire on the same settle. pi sets the settle outcome to `error` for an error stop (`agent-session.js:489-490`), and Amber's S2 only acts on `completed`. Fast recovery only acts after a service-tier error.
- pi's native retry continues before the settle boundary (`agent-session.js:1419-1427`). When that happens, the `retryPending = false` reset in `before_provider_request` consumes the pending recovery. An abort skips the settle boundary entirely (`agent-session.js:1426`).
- `integration.test.ts:228-309` (with and without native retry) shows:
  - exactly four requests (priority, then three at default tier);
  - a fifth request makes the mock throw "duplicate continuation" (`integration.test.ts:262`), and the request-count assertion would fail too;
  - the recovery entry is absent when native retry ran and present once otherwise;
  - the premature `done` call leaves `active.json` in place and U1 unverified;
  - exactly one "continuing once" notice.
- Writes are blocked after a switch in both directions: `forbidden.txt` is absent and the tool result is an error.

**C5, tests and docs: met, based on committed evidence I could not re-run.**
- The test files contain 34 cases (11 integration, 15 fast, 7 switch, 1 reload), matching `runtime-test.log` (34/34).
- `package-test.log` shows 412/412 passing. The typecheck, lint and format logs show success.
- The test harness isolates HOME, `PI_CODING_AGENT_DIR` and `AMBER_HOME`, uses a minimal environment, dummy keys, a loopback-only server, `--no-extensions` and `--no-session` unless a test persists a session.
- README and DEVELOPMENT cover opt-in use, controls, migration, prerequisites and the real-tier limits.
- The receipts in `docs/pi-runtime/` match the source receipts line for line. I could not check the SHA-256 values myself.

## Unsuitable or missing evidence (no MUST-FIX)
- **E1 (LOW):** The build-equality claim rests on prose only. `docs/pi-runtime/build.log` shows `npm run build` but not the `git diff --exit-code -- plugin/lib plugin/hooks plugin/scripts` result, and that path list is narrower than DEVELOPMENT.md:27 (`git diff --exit-code` over the whole tree). I couldn't run git to confirm shared modules are unchanged. Suggest capturing the diff command and its exit status at U4.
- **E2 (LOW):** The raw logs don't record which HEAD or tree they ran against. They were committed in 00be0e0 after the source commit e16d53b. U4's planned re-run on the final HEAD should close this.
- **E3 (process, U4):** The plan's U4 oracle uses `gh pr view --json headRefOid`, which the evidence (line 43) says the installed gh doesn't support. The proposed replacement (REST `head.sha` plus `git ls-remote`) is reasonable, but it is an oracle change. It should be explicitly recorded and dispositioned at U4 rather than treated as already settled.
- **E4:** Condition 6 has no artifacts yet. The review file and the PR #22 head/body are not present, as expected while U4 is pending.

## Optional suggestions (not condition violations)
- **S1:** `runtime/index.ts` statically imports `@earendil-works/pi-ai` even when the flag is off. If that import ever failed to resolve, the whole Amber extension would fail to load and enforcement would be gone. That holds in pi 1.3.0, where the alias always resolves and the flag-off test proves the extension loads. A lazy import inside the `session_start` branch would keep enforcement independent of the optional helpers.
- **S2:** In a single settle, a later handler's `entries` replace an earlier one's (`runner.js:775-776`), and fast's handler runs after Amber's S2. This can't happen today because their outcomes never overlap. A short comment in `fast.ts` would stop a future change from silently dropping an S2 block message.
- **S3:** Some assertions are weak:
  - `integration.test.ts:288-294` matches `/open|unit|incomplete|verified/` against any `amber` entry, so a hidden session-start briefing could satisfy it. The S2 block is actually proven by the four-request count.
  - `integration.test.ts:211` uses a broad regex for the write refusal.
  - Asserting the S2 reason text and the specific E1 refusal text would make both tests more direct.
- **S4:** The runtime files use 2-space indentation and single quotes; `plugin/pi/index.ts` uses tabs and double quotes. They also fall outside `format:check`. Consider matching the adapter's style.
- **S5:** The conflict check counts any command named `fast`, including a prompt template. That fails closed, which is acceptable, but it could be mentioned in the docs.
