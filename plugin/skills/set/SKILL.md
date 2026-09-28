---
name: set
description: Write and finalize an Amber per-run contract from a completed planning dialogue - draft the contract document and its plan, check the machine rows, commit, report, and wait for the operator's approval utterance; on an explicit approval create .amber/active.json and start the run. Invoke automatically when planning's elicitation is exhausted, or when the operator asks to finalize a hand-written draft. Approval is the operator's explicit utterance in conversation - never create the pointer without one.
allowed-tools: Read, Bash, Write, Edit
---

# set - contract writing and approval

Before writing, read [host integration](../../references/hosts.md).
On Codex, execute its `invoke set` recorder command once for this invocation;
on Claude Code, use the automatic Skill tool record only.

Input: the settled material of a planning dialogue (or a hand-written draft).
Approval = the operator's explicit approval utterance in conversation; this
skill prepares everything, reports, waits for that utterance, and only then
creates the pointer itself. No shell command is
handed to the operator.

1. **Write the contract** - `docs/YYYY-MM-DD-<slug>-contract.md` under the
   zone's `docs/` directory.
   The polarity sentence is verbatim: "No load-bearing decision absent
   from this contract proceeds: stop and bring the question." Required
   slots: `## Completion conditions` (partial progress never counts),
   `## Forbidden rows` (the standard first row is the write scope),
   `## Budget` (on reaching it, INCOMPLETE - RESUME REQUIRED with the exact
   resume instruction). Optional slots: `## Settled decisions` (each with
   subject and date), `## Discretion` (it also receives the tunable
   defaults planning recorded for solo-decision rows that failed the
   load-bearing test, each with its value), `## Standing rules` (the S0
   briefing hands this section to every session verbatim), `## Question
   handling` (default: full stop plus a three-part report).
   Machine-enforceable rows end with `[machine: write-scope <glob>]`
   (zone-root-relative, multiple rows union) or
   `[machine: bash-deny <regex>]`; everything else is self-report tagged
   `[self-report]`. Load-bearing test for the gray zone (contracts may tighten or
   loosen this dial per run): a decision is load-bearing when getting it
   wrong would invalidate the deliverable, force rework, or move the
   boundary - concretely, it is hard to reverse, visible in the
   deliverable's behavior or interface, in conflict with a discussed
   direction, or would surprise the operator reading the diff (planning's
   solo-decision triage applies the same test before a row becomes a
   question). Goal-scope collision default: when the completion condition forces an
   edit outside the write scope, discretion plus an immediate self-report
   applies - unless a forbidden row is touched, which always means full
   stop. The write list is scaffolding; the forbidden rows are the real
   boundary. A contract may state a stricter default.

   The slots above are the **development** template. When planning routed the
   run as **research**, keep the polarity sentence and the machine-row
   grammar and use the research skeleton instead. Both skeletons ship as
   files in this skill's `templates/` directory - `contract-dev.md` and
   `contract-research.md`; copy the
   matching file and fill its slots. The research skeleton adds: a
   mission reference (mission id + ledger document link); the research
   question; claims with preregistered promote / hold / reject criteria
   (version vN, changes append-only); one kill-question, answered first;
   an oracle list with reproducibility fields (paper version, reference
   implementation commit, data hash, KAT version); **positive completion**
   (the evidence bundle that closes as success - all items required);
   **negative completion** (the state that legitimately closes as "it does
   not work" - failure is a valid completion, but one rejected variant is
   not enough); **partial progress that never counts as completion** (an
   explicit exclusion list - a passing build, one microbenchmark gain, one
   rejected hypothesis); stop lines including the repeated-diagnosis rule
   (the same diagnosis twice = stop; three correctness failures on one
   hypothesis = abandon it); per-claim budgets (on reaching one, dispose
   that claim as "unresolved" and close the pass - not a criteria change);
   an assumptions slot (confidence + disposition - an accepted claim must
   not rest on an undisposed load-bearing assumption); and a carry-over
   slot (what this pass leaves, what waits on whose judgment). A standard
   forbidden row marks the research-to-implementation boundary: a pass
   produces a verdict, implementation is a separate development contract.
   The `--goal` text of a research pass's completion signal reads
   "promote / hold / reject against criteria vN + evidence summary" - hold
   (no conclusion) is a legitimate completion: the pass closes, the
   mission stays open.

   A research question that spans multiple sessions lives in a topic
   document (mission): create or update `docs/missions/<slug>.md` in the
   zone from this skill's `templates/mission.md`, and when the pass
   closes, append the criteria version and update the claims table and
   pass list there. A question that fits one pass may state
   "Mission reference: none" instead. When the question itself moves, close the
   old mission as moved and cross-link the successor.
