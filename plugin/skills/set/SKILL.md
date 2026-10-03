---
name: set
description: Write and finalize an Amber per-run contract from a completed planning dialogue - draft the contract document and its plan, check the machine rows, commit, report, and wait for the operator's approval utterance; on an explicit approval create .amber/active.json and start the run. Invoke automatically when planning's elicitation is exhausted, or when the operator asks to finalize a hand-written draft. Approval is the operator's explicit utterance in conversation - never create the pointer without one.
allowed-tools: Read, Bash, Write, Edit
---

# set - contract writing and approval

set turns the settled material of a planning dialogue into two documents - a
contract that freezes the boundary and a plan that stays revisable - reports
its understanding, waits for the operator's approval utterance (run
protocol, "Approval"), and only then creates the pointer itself.

## Principles

- Every edit must happen before the pointer exists; from then on the tamper
  guard freezes the contract, while the plan stays editable.
- The write list is scaffolding; the forbidden rows are the real boundary.

## Input and preconditions

- Before writing, read [host integration](../../references/hosts.md) and the
  [run protocol](../../references/protocol.md). On Codex, execute its
  `invoke set` recorder command once for this invocation; on Claude Code,
  use the automatic Skill tool record only.
- Input: the settled material of a planning dialogue (or a hand-written
  draft).

## Procedure

1. **Write the contract** - `docs/YYYY-MM-DD-<slug>-contract.md` under the
   zone's `docs/` directory. Both skeletons ship as files in this skill's
   `templates/` directory - `contract-dev.md` and `contract-research.md`;
   copy the matching file and fill its slots.
   - **Polarity and slots.** The polarity sentence is verbatim: "No
     load-bearing decision absent from this contract proceeds: stop and
     bring the question." Required slots: `## Completion conditions`
     (partial progress never counts), `## Forbidden rows` (the standard
     first row is the write scope), `## Budget` (on reaching it,
     INCOMPLETE - RESUME REQUIRED with the exact resume instruction).
     Optional slots: `## Settled decisions` (each with subject and date),
     `## Discretion` (it also receives the tunable defaults planning
     recorded for solo-decision rows that failed the load-bearing test,
     each with its value), `## Standing rules` (the S0 briefing hands this
     section to every session verbatim), `## Question handling` (default:
     full stop plus a three-part report).
   - **Machine rows.** Machine-enforceable rows end with
     `[machine: write-scope <glob>]` (zone-root-relative, multiple rows
     union) or `[machine: bash-deny <regex>]`; everything else is
     self-report tagged `[self-report]`.
   - **Gray zone.** Decide the gray zone with the run protocol's
     load-bearing test (contracts may tighten or loosen this dial per run).
     Goal-scope collision default: when the completion condition forces an
     edit outside the write scope, discretion plus an immediate self-report
     applies - unless a forbidden row is touched, which always means full
     stop. A contract may state a stricter default.
   - **Research route.** The slots above are the **development** template.
     When planning routed the run as **research**, keep the polarity
     sentence and the machine-row grammar and use the research skeleton
     instead. It adds: a mission reference (mission id + ledger document
     link); the research question; claims with preregistered promote /
     hold / reject criteria (version vN, changes append-only); one
     kill-question, answered first; an oracle list with reproducibility
     fields (paper version, reference implementation commit, data hash, KAT
     version); **positive completion** (the evidence bundle that closes as
     success - all items required); **negative completion** (the state that
     legitimately closes as "it does not work" - failure is a valid
     completion, but one rejected variant is not enough); **partial
     progress that never counts as completion** (an explicit exclusion
     list - a passing build, one microbenchmark gain, one rejected
     hypothesis); stop lines including the repeated-diagnosis rule (the
     same diagnosis twice = stop; three correctness failures on one
     hypothesis = abandon it); per-claim budgets (on reaching one, dispose
     that claim as "unresolved" and close the pass - not a criteria
     change); an assumptions slot (confidence + disposition - an accepted
     claim must not rest on an undisposed load-bearing assumption); and a
     carry-over slot (what this pass leaves, what waits on whose judgment).
     A standard forbidden row marks the research-to-implementation
     boundary: a pass produces a verdict, implementation is a separate
     development contract. The `--goal` text of a research pass's
     completion signal reads "promote / hold / reject against criteria vN +
     evidence summary" - hold (no conclusion) is a legitimate completion:
     the pass closes, the mission stays open.
   - **Mission.** A research question that spans multiple sessions lives in
     a topic document (mission): create or update `docs/missions/<slug>.md`
     in the zone from this skill's `templates/mission.md`, and when the pass
     closes, append the criteria version and update the claims table and
     pass list there. A question that fits one pass may state "Mission
     reference: none" instead. When the question itself moves, close the
     old mission as moved and cross-link the successor.

   Exit: the contract file exists, copied from the matching template, with
   the verbatim polarity sentence and every required slot filled.
