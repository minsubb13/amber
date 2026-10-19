# Contract - <run name> (YYYY-MM-DD)

No load-bearing decision absent from this contract proceeds: stop and bring the question.

Pin: start commit <sha>
Approval: <operator> YYYY-MM-DD - verification state at approval: <wording>

## Completion conditions

All conditions must hold. Partial progress is not completion.

1. <the deliverable and its required content>
2. <independent review, when planning settled one: `docs/YYYY-MM-DD-<slug>-review.md` by <reviewer named here>, no MUST-FIX open, every finding disposed - applied and re-reviewed, rejected with a reason, or brought to the operator>

Verification (oracles): <what confirms each condition - tests, grep, format checks, operator judgment>; <the review verdict file when applicable>
Not answered: <what this run does not cover>

## Forbidden rows

- Write scope: <target> [machine: write-scope <glob>]
- <self-reported boundary> [self-report]
- Do not force-push or push to main/release [machine: bash-deny (?:^|[;&|]\s*)(?:cd\s+\S+\s*(?:&&|;)\s*)?git(?:\s+-[Cc]\s+\S+|\s+--\S+)*\s+push\b[^\n;&|"']*(?:--force\b|--force-with-lease\b|-f\b|--mirror\b|--delete\b|\s\+[a-zA-Z0-9_/-]|\b(?:HEAD:)?(?:refs/heads/)?(?:main|release)\b)]
- Do not rewrite history or hard-reset [machine: bash-deny (?:^|[;&|]\s*)(?:cd\s+\S+\s*(?:&&|;)\s*)?git(?:\s+-[Cc]\s+\S+|\s+--\S+)*\s+(?:commit\b[^\n;&|"']*--amend\b|rebase\b|filter-branch\b|filter-repo\b|reset\b[^\n;&|"']*--hard\b)]
- Specify files explicitly when staging or committing [machine: bash-deny (?:^|[;&|]\s*)(?:cd\s+\S+\s*(?:&&|;)\s*)?git(?:\s+-[Cc]\s+\S+|\s+--\S+)*\s+(?:commit|add)\b[^\n;&|"']*\s(?:-[aA]\b|-am\b|--all\b)]

## Budget
<budget>. On reaching it: INCOMPLETE - RESUME REQUIRED (resume: <exact resume instruction>).

## Settled decisions
- <decision> (<who> YYYY-MM-DD)

## Discretion
<what the model may settle alone - tunable defaults planning recorded, each with its value>

## Standing rules

- End the run with the completion report (`references/reports.md`) once after the completion signal: show the deliverable, state what changed where and what verified it, and explain it for a reader with no context. The signal never replaces the report [self-report]
- Before the signal, semantically re-check the request, every required condition, current artifacts, and validation evidence. Missing, failed, unsuitable, or stale evidence means not complete; after any edit during re-check, re-validate and re-check [self-report]
- Incomplete, blocked, waiting, and status-only turns run no completion signal; the signal declares the contracted work itself complete, never an assessment, report, or attempt [self-report]
- Pass the re-check to `record.cjs done --review "<evidence summary>" --goal "<goal-test result>" --summary "<summary>"` (last tool call; no marker line in the message). On pass, S2 removes the pointer and `progress.json` [hook: S2]
- Numbers and claims carry provenance (verified / quoted / unverified)
- Independent review (when planned): the reviewer reads the pinned commit, contract, artifacts, and evidence read-only (author summary is not authority). Findings cite the violated condition and evidence; a disputed MUST-FIX on a required condition means not complete [self-report]
- Plan units (when a plan exists) transition only via `record.cjs unit` (`.amber/progress.json`); announce any stop with open units via `amber:mark hold`. Parallel units use subagent worktrees; the main agent re-runs each oracle itself, records `unit verified --evidence`, and merges last (leftover worktree = not complete) [hook: E1, S2]

## Question handling
Default: on a discovery outside the contract, full stop plus a stop report (`references/reports.md`).

## Carry-over (filled at completion)
- Left behind:
- Waiting (what waits on whose judgment):
- Next action:
