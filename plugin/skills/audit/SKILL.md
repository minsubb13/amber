---
name: audit
description: Run a self-correction audit of Amber's own mechanisms from the operator's ledger and Claude Code or Codex transcripts, and write a candidates report for the operator's keep/remove/tune verdicts. Runs only when the operator explicitly invokes /amber:audit in Claude Code or $amber:audit in Codex - never by your own judgment, and Amber never proposes it.
disable-model-invocation: true
allowed-tools: Read, Bash, Write, Skill
---

# audit - self-correction audit

Read the operator's ledger (`${AMBER_HOME:-$HOME/.amber}/runs.jsonl`) and host
transcripts to produce a report of candidate mechanisms that never fire, lost
ledger events, orphan rows, and other anomalies, each with evidence and a
proposed disposition.

## Principles

- The verdicts are the operator's. Every number comes from the read-only helper
  (a missing ledger is zero rows).
- Never quote transcript bodies: cite only event kind, timestamp, and line number.

## Input and preconditions

- Read [host integration](../../references/hosts.md) (`## Skill names and package root`,
  `## Invocation and event records`, and `### Audit transcripts`) and
  [run protocol](../../references/protocol.md), and resolve `amber_plugin_root`.
  On Codex, run `invoke audit` once (with any argument text after the skill
  name); on Claude Code, S1 records typed `/amber:audit` automatically (never
  call via a model-selected Skill-tool call).
- Read-only helper:

  ```sh
  node "$amber_plugin_root/scripts/audit.cjs" <command> [--period-end <ISO>] [--exclude <project>]...
  ```

  Commands: `summary` (counts; line 1 `period_end=<ISO>`, line 2
  `excluded_projects=<list|none>`), `dead` (`mechanism | field_count | status`),
  `sessions` (newest first: `session=<id> project=<p> first=<ISO> last=<ISO>
  rows=<n> completions=<k> transcript=<yes|no>`), `session <id-prefix>`
  (transcript events vs ledger rows: `matched` / `matched-unattributed` /
  `mention` / `refused` / `MISSING`, orphan rows, stop count, re-entry count, and
  `summary:`), `check-summary <report.md>` (exit 0 iff the report's fenced block
  starting with `period_end=` reproduces), and `check-session <id-prefix>`
  (exit 0 iff an opening-verdict text in the transcript lacks a skip row).

### Arguments (all optional)

- `exclude=<project>[,<project>]` - projects excluded from every count (default: none).
- `sessions=<id>[,<id>]` - session id prefixes to compare (default: chosen in step 4).
- `period-end=<ISO>` - end of the counted period (default: helper's `now`).

## Procedure

1. **Opening.** Invoke `amber:mark` with
   `skip - opening verdict - no contract: read-only audit report on the operator's own ledger and transcripts`
   and proceed. If the operator asked for a contract, invoke `amber:planning`
   instead and stop.
2. **Summary first.** Run `summary` with `--exclude` per project in `exclude=`
   and `--period-end` if given. Pin the printed `period_end=<ISO>` value and
   pass `--period-end <ISO>` (with the same `--exclude` flags) to every later
   command.
3. **Dead mechanisms and sessions.** Run `dead` and `sessions`.
4. **Samples.** Use `sessions=` if given; otherwise take up to five newest
   `sessions` rows with `completions>=1` and `transcript=yes`. Run
   `session <id-prefix>` for each. Report absent transcripts and `unknown`
   outcome/Stop counts as unavailable evidence, never as zero events or clean
   comparisons.
5. **Candidates.** Build the 5-column table
   (`# | Item | Evidence | Proposed disposition | Verdict`) from the evidence:
   - every `DEAD` mechanism (classified as `no opportunity` / `bypassed` /
     `unnecessary` / `unrecorded`);
   - every `MISSING` event, orphan row, unattributed row, re-entry count, hold
     usage, or other anomaly;
   - a single observation (`n=1` rule) is a lesson listed below the table, not
     a candidate row;
   - core mechanisms and design-reversing verdicts are allowed;
   - propose `keep` / `remove` / `tune` with ledger or transcript line evidence,
     leaving every `Verdict` cell empty.
6. **Report.** At the zone root (`git rev-parse --show-toplevel`, fallback `.`),
   write `<zone>/docs/audits/<YYYY-MM-DD>-audit-<n>.md` from
   [the template](templates/report.md) (`n` = existing `*-audit-*.md` count + 1).
   Paste `summary` output verbatim into `## Ledger counts` and `dead` output
   into `## Dead mechanisms`.
7. **Reproduce.** Run `check-summary <report>` with the same `--exclude` flags
   until it exits 0.
8. **Tell the operator** in plain words: show the candidates table and state the
   ground rules (verdicts are theirs; empty verdict = keep; any disposition
   including reversing Amber's design is allowed; nothing is applied
   automatically; applying verdicts is a separate cycle on their installed copy;
   no transcript bodies are included so the report is shareable).
9. **Signal.** If `.amber/active.json` exists, report only. Otherwise run as the
   last tool call in the zone root (no `--goal`):

   ```sh
   node "$amber_plugin_root/scripts/record.cjs" done --review "<what was compared and reproduced>" --summary "audit: <report path>"
   ```

## Completion

Done when the reproduced report is written, the table and ground rules are
presented to the operator, and step 9 has run.
