---
name: set
description: Write and finalize an Amber per-run contract from a completed planning dialogue - draft the contract document and its plan, check the machine rows, commit, report, and wait for the operator's approval utterance; on an explicit approval create .amber/active.json and start the run. Invoke automatically when planning's elicitation is exhausted, or when the operator asks to finalize a hand-written draft. Approval is the operator's explicit utterance in conversation - never create the pointer without one.
allowed-tools: Read, Bash, Write, Edit
---

# set - contract writing and approval

set turns settled planning material into a contract that freezes the boundary
(plus a revisable plan when the run has multiple units), reports its
understanding, waits for the operator's approval utterance (`protocol.md`
"Approval"), and only then creates `.amber/active.json`.

## Principles

- Edit the contract only before the pointer exists; the tamper guard freezes it
  afterward while the plan stays editable.
- The write list is scaffolding; the forbidden rows are the real boundary.

## Input and preconditions

- If `hosts.md` and `protocol.md` were already read during `planning` in this
  session, do not re-read them; otherwise read [host integration](../../references/hosts.md)
  (`## Skill names and package root`, `## Invocation and event records`) and
  [run protocol](../../references/protocol.md) (`## Approval`). On Codex, run
  its `invoke set` command once; on Claude Code, use the automatic Skill tool
  record only.
- Read only the matching contract template (`templates/contract-dev.md` or
  `templates/contract-research.md`; plus `templates/mission.md` only for
  multi-session research, and `templates/review-verdict.md` only when planning
  settled a review unit). Read [reports](../../references/reports.md) (`## The
  four questions`, `## Common rules`, `## Approval report`) at step 5.
- Input: the settled material of a planning dialogue (or a hand-written draft).

## Procedure

1. **Write the contract** - `docs/YYYY-MM-DD-<slug>-contract.md`; copy
   `templates/contract-dev.md` or `templates/contract-research.md` and fill its
   slots.
   - **Polarity and slots.** Keep the verbatim polarity sentence:
     "No load-bearing decision absent from this contract proceeds: stop and bring the question."
     Fill required slots (`## Completion conditions`, `## Forbidden rows` with
     write scope first plus default git-hygiene and run-specific rows, `## Budget`
     with INCOMPLETE - RESUME REQUIRED and exact resume instruction) and
     optional slots (`## Settled decisions`, `## Discretion` with tunable
     defaults and values from planning, `## Standing rules`, `## Question handling`).
   - **Machine rows.** Machine rows end with `[machine: write-scope <glob>]`
     (zone-root-relative, unioned) or `[machine: bash-deny <regex>]`; others
     end with `[self-report]`. Every `bash-deny` regex must anchor the command
     token to the start of a shell command segment (`(?:^|[;&|]\s*)`) and the
     subcommand position, and avoid crossing quotes (`[^\n;&|"']*`) so prose in
     `commit -m`, `--evidence`, PR bodies, or heredocs never triggers a
     false-positive denial.
   - **Gray zone.** Use the load-bearing test. Goal-scope collision default: if
     a completion condition forces an edit outside the write scope, discretion
     plus immediate self-report applies - unless a forbidden row is touched
     (always full stop).
   - **Research route.** When routed as **research**, copy
     `templates/contract-research.md`, keep the polarity sentence and
     machine-row grammar, and fill its preregistered claims/criteria (append-only
     `vN`), kill-question, reproducible oracles, positive/negative/partial-exclusion
     completion definitions, stop lines, per-claim budgets, and assumptions;
     `--goal` reports `"promote / hold / reject against criteria vN + evidence
     summary"` (hold closes the pass while the mission stays open). For
     multi-session research, create/update `docs/missions/<slug>.md` from
     `templates/mission.md` (single-pass: `Mission reference: none`; if the
     question moves, close the old mission as moved and cross-link).
