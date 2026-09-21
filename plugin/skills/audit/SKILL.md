---
name: audit
description: Run a self-correction audit of Amber's own mechanisms from the operator's ledger and Claude Code or Codex transcripts, and write a candidates report for the operator's keep/remove/tune verdicts. Runs only when the operator explicitly invokes /amber:audit in Claude Code or $amber:audit in Codex - never by your own judgment, and Amber never proposes it.
disable-model-invocation: true
allowed-tools: Read, Bash, Write, Skill
---

# audit - self-correction audit

Before anything else, read [host integration](../../references/hosts.md) and
resolve `amber_plugin_root`. On Codex, execute its `invoke audit` recorder
command once for this invocation (the argument text goes after the skill
name); on Claude Code, the operator's typed `/amber:audit` call is recorded
automatically by S1. Load this explicit-only skill from the operator's slash
command rather than a model-selected Skill-tool call on Claude Code.

The audit reads the operator's own records - the ledger
`${AMBER_HOME:-$HOME/.amber}/runs.jsonl` and both hosts' transcripts (the default
roots and the isolated `AMBER_TRANSCRIPTS` override are in host integration) - and produces one report of
candidates: mechanisms that never fire, events the ledger lost, rows that
match nothing, and anything else anomalous, each with evidence and a proposed
disposition. The verdicts are the operator's. Every number comes from the
read-only helper (a missing ledger is zero rows):

```sh
node "$amber_plugin_root/scripts/audit.cjs" <command> [--period-end <ISO>] [--exclude <project>]...
```

Commands: `summary` (the counts; line 1 `period_end=<ISO>`, line 2
`excluded_projects=<list|none>`), `dead` (`mechanism | field_count | status`
per declared mechanism), `sessions` (candidate sessions, newest first:
`session=<id> project=<p> first=<ISO> last=<ISO> rows=<n> completions=<k>
transcript=<yes|no>`), `session <id-prefix>` (transcript events against ledger
rows: matched / matched-unattributed / mention / refused / MISSING, orphan
rows, stop count, re-entry count, and a `summary:` line),
`check-summary <report.md>` (exit 0 iff the report's fenced block starting
with `period_end=` reproduces), `check-session <id-prefix>` (exit 0 iff an
opening-verdict text exists in the transcript with no skip row - a loss).

## Arguments (all optional)

- `exclude=<project>[,<project>]` - projects left out of every count, for
  example the zone where Amber itself is developed. Default: none.
- `sessions=<id>[,<id>]` - the sessions to compare (id prefixes). Default:
  chosen in step 4.
- `period-end=<ISO>` - the end of the counted period. Default: now, as the
  helper prints it.

## Procedure

1. **Opening.** This is a read-only report on the operator's own records, so
   it runs without a contract by default: invoke the amber:mark skill with
   args `skip - opening verdict - no contract: read-only audit report on the
   operator's own ledger and transcripts` and go on. If the operator asked for
   a contract, invoke amber:planning instead and stop here.
2. **Summary first.** Run `summary` with one `--exclude` per project in
   `exclude=` and `--period-end` from `period-end=` if given. Take the
   `period_end=` value it prints and pass it as `--period-end` (with the same
   `--exclude` flags) to every later command, so the numbers stay stable
   while you work.
3. **Dead mechanisms and sessions.** Run `dead` and `sessions`.
4. **Samples.** Use the operator's `sessions=` list. Otherwise take up to
   five of the newest `sessions` lines with `completions` of at least 1 and
   `transcript=yes`, from either host. Run `session <id>` for each sample.
   Report absent transcripts and unknown outcome/Stop counts as unavailable
   evidence; never turn them into zero events or a successful comparison.
5. **Candidates.** Build the table from the evidence:
   - every DEAD mechanism, classified as no opportunity / bypassed /
     unnecessary / unrecorded;
   - every MISSING event (in the transcript, no ledger row - a loss), every
     orphan row (a row with no event - a false row), every unattributed row,
     the re-entry counts, how holds were used, and anything else anomalous;
   - one observation is a lesson, not a candidate (n=1 rule) - list it under
     the table instead;
   - core mechanisms are candidates like any other, and no disposition is
     off-limits - a verdict that reverses Amber's own design is allowed;
   - propose keep / remove / tune for each row with its evidence (a ledger
     row or a transcript line number); the verdict column stays empty.
6. **Report.** Zone root = `git rev-parse --show-toplevel` (falling back to
   the current directory). Write `<zone>/docs/audits/<YYYY-MM-DD>-audit-<n>.md`
   from [the template](templates/report.md), where n = the number of existing
   `*-audit-*.md` files in that directory + 1 (create the directory if
   needed). Paste the `summary` output verbatim into the fenced block of
   `## Ledger counts` and the `dead` output into the block of `## Dead mechanisms`. Never
   quote transcript bodies: an event is its kind, time, and line number only.
7. **Reproduce.** Run `check-summary <report>` with the same `--exclude`
   flags. It must exit 0; otherwise fix the block and run it again.
8. **Tell the operator**, in the message and in plain words for someone who
   did not watch: the candidates table itself, then the ground rules - the
   verdicts are theirs; an empty verdict means keep; any disposition is
   allowed, including one that reverses Amber's design; the machine applies
   nothing; applying verdicts is a separate cycle on their own installed copy;
   the report holds no transcript bodies, so it may be shared with the
   maintainer.
9. **Signal.** If `.amber/active.json` exists at the zone root, report only -
   the completion signal belongs to that run. Otherwise run, as the last tool
   call, in the zone root:

   ```sh
   node "$amber_plugin_root/scripts/record.cjs" done --review "<what was compared and reproduced>" --summary "audit: <report path>"
   ```

   No `--goal`: there is no contract.
