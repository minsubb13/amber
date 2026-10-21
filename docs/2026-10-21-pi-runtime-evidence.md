# Optional pi runtime integration evidence (2026-10-21)

Contract: `docs/2026-10-21-pi-runtime-contract.md`. All results below are local verified observations unless explicitly quoted or unverified.

## Implementation and isolation

- Target checkout `/home/remote3/dev/amber-pi`, branch `pi-port`; preparation `b01eebc`. Driver switched from Claude to `openai/gpt-6.1-sol` before starting U1; environment confirmed that model.
- Read-only source `/home/remote3/dev/pi-model-tools` at `814562b`. Copied/adapted production helpers and mock harness. The 22 production mock cases are ported; the two feasibility spike cases are represented by the two stronger mid-run attribution/enforcement cases, using the production switch tool rather than a separate unrestricted spike tool. Total current integration suite: **34 passed, 0 failed** (`npm run test:pi-runtime`, Node v24.13.1, pi 1.3.0).
- All provider requests in tests go to an ephemeral `127.0.0.1` HTTP server. Child environment is constructed from PATH plus temporary HOME, PI_CODING_AGENT_DIR, AMBER_HOME, offline mode and terminal/locale. Dummy keys and local model endpoints only; no inherited provider credentials, real settings or real session directory. Persistent-session tests write only inside that temporary directory. No real-priority script was executed.
- Handwritten pi modules remain separate from shared enforcement. `runtime/index.ts` registers the false-by-default flag in the factory, then checks it at session_start, after pi parses extension flags and binds APIs. It checks existing switch_model tools and fast commands before registering either helper. No dependencies, settings migration or shared-module edits.

## Behavioral evidence

- Prompt-free flag off/on startup: no HTTP requests before prompting; `/fast` and fast status appear only when on; switch_model declaration and service_tier injection follow the flag. Off mode has no downgrade notice or error fallback.
- Both handoff directions: next request provider/model, transcript model/thinking changes, no confirmation, takeover result, unchanged settings and fresh-process defaults. Invalid allowlist/thinking/credentials produce error without changing state. A deliberate isolated settings mutation proves the defaults oracle detects persistence.
- Fast: OpenAI only; process on/off and invalid arguments; new process resets; completed default/auto/unknown tier warns once, completed priority does not warn even when created tier is auto. Rejection recovers at default once; repeated and unrelated errors do not loop or hijack pi handling. Native retry consumes recovery without a second continuation, for success and failure. Reload preserves toggle and once-only notice.
- Standalone conflict fixtures separately register switch_model and /fast, before and after Amber. Runtime refusal warns, retains the standalone sentinel and introduces no competing handler or priority injection.
- Active-contract fixtures: after either model switch, forbidden writes are blocked and Amber session state attributes the new model. With and without native retry, service-tier recovery cannot release an incomplete contract: a premature done command is refused by the recorder while units are open, S2 requests an incomplete-work continuation, the contract pointer and unverified progress remain, and no duplicate fast continuation occurs. Fixture stops use an explicit external hold after observing the continuation, not fake completion.

## Development failures and corrections

Two failed oracle attempts preceded the passing U1 suite: the first port assumed fast was the last status event (Amber also updates its own status); the second integration run assumed a tools array existed when no tools were registered. Oracles were corrected to select the fast status key and treat an omitted tools array as empty. No product failure was hidden. The subsequent full suite passed all 34 cases. U1 budget: two failed attempts, within the three-attempt limit.

## Supplemental handwritten-pi typecheck

During U2, an additional strict typecheck against installed pi declarations found the standalone mapped TypeBox literal arrays inferred the execute parameter as `never`. U2 was marked failed and U1 reopened serially. Explicit literal tuple schemas fixed inference without changing the accepted values; `tools/test/pi-runtime-types.mjs` now makes that check part of `npm run test:pi-runtime`. The re-entered U1 passed strict adapter/runtime typechecking plus **34/34** mock tests. The standard package typecheck/lint excludes these handwritten sources; no claim of coverage by those commands is made. The native `.ts` mock fixtures themselves are transpiled, not statically typechecked.

## Remaining verification

Full package regressions, fresh-build equality, independent pinned-commit review, final remote push and existing PR #22 verification are recorded in subsequent sections before completion. Raw standalone receipts were copied byte-for-byte under `docs/pi-runtime/` with SHA-256 equality and quoted provenance.

## Full regression verification (U2)

Verified on 2026-10-21, Node v24.13.1 and pi 1.3.0:

- `npm test`: **412 passed, 0 failed**, no skips.
- `npm run typecheck`: passed (shared sources/tools/compiled-test project).
- `npm run lint`: passed, zero warnings under the existing configuration.
- `npm run format:check`: passed, including runtime mock tests and supplemental tooling.
- `npm run test:pi-runtime`: strict handwritten adapter/runtime typecheck passed; **34 passed, 0 failed**, no skips.
- `npm run build`: passed. `git diff --exit-code -- plugin/lib plugin/hooks plugin/scripts` passed: no generated artifacts or shared/other-host modules changed.

Raw local command outputs: `docs/pi-runtime/{package-test,runtime-test,typecheck,lint,format,build}.log`. These contain local mock verification only. Existing installed gh does not support the planned `headRefOid` JSON field; final verification will use the equivalent GitHub REST `pulls/22` head.sha plus `gh pr view` branch/body and `git ls-remote`, not weaken remote-head equality.

## Real-provider limitation (quoted provenance)

Source `814562b`, `docs/findings.md`: two authorized requests were consumed. Original HTTP400 rejected unsupported reasoning.effort=none, not service_tier. Corrected HTTP200 accepted a priority payload but response.completed reported **service_tier=default**, not priority. These are quoted reference observations, not an integrated live-provider test. Priority execution, speed and quota impact remain **unverified**. No further real probes are authorized.