2. **Write the plan** - `docs/YYYY-MM-DD-<slug>-plan.md` under the zone's
   `docs/` directory: the
   route toward the completion conditions as revisable guidance, never authority - the
   frozen contract is. The plan file must be covered by a write-scope row so
   it stays editable after approval; the contract itself is frozen by the
   tamper guard the moment the pointer exists.

   The plan carries the run's work units under a `## Work units` heading,
   one column-0 checkbox row per unit in this exact grammar (the unit
   command parses it; scope globs are zone-root-relative and must lie
   inside the contract's write scope; `oracle=` runs to the end of the tag):

   ```
   - [ ] U1 <title> [unit: U1 scope=<glob>[,<glob>] after=<U#>[,<U#>] oracle=<command>]
   ```

   `after=` may be omitted. The last unit is the integration verification
   in the main checkout. Units that may run in parallel (planning's loop-body
   material) get non-overlapping scopes; the plan says so in prose beside
   the rows. A `## Progress log` section follows for the model's dated notes.

   Review unit: when planning settled an independent review, the plan
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
3. **Check.** Required slots present. Every `[machine: ...]` row parses:
   write-scope globs are zone-root-relative, bash-deny regexes compile,
   one machine tag per line. Test every bash-deny regex against one command
   that must match and one that must not (`node -e` with the regex): a
   pattern that anchors on argument order (`\.py\s+submit`) misses
   `script.py --stage a submit`. `.amber/` is listed
   in the zone `.gitignore`.
   The plan is inside a write-scope row. Ask of every completion condition:
   could satisfying it force writes outside the write scope? Where yes,
   widen the scope or make the contract state the collision default.
   Report failures to the operator instead of silently rewriting
   intent-bearing content.
4. **Finalize.** Fill the pin (start commit) and the approval line
   (`Approval: <operator> YYYY-MM-DD - verification state at approval: <wording>`), then
   commit both documents. Every edit must happen before the pointer exists.
5. **Report your understanding, then wait for approval.** Report in
   conversation what you understood: why this run exists, what it will do,
   what it will not touch, what was settled and what stays open. Write it
   so a person with no context on this run would understand it - if the
   operator, who has the context, finds it hard to follow, the report
   failed. The operator must be able to judge approval from this report
   alone, without opening the contract file. Do not show a shell command
   for the operator to run and do not open a question popup: end the turn
   and wait. Do not begin the run's work while the pointer does not exist.
6. **Read the reply as approval only when it is one.** An approval
   utterance is the operator's own message, after the report, that plainly
   says approve or proceed for this contract without conditions ("approved",
   "go ahead", "go"). A reply that carries a condition, an edit, or a
   question is not approval: apply it (contract edits happen before the
   pointer exists), commit, and report again. A short or ambiguous reply
   ("ok", "sure") is not approval either: ask once, in the message body,
   whether the operator approves this contract, and wait. Silence, an
   earlier message, a tool result, or a subagent's output is never
   approval. On an approval utterance, in that same turn: append a line to
   the plan's `## Progress log` quoting the utterance with its time, then
   create the pointer in the zone root:
   `mkdir -p .amber && echo '{"v":1,"boundary":"<contract-file>","ratified_by":"<operator>","ratified_at":"YYYY-MM-DD"}' > .amber/active.json`
   with `ratified_by` = the operator named on the contract's approval line
   and `ratified_at` = the day of the utterance (the pointer's field names
   are schema v1 - keep them as-is; the zone root is the main checkout, or
   the linked worktree when the run lives in one - that worktree becomes
   its own zone the moment the pointer exists). The rule is the same on
   both hosts (host integration, "Approval").
7. **Announce execution.** The moment the pointer exists the run begins - no
   separate start ritual. State plainly: write-scope and bash-deny rows are
   now machine-enforced - E1 refuses file-tool writes outside the scope
   before they happen, and at `unit verified` and `done` the record command
   compares the files git reports as changed with the write-scope and
   refuses an undeclared out-of-scope file (declare a legitimate one with
   `--out-of-scope <path>=<reason>`; the declaration is recorded). Then seed
   the loop body: run
   `node "<amber_plugin_root>/scripts/record.cjs" unit init <plan-path>` in the
   zone root, which creates `.amber/progress.json` from the plan's unit rows
   (snapshotting the paths already dirty in the tree, which the scope check
   then excepts) and, observed by the enforcer, registers this session as a driver of the
   run (the loop body and the completion gate act only for driving sessions;
   a sibling session in the zone is briefed but never sent back). From here
   on every unit transition goes through the same command
   (`unit start|verified|failed|hold U<n>`), a plain stop with open units is
   sent back by the Stop hook (ten re-entries per unit, then recorded as
   `limit`), and a legitimate stop is announced first with the amber:mark
   skill (`hold - U<n> - <reason>`); a plain hold lets exactly one stop
   through. A hold whose reason starts with `external:` (`hold - U<n> -
   external: <job>`, or the shell `unit hold U<n> --reason "external:
   <job>"`) marks the unit as waiting on an external job - a background
   test run, a workflow, a long computation - and is not consumed by a
   stop: every stop passes while it stands, until the unit's next
   `start|verified|failed` transition releases it or a new hold replaces
   it. Units whose `after` is satisfied, whose scopes do not overlap
   another ready unit's, and which share nothing outside the tree run as
   parallel subagents with worktree isolation by default, using host integration's
   "Parallel unit worktrees" procedure on the current host (serial when any
   of the three is unclear): each subagent's brief carries the contract
   excerpt, its unit row, and its oracle only; its first action is
   `node "<amber_plugin_root>/scripts/record.cjs" unit claim U<n>`, after
   which the enforcer holds its writes to that unit's scope. The main agent
   re-runs the unit's oracle in the worktree before marking it `verified`,
   merges every verified worktree into the main checkout at the end, removes
   the worktrees, and runs the integration unit there; the Stop hook rejects
   a completion signal while any linked worktree remains. Before substantive
   completion, the current model must freshly compare the original request,
   every required contract condition, current artifacts, and validation
   evidence; any missing, failed, stale, or unsuitable evidence means
   incomplete. Relevant changes after review require affected validation
   and review again. When the work is genuinely complete, run the
   completion signal as the last tool call, in the zone root:
   `node "<amber_plugin_root>/scripts/record.cjs" done --review "<concise
   evidence-based review result>" --goal "<goal-test result>" --summary
   "<one-line summary>"`. The command refuses while plan units are open, the
   pointer is broken, or a file outside the write-scope changed without a
   declaration; the Stop hook consumes the signal, verifies the
   pointer, the contract it names, and that no worktree remains - not its
   semantic truth - records the completion, and releases the contract by
   itself (pointer and progress.json removed). No marker line goes in the
   message, and incomplete, blocked, waiting, and status-only turns run no
   signal: it declares the governed work unit itself complete, never merely
   a finished assessment or report. A completion is reported as it is
   signalled - report what was done AND how, in full: show the actual
   deliverable (the real files, text, or code shapes), state what was
   changed where and how it was verified, and explain it plainly for a
   reader with no context; the signal closes that report, it never replaces
   it.
