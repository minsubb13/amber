# Amber audit <n> (<YYYY-MM-DD>)

Helper: `<amber_plugin_root>/scripts/audit.cjs` (read-only). Every number in this document is its output and is reproduced by `check-summary`. The verdict column is the operator's to fill.

## Purpose and scope

<one sentence: from the operator's own records, list the Amber mechanisms that never fire, spin without effect, or are missing, each with evidence, as candidates. The excluded projects (<list | none>), the `period_end`, and how the samples were chosen (named by the operator | the newest sessions with a completion, at most 5)>

| Session | Zone | What |
|---|---|---|
| <id prefix> | <project> | <completed contract and time, host, transcript present or not> |

Transcript bodies are never quoted. An event is its kind, time, and line number only.

## Ledger counts

Output of `audit.cjs summary` (`check-summary` recomputes and compares it):

```
period_end=<ISO>
excluded_projects=<list|none>
<the rest of the summary output verbatim>
```

<two or three sentences on how to read it: field rows, completed contracts, planning versus set, attribution of unit events>

## Dead mechanisms

Output of `audit.cjs dead`:

```
<the mechanism | field_count | status rows verbatim>
```

<a short reading of the zero-count mechanisms: no opportunity / bypassed / unnecessary / unrecorded>

## Ledger versus transcripts

<the `summary:` line of `audit.cjs session <id>`, one per session>

| Session | Transcript events | Matched | Matched unattributed | Mentions excluded | Missing | Orphan rows | Stops | Re-entries |
|---|---|---|---|---|---|---|---|---|
| <id prefix> | <n> | <n> | <n> | <n> | <n> | <n> | <n> | <n> |

<for every missing event, orphan row, and unattributed row: kind, time, line number. Say which sessions had no transcript and were not compared. A count the helper reports as unknown is never turned into zero>

## Candidates

The verdicts belong to the operator: an empty cell means keep, no disposition is off-limits (including one that reverses Amber's own design), the machine applies nothing, and applying a verdict is a separate cycle on the operator's own installed copy.

| # | Item | Evidence | Proposed disposition | Verdict |
|---|---|---|---|---|
| 1 | <mechanism or event> | <ledger row or transcript line number> | <keep / remove / tune: what> | |

Observed once and therefore not a candidate: <list | none>

## Not answered

- Events that leave no trace in a transcript (for example Stop-hook counts a transcript format does not provide) cannot be confirmed.
- Whether the candidates hold and how verdicts are applied (the operator's, in a separate cycle).
- <the limits of this audit: sample size, period, ...>
