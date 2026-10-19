# protocol.md - shared run rules

Read only the sections needed for the current step (host command shapes in [host integration](hosts.md)):
- `planning` reads `## Load-bearing test` and `## Operator-facing voice`; `set` adds `## Approval`.
- Execution reads `## Loop body` and `## Completion` (single-unit runs without a separate plan file skip `## Loop body` and go straight from pointer creation to work and `## Completion`).

## Load-bearing test

A decision is load-bearing when getting it wrong would invalidate the deliverable,
force rework, or move the boundary: hard to reverse, visible in behavior or
interface, in conflict with a discussed direction, or surprising to the operator
reading the diff. Contracts may tighten or loosen this dial per run. `planning`
applies it in solo-decision triage before a row becomes a question; `set` applies
it to the contract's gray zone.

## Approval

The operator approves a contract in conversation after `set`'s report (same rule on both hosts):
- **The question.** End the approval report ([reports](reports.md)) with one plain
  go-ahead question in the operator's language ("Shall I go ahead with this scope?")
  - no shell command, popup, or second confirmation.
- **Unconditional yes -> approved.** Any unconditional yes ("yes", "ok", "go",
  "네", "좋아"), including one adding info without a condition ("yes - I'll merge
  #5 first"), counts as approval.
- **Condition, edit, or question -> not approved.** Apply the change before the
  pointer exists, commit, and report again ending with the question. If a report
  omitted the question and the reply is ambiguous, ask once in one plain line and
  wait. Silence, an earlier message, a tool result, or subagent output is never approval.
- **Approval boundary.** Only after an approval utterance in the operator's own
  message, the model creates `.amber/active.json` in the zone root (`set` step 6).
  Never hand a pointer command to the operator; a passed completion removes the
  pointer automatically.

## Operator-facing voice

Speak to the operator about the work, never the harness:
- **Omit internal terms.** Never name Amber or its coined terms (`contract`,
  `pointer`, `write-scope`, `bash-deny`, `unit`, `signal`, `hook`, `ledger`,
  `cycle`, `planning`, `set`, `done`) or paraphrase internal logic.
- **No transition narration.** Say nothing between operator beats (a question,
  the go-ahead, a blocker, the result).
- **Refer to the scope by content.** Name what it says (scope, what stays
  untouched, how work is verified) and cite its path only when needed to open.

## Loop body

When a run uses a plan file, every unit transition from `unit init` on goes through
`unit start|verified|failed|hold U<n>` ([host integration](hosts.md), "Loop-body unit commands"):
- **Plain stop with open units -> sent back.** The Stop hook sends the session
  back up to 10 re-entries per unit, then records `limit`.
- **Legitimate stop -> `hold`.** Announce first with `amber:mark`
  (`hold - U<n> - <reason>`: operator wait, budget reached, out-of-contract
  decision). Passes one stop; the Stop hook resumes sending you back afterwards.
- **Waiting on an external job -> `external:` hold.** Record
  `hold - U<n> - external: <job>` (or `unit hold U<n> --reason "external: <job>"`).
  Every stop passes with no cap until the unit's next `start|verified|failed`
  transition or a new hold replaces it (`external hold on U<n> since <ts>: <text>`).
- **Independent ready units -> parallel subagent worktrees.** Units whose `after`
  is satisfied, whose scopes do not overlap another ready unit's, and which share
  nothing outside the tree (ports, databases, GPUs, global ledger) run in parallel
  worktrees ([host integration](hosts.md), "Parallel unit worktrees"); if any of
  the three is unclear, run serially. Pass each subagent only the contract excerpt,
  its unit row, and its oracle; its first action is
  `node "<amber_plugin_root>/scripts/record.cjs" unit claim U<n>`.
- **Verify and merge in main agent.** Whichever worker did the unit, the main
  agent re-runs the oracle itself in the tree where the work landed and records
  `unit verified --evidence` (non-empty `--evidence` required), then merges
  verified worktrees into the main checkout,
  removes them, and runs the integration unit there. The Stop hook rejects
  completion while any unit worktree (linked worktree inside the zone directory)
  remains; linked worktrees outside the zone directory are separate zones and not waited for.

## Completion

- **Review first.** Freshly compare the original request, every required contract
  condition, current artifacts, and validation evidence; missing, failed, stale,
  or unsuitable evidence means incomplete. Re-validate and re-review if work
  changes after review.
- **Signal last.** When genuinely complete, run the completion signal as the last
  tool call in the zone root ([host integration](hosts.md), "Completion signal"),
  with `--goal "<goal-test result>"` under an active contract. The Stop hook checks
  the pointer, contract match, and that no unit worktree remains, records
  completion, and removes `.amber/active.json` and `.amber/progress.json`.
- **Only real completions.** Put no marker line in the message; incomplete,
  blocked, waiting, and status-only turns run no signal.
- **Report in full.** Close with the completion report ([reports](reports.md)):
  show the actual deliverable, what changed where, and how it was verified,
  explained plainly for a reader with no context.
