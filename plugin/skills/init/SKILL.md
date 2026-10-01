---
name: init
description: Port Amber into a project zone - scan the code into an oracle map, interview the operator until tensions are exhausted, generate or map the fixed documents, and finish the sensor install. Invoke ONLY on an explicit operator request to install, port, or initialize Amber in a project ("install amber here", "port amber into this project"); never by your own judgment. Do not open a planning cycle for init itself - init is the bootstrap act and its human gate is the ratification beat.
allowed-tools: Read, Bash, Grep, Glob, Write, Edit, Agent
---

# init - porting Amber into a project

Goal: make a project zone Amber-ready. The code's answers are collected
without asking (oracle map), the human's answers are elicited only where
code cannot answer (tension list), the fixed documents end up present or
mapped, and the sensors are live.

## Principles

- Every question stands on a scanned fact and cites its evidence - no
  free-floating questionnaires.
- The generated or mapped documents become settled only by operator
  approval - the model generates, the human fixes.

## Input and preconditions

- Before scanning, read [host integration](../../references/hosts.md) and
  the [run protocol](../../references/protocol.md). On Codex, execute its
  `invoke init` recorder command once for this invocation; on Claude Code,
  use the automatic Skill tool record only.
- Canonical path: run this skill inside the target zone.
- Precondition: Amber is installed and enabled for the current host and
  zone. Use the host integration's installation checks; if this is missing,
  hand the operator the host's installation instructions first and stop.

## Procedure

1. **Scan (code track) -> oracle map.** Ask no human questions here. Run
   three read-only subagents, each owning a coverage charge - a charge
   means the agent keeps looking until its question is answered, not a
   fixed checklist:
   - **Verification assets** - what gets checked for free, and how: build,
     tests, vectors, benchmarks, CI, static analysis. Each row: what it
     verifies, how to invoke it, what it does NOT guarantee.
   - **Knowledge assets** - what the documents already answer: docs,
     scattered intent, existing harness documents; which document roles
     are filled and which are empty.
   - **History and environment** - everything that reaches this zone from
     outside its checkout: version-control state beyond the working tree
     (index, staged work, recent history), ancestor-directory instructions
     and settings, hooks, anything a session here would load.

   Every returned row cites its evidence (file:line or command output);
   before a row feeds an interview question, re-verify it in the main
   context. Harness assets found anywhere - in the zone or above it - are
   reported to the operator, who may not know they are active; their
   disposition belongs to the operator.

   Exit: one oracle-map document merges everything the three charges
   returned.
2. **Interview (non-code track) -> tension list.** Reuse the planning
   taxonomy: conflict, gap, unanswered, solo-decision. Run the four ELICIT
   gates: attempt self-answer first (a self-answered row is kept with its
   discarding evidence), statement-vs-code check, cross-answer consistency,
   open-question tracking (a vague answer stays open until re-asked or
   explicitly deferred).

   Exit: tension exhaustion - unresolved load-bearing decisions number zero
   (a countable end state, not a score), recorded in one tension-list
   document.
3. **Documents - generate or map.** Greenfield: generate the four fixed
   documents (entry-point router `CLAUDE.md` on Claude Code or `AGENTS.md`
   on Codex, intent.md, status.md, and the work-logs convention).
   Brownfield: map first - assign existing assets to those roles and fill
   only the empty roles; never duplicate a source of truth. When a role
   requires changing an existing tracked file, ask the operator first: back
   up and replace, or emit a draft for manual apply. Apply the
   non-derivability filter everywhere: no sentence a reader could derive
   from code. Re-run semantics = re-map and report staleness.

   Exit: every fixed-document role is generated, mapped to an existing
   asset, or handled as the operator chose for a tracked file.
4. **Sensors.** Two acts.
   - **Entry-document section.** Add the completion-signal protocol section
     to the zone's current-host entry document. It states, for that zone,
     every rule of the run protocol's "Completion" - its no-signal rule
     stated explicitly - and its approval boundary ("Approval"), writing the
     signal out as the model's last tool call in the zone root:
     `node "<amber_plugin_root>/scripts/record.cjs" done --review "<concise evidence-based review result>" --summary "<one-line summary>"`,
     adding `--goal "<goal-test result>"` under an active contract. State
     also that pure Q&A, discussion, and status responses run no signal and
     remain unaffected, and that cycle events are recorded by invoking the
     amber:mark skill with args "skip - ..." or "finding - ..." and following
     its host-specific recording step (a zone whose entry document lacks this
     sentence loses its findings).
   - **Self-check.** Verify the sensors yourself - confirm the S0 opening
     reached your context, then check the operator-global state and ledger
     for this session's records. No human verification step; the harness
     helps quietly. The ledger and state live operator-global, so nothing
     else is installed per zone.

   Exit: the entry document carries the section, and this session's S0
   opening and ledger records are confirmed.
5. **Ratification.** Present the diff of every document this run created or
   changed, then stop.

   Exit: the diffs are presented and the turn has stopped for the
   operator.

## Completion

init is done when the goal above holds - oracle map, tension list, fixed
documents present or mapped, sensors live - and step 5 has presented every
diff; nothing it generated or mapped is settled until the operator approves
it.