2. **Write the plan** - `docs/YYYY-MM-DD-<slug>-plan.md` under the zone's
   `docs/` directory: the route toward the completion conditions as
   revisable guidance, never authority - the frozen contract is. The plan
   file must be covered by a write-scope row so it stays editable after
   approval.
   - **Work units.** The plan carries the run's work units under a
     `## Work units` heading, one column-0 checkbox row per unit in this
     exact grammar (the unit command parses it; scope globs are
     zone-root-relative and must lie inside the contract's write scope;
     `oracle=` runs to the end of the tag):

     ```
     - [ ] U1 <title> [unit: U1 scope=<glob>[,<glob>] after=<U#>[,<U#>] oracle=<command>]
     ```

     `after=` may be omitted. The last unit is the integration verification
     in the main checkout. Units that may run in parallel (planning's
     loop-body material) get non-overlapping scopes; the plan says so in
     prose beside the rows. A `## Progress log` section follows for the
     model's dated notes.
   - **Review unit.** When planning settled an independent review, the plan
     carries one review unit right before the integration unit, with
     `after=` naming every deliverable unit. Calling the reviewer is that
     unit's work, not its oracle - oracles are re-run, a model review is not
     repeatable. The reviewer named in the contract reads the pinned commit,
     the contract, the artifacts, and the evidence itself, read-only, and
     its verdict is saved as `docs/YYYY-MM-DD-<slug>-review.md` in the shape
     of this skill's `templates/review-verdict.md`. The unit's oracle checks
     that file: it exists, carries a `Verdict:` line, every `F<n>` has a
     disposition, and no MUST-FIX is open. Record each disposition with the
     amber:mark skill (`finding - F<n> <finding> - <disposition>`); a fix
     re-runs the affected oracles and is re-reviewed; a MUST-FIX that stays
     disputed on a required condition means not complete - bring it to the
     operator. While the reviewer runs on another host, hold the unit with
     `external: review by <host>`. The review unit's `unit verified
     --evidence` states the number of review passes and the elapsed time.

   Exit: the plan file exists inside a write-scope row, with one unit row
   per unit in the grammar above, the integration unit last, and a
   `## Progress log` section.
3. **Check.** Required slots present. Every `[machine: ...]` row parses:
   write-scope globs are zone-root-relative, bash-deny regexes compile, one
   machine tag per line. Test every bash-deny regex against one command
   that must match and one that must not (`node -e` with the regex): a
   pattern that anchors on argument order (`\.py\s+submit`) misses
   `script.py --stage a submit`. `.amber/` is listed in the zone
   `.gitignore`. The plan is inside a write-scope row. Ask of every
   completion condition: could satisfying it force writes outside the write
   scope? Where yes, widen the scope or make the contract state the
   collision default.
   Report failures to the operator instead of silently rewriting
   intent-bearing content.

   Exit: every check above passes.
4. **Finalize.** Fill the pin (start commit) and the approval line
   (`Approval: <operator> YYYY-MM-DD - verification state at approval: <wording>`),
   then commit both documents.

   Exit: both documents are committed and no pointer exists.
5. **Report your understanding, then wait for approval.** Report in
   conversation what you understood: why this run exists, what it will do,
   what it will not touch, what was settled and what stays open. Write it
   so a person with no context on this run would understand it - if the
   operator, who has the context, finds it hard to follow, the report
   failed. The operator must be able to judge approval from this report
   alone, without opening the contract file. Speak in the run protocol's
   operator-facing voice and end the report with one plain go-ahead
   question ("Shall I go ahead with this scope?"). Do not show a shell
   command for the operator to run and do not open a question popup: end
   the turn and wait. Do not begin the run's work while the pointer does not
   exist.

   Exit: the report is in the conversation and the turn has ended.
6. **Read the reply as approval only when it is one.** Judge the operator's
   reply by the run protocol's "Approval": an unconditional yes to the
   report's question, however short, is approval; a reply that carries a
   condition, an edit, or a question is not.
   On an approval utterance, in that same turn: append a line to the
   plan's `## Progress log` quoting the utterance with its time, then
   create the pointer in the zone root:
   `mkdir -p .amber && echo '{"v":1,"boundary":"<contract-file>","ratified_by":"<operator>","ratified_at":"YYYY-MM-DD"}' > .amber/active.json`
   with `ratified_by` = the operator named on the contract's approval line
   and `ratified_at` = the day of the utterance (the pointer's field names
   are schema v1 - keep them as-is; the zone root is the main checkout, or
   the linked worktree when the run lives in one - a linked worktree
   outside the zone directory is a zone of its own already, and the
   pointer now names its contract).

   Exit: the progress log quotes the approval utterance and
   `.amber/active.json` names this contract.
7. **Announce execution.** The moment the pointer exists the run begins - no
   separate start ritual. Tell the operator in one plain line what you start
   with, in the operator-facing voice - nothing about the machinery. For
   your own orientation: the write-scope and bash-deny rows are now
   machine-enforced - E1 refuses file-tool writes outside the scope
   before they happen, and at `unit verified` and `done` the record command
   compares the files git reports as changed with the write-scope and
   refuses an undeclared out-of-scope file (declare a legitimate one with
   `--out-of-scope <path>=<reason>`; the declaration is recorded). Then seed
   the loop body: run
   `node "<amber_plugin_root>/scripts/record.cjs" unit init <plan-path>` in
   the zone root, which creates `.amber/progress.json` from the plan's unit
   rows (snapshotting the paths already dirty in the tree, which the scope
   check then excepts) and, observed by the enforcer, registers this session
   as a driver of the run (the loop body and the completion gate act only
   for driving sessions; a sibling session in the zone is briefed but never
   sent back). From here on the run follows the run protocol's "Loop body"
   and "Completion".

   Exit: `.amber/progress.json` lists the plan's units and this session
   drives the run.

## Completion

set is done when step 7's exit holds: the pointer exists, the execution
announcement is made, and the loop body is seeded. Until an approval
utterance arrives, every set turn ends at step 5 or 6 waiting, with no
pointer. The run itself completes under the run protocol's "Completion".
