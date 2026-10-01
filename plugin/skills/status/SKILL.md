---
name: status
description: Report Amber's installation, sensor, and contract status. Runs only when the user explicitly invokes /amber:status in Claude Code or $amber:status in Codex.
disable-model-invocation: true
allowed-tools: Read, Bash
---

# status - installation, sensor, and contract report

Report the current state of the Amber harness, one line per item. Add nothing else.

## Principles

- A value that cannot be read is reported as that failure, exactly - never
  filled in with a guess.

## Input and preconditions

- Before reporting, read [host integration](../../references/hosts.md).
- On Codex, execute its `invoke status` recorder command once for this
  invocation. On Claude Code, the operator's `/amber:status` command loads
  this skill; typed status intentionally adds no ledger row. Do not call
  this explicit-only skill through the Skill tool or run a recorder command
  on Claude Code.

## Procedure

1. **Install**: resolve the installed Amber root from the host integration and read its host manifest (`.claude-plugin/plugin.json` on Claude Code, `.codex-plugin/plugin.json` on Codex). Report the plugin name and version. On read failure, report the failure as-is - never fill in a guess.

   Exit: the Install line is reported.
2. **Active contract**: find the zone root (`git rev-parse --show-toplevel`, falling back to the current directory) and read `.amber/active.json` there. If the file is missing, report "Active contract: none" (a passed completion releases the pointer by itself, so none after a run is the normal state). If present, report the contract file it points to (the pointer's `boundary` field - schema v1 name) plus `ratified_by` and `ratified_at`. If the pointer or the contract file it points to is unreadable, report exactly that as a broken pointer - never guess.

   Exit: the Active contract line is reported.
3. **Sensor**: report "Cycle completions: N (ledger lines: M)" from `${AMBER_HOME:-$HOME/.amber}/runs.jsonl` (0 for both if the file is missing). N counts completed contract runs - the number of DISTINCT `contract` values among lines whose `trigger` is `done-declaration` AND that carry a `contract` field AND whose `gate` is `passed` (a contract with multiple passed declarations counts once; skill invocations, findings, skips, contract-less declarations, and exhausted gates are not completions). M is the raw line count. If `${AMBER_HOME:-$HOME/.amber}/state/sensor-failures.log` exists and is non-empty, additionally report its line count and path - a sensor that failed silently must be surfaced here.

   Exit: the Sensor line is reported.
4. **Progress**: if `.amber/progress.json` exists at the zone root, report "Units: <open> of <total> open (verified: ..., running: ..., failed: ..., limit: ...); next: <U#>; hold: <unit - reason | none>" from its `units` and `hold` fields (an external hold, `hold.kind` = `external`, is reported as `hold: U<n> - external since <ts> - <reason>` with `<ts>` from `hold.ts`), plus "driving sessions: <session_ids | none registered yet>" from its `session_ids` field (the sessions that ran a unit command or the completion signal; only they are sent back and may close the run), plus the linked worktrees reported by `git worktree list` other than the main checkout. If the file is unreadable, report exactly that. If it is absent, report "Progress: none".

   Exit: the Progress line is reported.
5. **Last audit**: from the same ledger, take the newest `skill-invocation` row whose `summary` starts with `amber:audit` (a typed `/amber:audit` or the Skill tool). Report "Last audit: <ts> (<project>); completions since: <k>" with that row's `ts` and `project`, where k counts completions as in item 3 (distinct passed contracts) among rows whose `ts` is later than that row's. If no such row exists, report "Last audit: none". Do not suggest running an audit.

   Exit: the Last audit line is reported, with no suggestion to run an audit.
