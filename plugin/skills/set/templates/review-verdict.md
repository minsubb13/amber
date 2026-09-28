# Review - <run name> (YYYY-MM-DD)

Reviewer: <host and model>, read-only, fresh context, started <YYYY-MM-DD HH:MM>
Reviewed commit: <full sha> (<zone>)[; code commits <sha>, <sha>]
Contract: <docs/YYYY-MM-DD-<slug>-contract.md> - Plan: <docs/YYYY-MM-DD-<slug>-plan.md>
Scope: <what the reviewer read and ran - files, documents, commands - and nothing else>

Verdict: PASS | PASS WITH FIXES | FAIL

FAIL = at least one MUST-FIX. PASS WITH FIXES = no MUST-FIX, at least one
SHOULD-FIX. PASS = nothing above NOTE. The verdict is the reviewer's; the
author never edits it - a re-review appends a new verdict line with its date.

## Findings

Only findings tied to a contract condition, each with the evidence that
shows the problem (file:line, command output). A finding without evidence
is a NOTE. Style, naming, and improvements outside the contract are not
findings; the reviewer may list them under NOTE and they never block.

- [MUST-FIX] F1 <claim> - <evidence file:line> - violates condition <n>
- [SHOULD-FIX] F2 <claim> - <evidence> - condition <n>
- [NOTE] F3 <observation> - <evidence>

## Condition check

| Contract condition | Status | Reason |
| --- | --- | --- |
| 1. <condition> | met / partly met / not met | <what the reviewer read that shows it> |

## Dispositions

Filled by the author after the review, one row per finding. A MUST-FIX is
disposed only by a fix the reviewer re-checked, or by the operator's
explicit acceptance of the residual; a disputed MUST-FIX on a required
condition means the run is not complete.

- F1: applied in <commit> - re-checked <PASS/FAIL> by <reviewer> on <date>
- F2: rejected - <reason tied to the contract>
- F3: unresolved - brought to the operator: <question>

## What this review did not check

<static review limits: not run, not built, not measured, hosts not accessed>
