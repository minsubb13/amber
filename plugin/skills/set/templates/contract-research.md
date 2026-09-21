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

All items required for a successful close.

1. <what the evidence bundle must contain>

## Negative completion (the definition of failure)

All items required for a failed close - failure is a legitimate completion.

1. Every remaining explanation and the experiment that tested it are traceable.
2. The smallest remaining experiment can no longer separate the explanations.
3. Unresolved uncertainty is explicitly attributed outside this pass (hardware, an authority, a new contract).

## Partial progress that never counts as completion

- one passing build or test / one benchmark gain / one rejected hypothesis / <...>

## Stop lines

- the same diagnosis twice = stop
- three correctness failures on one hypothesis = abandon that hypothesis
- <further stop signals>

## Budget

Per claim: time, number of sources, citation depth. On reaching it, dispose that claim as "unresolved" and close the pass (this is not a criteria change).

## Forbidden rows

- Write scope: <target> [machine: write-scope <glob>]
- Research-to-implementation boundary: this pass ends at the verdict - implementation is a separate development contract [self-report]
- <shell block> [machine: bash-deny <regex>]

## Standing rules

- Before the completion signal, give the completion report: what was done and how, in full - show the verdict and its evidence, state which experiments and investigations ran and what verified them, and explain it for a reader with no context. The signal closes the report; it never replaces it [self-report]
- Before the completion signal, semantically re-check the original question, every required condition of this contract, the current verdict artifacts, and the oracle evidence. One condition without evidence, or with failed, unsuitable, or stale evidence, means the pass is not complete. After a change made during that re-check, refresh the affected validation and re-check again [self-report]
- Incomplete, blocked, waiting, and status-only turns run no completion signal. The signal declares the contracted pass itself complete, never that an assessment, report, or attempt finished [self-report]
- The re-check result goes into `record.cjs done --review "<evidence summary>" --goal "<verdict>" --summary "<summary>"` (the last tool call; no marker line in the message). S2 checks only the signal, the pointer, the current contract link, and leftover worktrees; semantic completion is the model's judgment. On a pass the hook removes the pointer and progress.json [hook: S2]
- Numbers and claims carry provenance (verified / quoted / unverified)
- Plan units (investigation rounds, experiments) transition only through `record.cjs unit` (`.amber/progress.json`); a stop while units are open is announced first with `amber:mark hold`. Parallel units run as subagents in worktrees; the main agent re-verifies each with the same oracle and merges last. A leftover worktree means not complete [hook: E1, S2]

## Assumptions

- <assumption> (confidence: high / medium / low; disposition: unverified / verified / rejected) - an accepted claim must not rest on an undisposed load-bearing assumption.

## Carry-over (filled at completion)

- Left behind:
- Waiting (what waits on whose judgment):
- Next action:

The completion signal's target is filled by the command from the current contract file name. `--goal` = "promote / hold / reject against criteria vN + evidence summary". Hold (no conclusion) is a legitimate completion: the pass closes, the mission stays open.
