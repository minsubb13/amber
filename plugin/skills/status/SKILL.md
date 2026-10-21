---
name: status
description: Report Amber's installation, sensor, and contract status. Runs only when the user explicitly invokes /amber:status in Claude Code or $amber:status in Codex.
disable-model-invocation: true
allowed-tools: Read, Bash
---

# status - installation, sensor, and contract report

Report the current state of the Amber harness, one line per item. Add nothing else.

## Input and preconditions

- Read [host integration](../../references/hosts.md) (`## Skill names and package root`
  and `## Invocation and event records`).
- On Codex, run `invoke status` once. On Claude Code and pi, `/amber:status` intentionally
  adds no ledger row; do not call via the Skill tool or run `record.cjs`.

## Procedure

1. **Install**: resolve `amber_plugin_root`, read its manifest (`.claude-plugin/plugin.json` on Claude Code, `.codex-plugin/plugin.json` on Codex, `.claude-plugin/plugin.json` on pi), and report plugin name and version (or the exact read failure - never guess).
2. **Active contract**: at the zone root (`git rev-parse --show-toplevel`, fallback `.`), read `.amber/active.json`. Report `"Active contract: none"` if missing, the `boundary` path plus `ratified_by` and `ratified_at` if valid, or a broken pointer if the pointer or contract file is unreadable.
3. **Sensor**: from `${AMBER_HOME:-$HOME/.amber}/runs.jsonl` (0 for both if missing), report `"Cycle completions: N (ledger lines: M)"`, where `N` counts distinct `contract` values on rows with `trigger: "done-declaration"`, a `contract` field, and `gate: "passed"`, and `M` is raw line count. If `${AMBER_HOME:-$HOME/.amber}/state/sensor-failures.log` is non-empty, also report its line count and path.
4. **Progress**: if `.amber/progress.json` exists at the zone root, report `"Units: <open> of <total> open (verified: ..., running: ..., failed: ..., limit: ...); next: <U#>; hold: <unit - reason | none>"` (`external` hold: `hold: U<n> - external since <ts> - <reason>`), `"driving sessions: <session_ids | none registered yet>"`, and any linked worktrees from `git worktree list` beyond the main checkout. Report `"Progress: none"` if absent, or the exact read error if unreadable.
5. **Last audit**: from the newest `skill-invocation` row in `runs.jsonl` whose `summary` starts with `amber:audit`, report `"Last audit: <ts> (<project>); completions since: <k>"` (`k` = distinct passed contracts after `<ts>`), or `"Last audit: none"`. Do not suggest running an audit.

## Completion

Done when all five items (`Install`, `Active contract`, `Sensor`, `Progress`,
and `Last audit`) are reported in five lines with no extra commentary or
suggestion to run an audit.
