# Research contract - <pass name> (YYYY-MM-DD)

No load-bearing decision absent from this contract proceeds: stop and bring the question.

Pin: start commit <sha>
Approval: <operator> YYYY-MM-DD - verification state at approval: <wording>
Mission reference: <mission id + topic document link, or "none" for a single pass>

## Research question
<one paragraph: the question this pass answers>

## Claims and verdict criteria (criteria version vN - changes are append-only)

| Claim | Promote when | Hold when | Reject when | Learn / defer |
|---|---|---|---|---|
| <claim> | <preregistered threshold> | <...> | <...> | learn / defer to oracle / unresolved |

## Kill-question
<the one question that would overturn this pass's conclusion - answer it first>

## Oracles
- <verification means> (reproducibility: paper version / reference implementation commit / data hash / KAT version)

## Positive completion (the definition of success)
All items required for a successful close:
1. <what the evidence bundle must contain>

## Negative completion (the definition of failure)
All items required for a failed close - failure is a legitimate completion:
1. Every remaining explanation and the experiment that tested it are traceable.
2. The smallest remaining experiment can no longer separate the explanations.
3. Unresolved uncertainty is explicitly attributed outside this pass (hardware, an authority, a new contract).

## Partial progress that never counts as completion
- one passing build or test / one benchmark gain / one rejected hypothesis / <...>

## Stop lines
- the same diagnosis twice = stop
- three correctness failures on one hypothesis = abandon that hypothesis
- <further stop signals>
- every stop brings the operator a stop report (`references/reports.md`)

## Budget
Per claim: time, number of sources, citation depth. On reaching it, dispose that claim as "unresolved" and close the pass (not a criteria change).

## Forbidden rows

- Write scope: <target> [machine: write-scope <glob>]
- Research-to-implementation boundary: this pass ends at the verdict - implementation is a separate development contract [self-report]
- Do not force-push or push to main/release [machine: bash-deny (?:^|[;&|]\s*)(?:cd\s+\S+\s*(?:&&|;)\s*)?git(?:\s+-[Cc]\s+\S+|\s+--\S+)*\s+push\b[^\n;&|"']*(?:--force\b|--force-with-lease\b|-f\b|--mirror\b|--delete\b|\s\+[a-zA-Z0-9_/-]|\b(?:HEAD:)?(?:refs/heads/)?(?:main|release)\b)]
- Do not rewrite history or hard-reset [machine: bash-deny (?:^|[;&|]\s*)(?:cd\s+\S+\s*(?:&&|;)\s*)?git(?:\s+-[Cc]\s+\S+|\s+--\S+)*\s+(?:commit\b[^\n;&|"']*--amend\b|rebase\b|filter-branch\b|filter-repo\b|reset\b[^\n;&|"']*--hard\b)]
- Specify files explicitly when staging or committing [machine: bash-deny (?:^|[;&|]\s*)(?:cd\s+\S+\s*(?:&&|;)\s*)?git(?:\s+-[Cc]\s+\S+|\s+--\S+)*\s+(?:commit|add)\b[^\n;&|"']*\s(?:-[aA]\b|-am\b|--all\b)]

## Standing rules

- End the run with the completion report (`references/reports.md`) once after the completion signal: show the verdict and its evidence, state which experiments/investigations ran and what verified them, and explain it for a reader with no context. The signal never replaces the report [self-report]
- Before the signal, semantically re-check the original question, every required condition, current verdict artifacts, and oracle evidence. Missing, failed, unsuitable, or stale evidence means the pass is not complete; after any edit during re-check, re-validate and re-check [self-report]
- Incomplete, blocked, waiting, and status-only turns run no completion signal; the signal declares the contracted pass itself complete, never an assessment, report, or attempt [self-report]
- Pass the re-check to `record.cjs done --review "<evidence summary>" --goal "<verdict>" --summary "<summary>"` (last tool call; no marker line in the message). On pass, S2 removes the pointer and `progress.json` [hook: S2]
- Numbers and claims carry provenance (verified / quoted / unverified)
- Plan units (investigation rounds, experiments) transition only via `record.cjs unit` (`.amber/progress.json`); announce any stop with open units via `amber:mark hold`. Parallel units use subagent worktrees; the main agent re-runs each oracle itself, records `unit verified --evidence`, and merges last (leftover worktree = not complete) [hook: E1, S2]

## Assumptions
- <assumption> (confidence: high / medium / low; disposition: unverified / verified / rejected) - an accepted claim must not rest on an undisposed load-bearing assumption.

## Carry-over (filled at completion)
- Left behind:
- Waiting (what waits on whose judgment):
- Next action:

`--goal` = "promote / hold / reject against criteria vN + evidence summary". Hold (no conclusion) is a legitimate completion: the pass closes, the mission stays open.
