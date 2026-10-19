---
name: init
description: Port Amber into a project zone - scan the code into an oracle map, interview the operator until tensions are exhausted, generate or map the fixed documents, and finish the sensor install. Invoke ONLY on an explicit operator request to install, port, or initialize Amber in a project ("install amber here", "port amber into this project"); never by your own judgment. Do not open a planning cycle for init itself - init is the bootstrap act and its human gate is the ratification beat.
allowed-tools: Read, Bash, Grep, Glob, Write, Edit, Agent
---

# init - porting Amber into a project

Goal: make a project zone Amber-ready by scanning code into an oracle map,
interviewing the operator only where code cannot answer (tension list),
generating or mapping the four fixed documents, and verifying live sensors.

## Principles

- Every question stands on a scanned fact and cites its evidence (never a
  free-floating questionnaire). An empty row is itself a scanned fact: a charge
  that found nothing anchors the question for the unfilled role and cites that
  empty row (and the scan/oracle map/charge name) as its evidence.
- Generated or mapped documents become settled only by operator approval.

## Input and preconditions

- Read [host integration](../../references/hosts.md) (`## Skill names and package root`,
  `## Invocation and event records`, and `## Project entry point and installation`)
  and [run protocol](../../references/protocol.md). On Codex, run `invoke init`
  once; on Claude Code, rely on the automatic Skill hook.
- Run inside the target zone. Confirm Amber is installed and enabled for the
  current host and zone; if missing, give the host's install instructions and stop.

## Procedure

1. **Scan (code track) -> oracle map.** Ask no human questions here. Run three
   read-only subagents, each owning a coverage charge:
   - **Verification assets** - build, tests, vectors, benchmarks, CI, static
     analysis: what each verifies, how to invoke it, and what it does NOT guarantee.
   - **Knowledge assets** - docs, scattered intent, existing harness files:
     which document roles are filled and which are empty.
   - **History and environment** - git index/staged/recent history, ancestor
     instructions/settings, hooks, and anything a session here would load.

   Every row cites `file:line` or command output; re-verify rows in the main
   context before asking about them, and report any harness assets found in or
   above the zone for operator disposition.
   *Exit:* one oracle-map document merging all three charges; any charge that
   found nothing is recorded as an explicit empty row (never omitted).
2. **Interview (non-code track) -> tension list.** Reuse the `planning`
   taxonomy (`conflict`, `gap`, `unanswered`, `solo-decision`) and four gates:
   self-answer first (keep discarded rows with evidence), statement-vs-code
   check, cross-answer consistency, and open-question tracking. Questions from
   empty rows are bounded to the three slots of `intent.md` - purpose (why the
   project exists), first oracle (what verifies its work), and forbidden set
   (what it will never do) - asked as distinct questions citing the empty scan
   findings. Everything else an empty zone leaves open is either an `init`
   default (entry router, `status.md`, work-logs convention) or left for the
   first `planning` cycle. Questions from non-empty rows keep their own evidence.
   *Exit:* tension exhaustion (zero unresolved load-bearing decisions; every
   `intent.md` slot filled or explicitly deferred) in one tension-list document.
3. **Documents - generate or map.**
   - **Greenfield:** generate the four fixed documents (entry router `CLAUDE.md`
     on Claude Code or `AGENTS.md` on Codex, `intent.md`, `status.md`, and the
     work-logs convention). Fill `intent.md` (`purpose`, `first oracle`, `forbidden set`)
     solely from the operator's answers.
   - **Brownfield:** map existing assets to those roles first and generate only
     empty roles without duplicating sources of truth. Before changing a tracked
     file, ask whether to back up and replace or emit a draft. Omit anything
     derivable from code; on re-runs, re-map and report staleness.
   *Exit:* all four fixed-document roles are generated, mapped, or drafted as chosen.
4. **Sensors.**
   - **Entry-document section:** add the completion-signal protocol section to
     the current host's entry document (`CLAUDE.md` or `AGENTS.md`), stating the
     rules of [protocol](../../references/protocol.md) `## Completion` (including
     the explicit no-signal rule for incomplete/Q&A/discussion/status turns) and
     `## Approval`, the last-tool-call command
     `node "<amber_plugin_root>/scripts/record.cjs" done --review "<concise evidence-based review result>" --summary "<one-line summary>"`
     (plus `--goal "<goal-test result>"` under an active contract), and that
     cycle events use `amber:mark` with `skip - ...`, `finding - ...`, or
     `hold - ...` via the host's recording path.
   - **Self-check:** confirm the S0 briefing reached this session's context and
     check the operator-global state and ledger for this session's records.
   *Exit:* entry section written and S0 + ledger records confirmed.
5. **Ratification.** Present the diff of every document created or changed, then
   stop and wait for the operator.

## Completion

`init` completes when the oracle map, tension list, fixed documents, and live
sensors are in place and step 5 has presented every diff for ratification.
