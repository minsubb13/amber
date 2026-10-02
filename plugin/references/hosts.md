# hosts.md - Amber host integration

Read this reference when using an Amber skill. The cycle and contract semantics
are shared ([run protocol](protocol.md)); use the branch for the host running
this session.

## Skill names and package root

- **Claude Code:** invoke `amber:planning`, `amber:set`, `amber:init`, or
  `amber:mark` with the Skill tool. The operator's command spelling is
  `/amber:<name>`. The explicit-only `status` and `audit` skills use the
  operator's `/amber:status` or `/amber:audit` command. Do not depend on a
  model-originated Skill-tool call: Claude Code can reject it because these
  skills have `disable-model-invocation: true`.
- **Codex:** select the installed `amber:<name>` skill (`planning`, `set`, `init`,
  `status`, `mark`, `audit`) and follow its
  `SKILL.md`; the operator can explicitly select it with `$amber:<name>`.
  Reading a skill file is not an invocation sensor and does not write a record.

Resolve the installed Amber package root before using a package file or command.
On Claude Code, use `CLAUDE_PLUGIN_ROOT`. On Codex, use `PLUGIN_ROOT` only if it
points to this Amber package. That variable may be available to hooks without
being present in the model's shell. Otherwise derive the root from the absolute
path of the loaded skill: `<root>/skills/<name>/SKILL.md` has its package root two
levels above the containing skill directory. Resolve any catalog path alias
first. Do not guess an install-cache path or use the project's checkout root.
Use the resolved absolute path as `amber_plugin_root` in the commands below.
Keep the command's working directory in the project zone, not in the plugin.

Codex hooks also receive a `CLAUDE_PLUGIN_ROOT` compatibility alias; that alias
alone does not identify the current host as Claude Code.

## Invocation and event records

**Claude Code:** the existing Skill tool hook records invocations and `mark`
events automatically. Do not also run `record.cjs` on this host.
Typed `/amber:audit` is recorded by S1; typed `/amber:status` intentionally
adds no invocation row. Its execution is observable in the command transcript
and the tools it runs, not a fabricated recorder call.

**Codex:** actually execute the recorder once at the start of each use of
`planning`, `set`, `init`, `status`, or `audit`, including model-selected uses:

```sh
node "$amber_plugin_root/scripts/record.cjs" invoke planning
```

Replace `planning` with the skill being used (`invoke audit` for the audit
skill). If the invocation supplied arguments,
pass their original text as a quoted argument after the skill name. The recorder
uses the current `CODEX_THREAD_ID` and `${AMBER_HOME:-$HOME/.amber}` automatically;
do not invent a session ID or redirect a real invocation to a test ledger.

For `mark`, execute only its event branch, once per event:

```sh
node "$amber_plugin_root/scripts/record.cjs" mark skip '<subject> - <reason>'
node "$amber_plugin_root/scripts/record.cjs" mark finding '<finding> - <disposition>'
```

Choose the matching command and replace its placeholder with the actual event
text. Existing skill arguments `skip - <text>` and `finding - <text>` become the
separate kind and text arguments above. Shell-quote supplied text safely, keeping
it literal. Do not also run `invoke mark`, and do not repeat an event as a bare
text marker. Wait for the command to succeed before saying the record was
written. If it fails, report the failure; reading this reference or the skill
does not substitute for the record.

## Loop-body unit commands (both hosts)

Unit transitions are shell commands on either host, run in the zone (a unit
worktree under the zone's `.claude/worktrees/` is fine - the recorder finds
the main checkout; a linked worktree outside the zone directory is a zone of
its own, with or without a pointer: it starts without a contract, and a
parallel run opened there gets its own `.amber/active.json`). The first unit command a session runs itself (not
a subagent) is observed by the PreToolUse enforcer and registers that session
as a driver of the run: only driving sessions are sent back by the Stop hook
while units are open, and only their completion signal is read. A sibling
session in the same zone is briefed about the run and still bound by its
write-scope and bash-deny rows, but never pulled into the loop.

```sh
node "$amber_plugin_root/scripts/record.cjs" unit init <plan-path>          # once, after approval
node "$amber_plugin_root/scripts/record.cjs" unit start U1
node "$amber_plugin_root/scripts/record.cjs" unit verified U1 --evidence '<what the oracle showed>' [--out-of-scope <path>=<reason> ...]
node "$amber_plugin_root/scripts/record.cjs" unit failed U1 --evidence '<what failed>'
node "$amber_plugin_root/scripts/record.cjs" unit hold U1 --reason '<why you must stop>'
node "$amber_plugin_root/scripts/record.cjs" unit hold U1 --reason "external: <job>"   # waiting on an external job
node "$amber_plugin_root/scripts/record.cjs" unit claim U1                  # a subagent's first action
```

`unit claim` is observed by the PreToolUse enforcer, which is the only party
that sees the host-assigned subagent id; the command then reports whether the
claim was recorded. On Claude Code, `hold` may also be recorded through the
amber:mark skill (`hold - U1 - <reason>`; external form
`hold - U1 - external: <job>`); on Codex, `mark hold` is the recorder's
`node "$amber_plugin_root/scripts/record.cjs" mark hold 'U1 - <reason>'`
(external form `mark hold 'U1 - external: <job>'`). What a plain and an
external hold let through is in the run protocol, "Loop body".

Post-hoc scope check (both hosts): `unit verified` and `done` compare
the files git reports as changed in the tree the command runs in - commits
since the contract file was added, working-tree changes, untracked files;
the paths already dirty at `unit init` excepted - with the contract's
write-scope rows. An undeclared file outside every write-scope refuses the
command and prints the list; declare each legitimate one with
`--out-of-scope <path>=<reason>` (repeatable, a glob is accepted) and the
declaration is recorded in progress.json and the ledger (`out_of_scope`).
Any git failure refuses - Amber zones live in git. E1 still refuses
file-tool writes outside the scope before they happen; shell writes reach
only this check.

### Parallel unit worktrees

Both hosts use the same unit claims, per-unit scope, main-agent verification,
merge, and worktree cleanup. On Claude Code use the Agent tool's worktree
isolation. On Codex, the main agent creates one linked worktree and branch per
independent unit under `<zone>/.claude/worktrees/<unit>` (the zone must ignore
that directory), then starts child agents concurrently. Pass each child its
absolute worktree path, unit row, oracle, and resolved recorder path. Its first
tool action is `unit claim U<n>` with that worktree as the shell workdir; all
later shell calls use the same workdir and file patches use absolute paths in
that worktree. Children preserve others' work and do not write in the main
checkout. A unit worktree has no separate active pointer: it inherits this run.

Codex hooks supply the parent's `session_id` plus the child's `agent_id`;
the child's shell `CODEX_THREAD_ID` is the child id. Claims use the authoritative
hook `agent_id`, never a model-invented id. Codex file hooks can retain the
parent cwd, so E1 maps absolute targets in git-registered linked worktrees
before applying the contract and unit scopes. Do not work around a denied
patch with a shell write. The main agent re-runs each oracle in its worktree,
records verified there, and merges as the run protocol's "Loop body"
describes.

A worktree placed outside the zone directory is not a unit worktree: the
hooks treat it as a zone of its own (it starts without a contract), and the
run's completion check does not wait for it. Unit worktrees stay inside
the zone so the run's contract, scopes, and merge apply to them.

### Audit transcripts

The read-only audit helper supports both Claude Code project transcripts and
Codex rollouts. By default it searches `~/.claude/projects` and
`${CODEX_HOME:-~/.codex}/{sessions,archived_sessions}`. `AMBER_TRANSCRIPTS`
replaces these defaults with a single explicit root (including nested date
directories), so fixture runs never fall back to the operator's transcripts.
Codex code-mode recorder calls are read from actual CommandExecution events;
direct shell function calls are also supported. Missing or ambiguous outcomes
stay unknown. A final assistant response is not proof of a Stop hook: where
the rollout lacks stop_hook_summary, report that count as unknown, not zero.

## Completion signal (both hosts)

Completion is signalled with a shell command, never with a line in the
message. After the fresh semantic review, run in the zone root as the last
tool call:

```sh
node "$amber_plugin_root/scripts/record.cjs" done --review '<evidence-based review result>' --goal '<goal-test result>' --summary '<one-line summary>' [--out-of-scope <path>=<reason> ...]
```

Omit `--goal` without an active contract (the command refuses it there and
requires it under one). The command writes `<zone>/.amber/done.json` and is
refused while plan units are open, the pointer is broken, or an undeclared
file outside the write-scope changed (see the scope check above). Running it also
registers the session as a driver of the run, so the Stop hook reads the
signal in the same session. The Stop hook
consumes the file, records the completion, and on a pass under a contract
removes `.amber/active.json` and `.amber/progress.json` by itself. Then end
the turn with the completion report.

## Project entry point and installation

- **Claude Code:** the zone's `.claude/settings.json` registers the Amber
  marketplace and enables the plugin at project scope. The entry document is
  `CLAUDE.md`; the package manifest is `.claude-plugin/plugin.json`.
- **Codex:** run `codex plugin list --json` in the zone and confirm Amber is
  installed and enabled. The entry document is `AGENTS.md`; the package manifest
  is `.codex-plugin/plugin.json`. Check the current session's Amber S0 context
  and sensor records separately: an enabled listing or readable skill alone
  does not prove that hooks ran in this session.

If installation is missing or disabled, report the observed state and the
host's installation step before continuing project initialization. After a new
install, use a fresh session to check the sensors. Where both entry documents
exist, map their existing roles and update only the current host's entry point;
keep shared intent, status, work logs, and contracts as single sources.

## Approval (both hosts)

Approval works the same on both hosts; the rule is the run protocol's
"Approval", and `set`'s step 6 performs it.

## Independent reviewer (both hosts)

A review unit (set, "Review unit") calls a reviewer that reads the pinned
commit, the contract, the artifacts, and the evidence itself, read-only, in
a fresh context. The contract names the reviewer; these are the call shapes
on each host. In an Orca pair the other host's live session is the usual
reviewer: dispatch the request there and hold the unit with
`external: review by <host>`. The headless calls below are the fallback and
the shape of a scripted review.

- **From Claude Code, Codex reviews:**
  `codex exec --sandbox read-only "<review request>"`
  (or `codex review --commit <sha>` for a plain diff review). The sandbox
  refuses writes. Put the contract path, the verdict template path, and the
  commit to review in the request.
- **From Codex, Claude Code reviews:**
  `claude -p "<review request>" --permission-mode dontAsk --tools "Read,Grep,Glob"`.
  The request comes right after `-p`; `--tools` takes several names and
  would swallow a request placed after it. The tool list carries no editor
  and no shell, so the session can only read.

The reviewer writes nothing into the zone: capture its output and save it as
the verdict file yourself, or ask for the verdict in the template's shape.
Neither call may run Amber's recorder or start another review. Do not hand
the reviewer the author's summary as the thing to review; hand it the commit.
