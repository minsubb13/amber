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
- **pi:** the skills are installed as `amber-<name>` (`amber-planning`,
  `amber-set`, `amber-init`, `amber-mark`, explicit-only `amber-status` and
  `amber-audit`); each is a short pointer to the shared `skills/<name>/SKILL.md`.
  Load one by reading its `SKILL.md` (operator command: `/amber:<name>` or
  `/skill:amber-<name>`). Read `amber:<name>` in any Amber text as `amber-<name>`.

Resolve the installed Amber package root as `amber_plugin_root` before running a
package command, keeping the shell working directory in the project zone:
- **Claude Code:** use `CLAUDE_PLUGIN_ROOT`.
- **Codex:** use `PLUGIN_ROOT` if present in the shell and pointing to this
  Amber package; otherwise resolve any catalog alias and take the directory that contains `skills/` (two levels above `<root>/skills/<name>/SKILL.md`). Do not
  guess an install-cache path or use the project's checkout root. (Codex hooks
  also receive a `CLAUDE_PLUGIN_ROOT` alias; that alias alone does not identify Claude Code.)
- **pi:** `AMBER_PLUGIN_ROOT` if present in the shell; otherwise the directory
  that contains `skills/` and `scripts/` - two levels above the shared
  `<root>/skills/<name>/SKILL.md`, three levels above the pointer skill
  `<root>/pi/skills/amber-<name>/SKILL.md`. The briefings also print the
  absolute `record.cjs` path.

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
- **pi:** the Amber extension records invocations automatically - a model
  read of an `amber-<name>/SKILL.md` and a typed `/amber:<name>` or
  `/skill:amber-<name>` prompt, with the same rows as Claude Code (typed
  `/amber:status` adds no row). Never run `record.cjs invoke` on pi.
- **Codex and pi (`mark`):** execute only the matching event branch once per event
  (never run `invoke mark` or emit a bare text marker; wait for exit 0 and
  report any failure; uses `CODEX_THREAD_ID` on Codex, `PI_SESSION_ID` on pi):
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
The session-opening briefing (S0; on both hosts - a Codex session leaves the
same S0 state file - and on Claude Code at startup, resume, clear and compact)
and a session's first S1 briefing print the contract's section
`## Completion conditions` under the contract identity and, under the progress
summary, a `verified so far:` block with one line per verified unit (its
files, 12 at most, and its evidence cut to 160 characters), so a cleared or
compacted session continues from its first turn.

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

**Post-hoc scope check (both hosts):** `unit verified` and `done` compare the
files changed since the run began against the contract's `write-scope` rows.
The run's baseline is the one `record.cjs activate` records in
`.amber/active.json` (`baseline`: the HEAD, a `manifest` of blob hashes for
every path that was dirty or untracked at that moment, and `contract_blob`,
the contract file's own hash); `unit init` records one in `progress.json` only
for a pointer written without one. Changed = commits since the baseline
commit, working-tree edits and untracked files that were not in the manifest,
and manifest paths whose content (blob hash) is no longer the recorded one -
so a pre-run edit is excused only while it stays what it was, and the refusal
marks such paths (do not `git checkout` them; restore the pre-run content). A
contract file whose hash differs from `contract_blob` refuses outright and
cannot be declared away (the contract is frozen while active; this check runs
before the scope comparison and even when the contract has no write-scope
rows left). Without any
recorded baseline the commit that added the contract file is the baseline and
nothing is excused. Any undeclared file outside scope (or any git failure, or a
baseline value that is not a git hash) refuses the command; declare legitimate
exceptions with repeatable `--out-of-scope <path>=<reason>` (globs accepted,
recorded in `progress.json` and the ledger as `out_of_scope`). E1 still blocks
out-of-scope file-tool writes beforehand; shell writes are caught here.
`unit verified` also keeps the paths the unit changed on its verified history
entry in `progress.json` (`files`: the changed set minus what earlier
verified units already carry, 50 at most, beside `files_count`) and puts
`files_count` on its ledger row.

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
- **pi:** pi has no built-in subagents; run units serially in the main
  session, or start one child pi per unit worktree, passing the parent session
  and a fresh agent id so the extension treats the child as that unit's
  subagent (claim handshake, unit-scope checks, no Stop-hook loop):
  `(cd <zone>/.claude/worktrees/<unit> && AMBER_AGENT_ID=<unit>-<n> AMBER_PARENT_SESSION_ID="$PI_SESSION_ID" pi -p "<brief>")`.
  The brief carries the same items as on Codex; its first tool call is
  `unit claim U<n>`.
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
`unknown`, never zero. pi sessions (`~/.pi/agent/sessions`) are not read yet:
pi rows report `transcript=no`, which is unavailable evidence, not zero events.

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
- **pi:** `pi list` shows the installed Amber package (installed with
  `pi install git:github.com/minsubb13/amber@release`); entry document
  `AGENTS.md` (pi also loads `CLAUDE.md`), manifest `.claude-plugin/plugin.json`
  (its version is the one the ledger records). The S0 briefing arrives as a
  hidden `amber` message before the first prompt.

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
- **From pi:** use either command above (`codex exec ...` or `claude -p ...`).
- **From Claude Code or Codex, pi reviews:**
  `pi --print --no-session --tools read,grep,find,ls "<review request>"`.

The reviewer writes nothing in the zone and never runs `record.cjs` or starts
another review; capture its output and save the verdict file yourself.