2. **Write the plan** - When `planning` marked a small single-unit task for a
   **plan-less (single-file) contract** (no multi-unit split, no parallel
   worktrees, no independent review unit), skip `-plan.md` and go to step 3
   with the contract alone. Otherwise write `docs/YYYY-MM-DD-<slug>-plan.md`
   (revisable guidance; the frozen contract is authority), covered by a
   write-scope row.
   - **Work units.** Under `## Work units`, list one column-0 checkbox row per
     unit in this exact grammar (zone-root-relative `scope=` inside the
     contract's write scope; optional `after=`; `oracle=` to end of tag;
     integration verification last in the main checkout; parallel units get
     disjoint scopes noted in prose), followed by `## Progress log`:
     ```
     - [ ] U1 <title> [unit: U1 scope=<glob>[,<glob>] after=<U#>[,<U#>] oracle=<command>]
     ```
   - **Review unit.** When planning settled an independent review, place one
     review unit right before the integration unit with `after=` naming every
     deliverable unit. Calling the reviewer is the unit's work, not its oracle:
     the reviewer reads the pinned commit, contract, artifacts, and evidence
     read-only and writes `docs/YYYY-MM-DD-<slug>-review.md`
     (`templates/review-verdict.md`). Its oracle checks that the file exists,
     carries `Verdict:`, disposes every `F<n>`, and leaves no open MUST-FIX.
     Record each disposition via `amber:mark` (`finding - F<n> <finding> - <disposition>`);
     re-run affected oracles and re-review after fixes; a disputed MUST-FIX on
     a required condition means not complete. Hold with `external: review by <host>`
     while waiting; `unit verified --evidence` states pass count and elapsed time.
3. **Check.** Required slots present. Every `[machine: ...]` row parses:
   write-scope globs are zone-root-relative, bash-deny regexes compile, one
   machine tag per line. Test every `bash-deny` regex via `node -e` against (a)
   one dangerous command that must match, and (b) one **false-positive negative
   control** where forbidden words appear inside prose/arguments (e.g., `git
   commit -m "..."` or `--evidence "..."`); also verify patterns do not anchor
   on flag order (`\.py\s+submit` misses `script.py --stage a submit`).
   `.amber/` is in `.gitignore`. Any plan file is inside a write-scope row. If
   a completion condition could force writes outside the write scope, widen the
   scope or state the collision default. Report failures to the operator instead
   of silently rewriting intent-bearing content.
4. **Finalize.** Fill `Pin:` (start commit) and `Approval: <operator> YYYY-MM-DD - verification state at approval: <wording>`, then commit the contract (and plan, when present) with no pointer yet.
5. **Report your understanding, then wait for approval.** Read
   [reports](../../references/reports.md) (`## The four questions`, `## Common
   rules`, `## Approval report`) and report what this run is, why it exists,
   how it will be done, what will be true when it ends, what it will not touch,
   and what the operator still decides, written for a reader with no context so
   the operator can judge approval from the report alone. Speak in the
   operator-facing voice and end with `"Shall I go ahead with this scope?"`.
   Show no shell command and open no popup: end the turn and wait.
6. **Read the reply as approval only when it is one.** Judge the reply by
   `protocol.md` ("Approval"): an unconditional yes to the report's question,
   however short, is approval; a reply with a condition, edit, or question is
   not. On approval, in that same turn: append a line to the plan's
   `## Progress log` quoting the utterance with its time (or, for a plan-less
   contract, record the quoted utterance in `## Settled decisions` before
   creating the pointer), then create the schema-v1 pointer in the zone root
   (main checkout or linked worktree):
   `mkdir -p .amber && echo '{"v":1,"boundary":"<contract-file>","ratified_by":"<operator>","ratified_at":"YYYY-MM-DD"}' > .amber/active.json`
   with `ratified_by` from the contract's approval line and `ratified_at` = the
   day of the utterance.
7. **Announce execution.** Tell the operator in one plain line what you start
   with, in the operator-facing voice. When the run has a plan file, seed the
   loop body via `node "<amber_plugin_root>/scripts/record.cjs" unit init <plan-path>`
   in the zone root; for a plan-less single-file contract, skip `unit init` and
   proceed directly to the work and `protocol.md#Completion`.

## Completion

set is done when step 7 completes: the pointer exists, execution is announced,
and the loop body is seeded (when a plan exists). Until an approval utterance
arrives, every set turn ends at step 5 or 6 waiting, with no pointer.
