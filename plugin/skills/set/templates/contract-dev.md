# Contract - <run name> (YYYY-MM-DD)

No load-bearing decision absent from this contract proceeds: stop and bring the question.

Pin: start commit <sha>
Approval: <operator> YYYY-MM-DD - verification state at approval: <wording>

## Completion conditions

All conditions must hold. Partial progress is not completion.

1. <the deliverable and its required content>
2. <...>
3. <independent review, when planning settled one: `docs/YYYY-MM-DD-<slug>-review.md` by <reviewer named here>, no MUST-FIX open, every finding disposed - applied and re-reviewed, rejected with a reason, or brought to the operator>

Verification (oracles): <what confirms each condition - tests, grep, format checks, operator judgment>; <the review verdict file for condition 3>

Not answered: <what this run does not cover>

## Forbidden rows

- Write scope: <target> [machine: write-scope <glob>]
- <self-reported boundary> [self-report]
- <shell block> [machine: bash-deny <regex>]

## Budget

<budget>. On reaching it: INCOMPLETE - RESUME REQUIRED (resume: <exact resume instruction>).

## Settled decisions

- <decision> (<who> YYYY-MM-DD)

## Discretion

<what the model may settle alone - the tunable defaults planning recorded, each with its value>

## Standing rules

- Before the completion signal, give the completion report: what was done and how, in full - show the actual deliverable, state what changed where and what verified it, and explain it for a reader with no context. The signal closes the report; it never replaces it [self-report]
- Before the completion signal, semantically re-check the original request, every required condition of this contract, the current artifacts, and the validation evidence. One condition without evidence, or with failed, unsuitable, or stale evidence, means the work is not complete. After a change made during that re-check, refresh the affected validation and re-check again [self-report]
- Incomplete, blocked, waiting, and status-only turns run no completion signal. The signal declares the contracted work unit itself complete, never that an assessment, report, or attempt finished [self-report]
- The re-check result goes into `record.cjs done --review "<evidence summary>" --goal "<goal-test result>" --summary "<summary>"` (the last tool call; no marker line in the message). S2 checks only the signal, the pointer, the current contract link, and leftover worktrees; semantic completion is the model's judgment. On a pass the hook removes the pointer and progress.json [hook: S2]
- Numbers and claims carry provenance (verified / quoted / unverified)
- Independent review (when the plan carries a review unit): the reviewer reads the pinned commit, this contract, the artifacts, and the evidence itself, read-only; the author's summary is not authority. A finding names the condition it violates and its evidence. The reviewer's PASS replaces no operator gate, and a MUST-FIX disputed on a required condition means not complete [self-report]
- Plan units transition only through `record.cjs unit` (`.amber/progress.json`); a stop while units are open is announced first with `amber:mark hold`. Parallel units run as subagents in worktrees; the main agent re-verifies each with the same oracle and merges last. A leftover worktree means not complete [hook: E1, S2]

## Question handling

Default: on a discovery outside the contract, full stop plus report.

## Carry-over (filled at completion)

- Left behind:
- Waiting (what waits on whose judgment):
- Next action:
