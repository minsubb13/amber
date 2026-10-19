# hosts.md - Amber host integration

Shared semantics live in [run protocol](protocol.md). Read the **Hot path**
sections (`## Skill names and package root`, `## Invocation and event records`)
on every skill entry; read the **On-demand sections** below only when the
current step uses them.

## Skill names and package root

- **Claude Code:** invoke `amber:planning`, `amber:set`, `amber:init`, or
  `amber:mark` with the Skill tool (operator command: `/amber:<name>`). Explicit-only
  `/amber:status` and `/amber:audit` have `disable-model-invocation: true`;
  never call them via a model-originated Skill-tool call.
- **Codex:** select the installed `amber:<name>` skill (`planning`, `set`,
  `init`, `status`, `mark`, `audit`) and follow its `SKILL.md` (operator
  command: `$amber:<name>`). Reading a skill file does not write a ledger record.

Resolve the installed Amber package root as `amber_plugin_root` before running a
package command, keeping the shell working directory in the project zone:
- **Claude Code:** use `CLAUDE_PLUGIN_ROOT`.
- **Codex:** use `PLUGIN_ROOT` if present in the shell and pointing to this
  Amber package; otherwise resolve any catalog alias and take the directory that contains `skills/` (two levels above `<root>/skills/<name>/SKILL.md`). Do not
  guess an install-cache path or use the project's checkout root. (Codex hooks
  also receive a `CLAUDE_PLUGIN_ROOT` alias; that alias alone does not identify Claude Code.)

## Invocation and event records

- **Claude Code:** the S3 Skill hook records invocations and `mark` events
  automatically; typed `/amber:audit` is recorded by S1, and typed
  `/amber:status` intentionally adds no invocation row. Never run `record.cjs`
  for these on Claude Code.
- **Codex (`planning`, `set`, `init`, `status`, `audit`):** execute once at the
  start of each use (pass original argument text quoted after the skill name if
  present; uses `CODEX_THREAD_ID` and `${AMBER_HOME:-$HOME/.amber}` automatically):
  ```sh
  node "$amber_plugin_root/scripts/record.cjs" invoke <skill> ["<args>"]
  ```
- **Codex (`mark`):** execute only the matching event branch once per event
  (never run `invoke mark` or emit a bare text marker; wait for exit 0 and
  report any failure):
  ```sh
  node "$amber_plugin_root/scripts/record.cjs" mark skip '<subject> - <reason>'
  node "$amber_plugin_root/scripts/record.cjs" mark finding '<finding> - <disposition>'
  node "$amber_plugin_root/scripts/record.cjs" mark hold 'U<n> - <reason>'
  ```

---

*On-demand sections - read only when executing units, completing a run,
initializing a zone, running an audit, or dispatching a review.*

## Loop-body unit commands (both hosts)

Run unit transitions in the zone (or in a unit worktree under
`<zone>/.claude/worktrees/`; the recorder resolves the main checkout). The first
unit command a main session (not a subagent) runs registers it as a driver of
the run: only driving sessions are sent back by the Stop hook while units are
open or have their completion signal read. Sibling sessions in the zone receive
the briefing and obey `write-scope` and `bash-deny`, but are not pulled into the loop.

```sh
node "$amber_plugin_root/scripts/record.cjs" unit init <plan-path>          # once, after approval
node "$amber_plugin_root/scripts/record.cjs" unit start U1
node "$amber_plugin_root/scripts/record.cjs" unit verified U1 --evidence '<what the oracle showed>' [--out-of-scope <path>=<reason> ...]   # --evidence is required
node "$amber_plugin_root/scripts/record.cjs" unit failed U1 --evidence '<what failed>'   # --evidence is required
node "$amber_plugin_root/scripts/record.cjs" unit hold U1 --reason '<why you must stop>'
node "$amber_plugin_root/scripts/record.cjs" unit hold U1 --reason "external: <job>"   # waiting on an external job
node "$amber_plugin_root/scripts/record.cjs" unit claim U1                  # a subagent's first action
```

`unit claim` is observed by the PreToolUse enforcer (which sees the
host-assigned subagent id) and reports whether the claim was recorded. Holds can
also be recorded via `amber:mark` (`hold - U1 - <reason>` or
`hold - U1 - external: <job>`; Codex `mark hold` above).

**Post-hoc scope check (both hosts):** `unit verified` and `done` compare
git-reported changes in the target tree - commits since the contract file was
added (or, when no commit added it, since the HEAD that `unit init` recorded in
`progress.json` as `baseline_commit`), working-tree edits, and untracked files,
except paths already dirty at `unit init` - against the contract's `write-scope`
rows. Any undeclared file outside scope (or any git failure) refuses the
command; declare legitimate exceptions with repeatable
`--out-of-scope <path>=<reason>` (globs accepted, recorded in `progress.json`
and the ledger as `out_of_scope`). E1 still blocks out-of-scope file-tool writes
beforehand; shell writes are caught here.

### Parallel unit worktrees

- **Claude Code:** use the Agent tool's worktree isolation.
- **Codex:** create one linked worktree and branch per independent unit under
  `<zone>/.claude/worktrees/<unit>` (gitignored by the zone) and start child
  agents concurrently. Pass each child its absolute worktree path, unit row,
  oracle, and resolved `record.cjs` path. Its first tool call is `unit claim U<n>`
  with that worktree as shell workdir; all later shell calls use that workdir
  and file patches use absolute paths inside it (never write in the main checkout
  or bypass a denied patch with a shell write). Codex hooks supply parent
  `session_id` + child `agent_id` (`CODEX_THREAD_ID`), and E1 maps absolute
  targets in git-registered linked worktrees before checking contract/unit scopes.
- **Worktree boundary:** unit worktrees live inside `<zone>/.claude/worktrees/`
  and inherit the active run without a separate pointer. A linked worktree
  outside the zone directory is a separate zone: `.amber/` is gitignored so no
  pointer travels with a checkout, committed contracts govern nothing without a
  pointer, and the run's completion check does not wait for external worktrees.

### Audit transcripts

`audit.cjs` reads Claude Code transcripts (`~/.claude/projects`) and Codex
rollouts (`${CODEX_HOME:-~/.codex}/{sessions,archived_sessions}`). Setting
`AMBER_TRANSCRIPTS` replaces both defaults with a single explicit root
(including nested date directories) for isolated fixture runs. Codex recorder
calls are read from `CommandExecution` events and direct shell calls. Missing or
ambiguous outcomes and rollouts lacking `stop_hook_summary` are reported as
`unknown`, never zero.

## Completion signal (both hosts)

After the fresh semantic review ([protocol](protocol.md), "Completion"), run in
the zone root as the last tool call (never put a marker line in the message):
```sh
node "$amber_plugin_root/scripts/record.cjs" done --review '<evidence-based review result>' --goal '<goal-test result>' --summary '<one-line summary>' [--out-of-scope <path>=<reason> ...]
```
Include `--goal` iff an active contract governs the zone. The command writes
`<zone>/.amber/done.json`, registers the session as a driver, and refuses if
plan units are open, the pointer is broken, or undeclared out-of-scope files
changed. The Stop hook consumes `done.json`, records completion, and on a pass
removes `.amber/active.json` and `.amber/progress.json`. End with the completion
report ([reports](reports.md)).

## Project entry point and installation

- **Claude Code:** `.claude/settings.json` registers the Amber marketplace and
  enables the plugin at project scope; entry document `CLAUDE.md`, manifest
  `.claude-plugin/plugin.json`.
- **Codex:** `codex plugin list --json` in the zone confirms Amber is installed
  and enabled; entry document `AGENTS.md`, manifest `.codex-plugin/plugin.json`.
  Verify S0 context and ledger records separately (listing alone does not prove
  hooks ran in this session).

If installation is missing or disabled, report the observed state and host
install step before continuing `init` (use a fresh session after installing to
verify sensors). When both entry documents exist, map their roles, update only
the current host's entry document, and share single-source intent, status, work
logs, and contracts.

## Independent reviewer (both hosts)

A review unit (`set`, "Review unit") calls a read-only reviewer in a fresh
context to inspect the pinned commit, contract, artifacts, and evidence (never
hand it the author's summary to review). In an Orca pair, dispatch to the other
host's live session and hold the unit with `external: review by <host>`.
Headless fallback / scripted calls:
- **From Claude Code, Codex reviews:**
  `codex exec --sandbox read-only "<review request>"` (or
  `codex review --commit <sha>` for a plain diff review). Include contract path,
  verdict template path, and commit SHA.
- **From Codex, Claude Code reviews:**
  `claude -p "<review request>" --permission-mode dontAsk --tools "Read,Grep,Glob"`
  (place the request immediately after `-p`, before `--tools`).
The reviewer writes nothing in the zone and never runs `record.cjs` or starts
another review; capture its output and save the verdict file yourself.
