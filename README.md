# Amber

Amber is a contract-checking harness for [Claude Code](https://code.claude.com) and [Codex](https://github.com/openai/codex). It lets the model work with full delegation inside a per-run contract the operator approved, makes it stop and ask at the contract's boundary, and requires the model to re-check the contract's conditions against real evidence before it may declare the work complete. Every cycle event lands in an operator-global ledger, and an optional audit reads that ledger back to show which of Amber's own mechanisms are actually used.

Amber ships as one plugin for both hosts. The skills, hooks, and recorder are shared; only the host bindings differ.

## Requirements

- Node.js 20 or newer on `PATH` (the hooks run through `node`; without it they fail open and leave a breadcrumb)
- git (Amber zones live in git repositories)
- Claude Code 2.1 or newer, Codex CLI 0.155 or newer, or both

## Install

### Claude Code

From GitHub, for the current user:

```sh
claude plugin marketplace add minsubb13/amber
claude plugin install amber@amber
```

To enable Amber for everyone who opens a particular repository, put this in that repository's `.claude/settings.json` instead. Claude Code registers the marketplace and enables the plugin when the folder is trusted:

```json
{
  "extraKnownMarketplaces": {
    "amber": { "source": { "source": "github", "repo": "minsubb13/amber" } }
  },
  "enabledPlugins": { "amber@amber": true }
}
```

From a local checkout of this repository, pass its path to `claude plugin marketplace add` instead of `minsubb13/amber`.

Update later with `claude plugin marketplace update amber` followed by `claude plugin update amber@amber`.

### Codex

```sh
codex plugin marketplace add minsubb13/amber
codex plugin add amber@amber
```

A local checkout works the same way with its path in place of `minsubb13/amber`. Enable the plugin per project in that project's `.codex/config.toml`:

```toml
[plugins."amber@amber"]
enabled = true
```

Codex shows the plugin's five hooks in its hook management screen. Review and trust them, then start a new session. `codex plugin list --json` shows the installed version and whether it is enabled.

### Check

Start a new session in a git repository and run `/amber:status` (Claude Code) or `$amber:status` (Codex). It reports the installed version, the active contract (none at first), the ledger counts, and the run progress.

## How a run works

Amber governs one unit of work at a time through a cycle of three skills and one operator utterance:

1. **planning** opens the cycle for any work request. It judges whether the work needs a contract at all. Routine upkeep gets a recorded no-contract verdict and proceeds. Anything with scope to hold or decisions to gate goes through an elicitation: the model grounds itself in the repository, builds a list of tensions between the code and the operator's intent, answers what it can from evidence, and asks the operator only the questions that would otherwise be decided alone.
2. **set** writes two documents under the zone's `docs/` directory: the contract (completion conditions, forbidden rows, budget, settled decisions, discretion, standing rules) and the plan (work units with a write scope, an oracle, and dependencies each). It checks the machine rows, commits both, and reports what it understood.
3. The **operator approves** in conversation. Only an explicit approval utterance counts. On it the model creates `.amber/active.json` in the zone root and the run begins. No shell command is handed to the operator.
4. **execution** is the run itself. Rows in the contract tagged `[machine: write-scope <glob>]` and `[machine: bash-deny <regex>]` are enforced by a hook before file and shell tools act. Plan units transition through the recorder (`unit start`, `unit verified`, `unit failed`, `unit hold`). A stop with open units is sent back by the Stop hook; a legitimate stop is announced first with the `mark` skill as a hold. Independent units may run as parallel subagents in linked worktrees, re-verified and merged by the main agent.
5. **Completion** is a shell command, never a line in the message. After a fresh semantic review of the request, every contract condition, the artifacts, and the evidence, the model runs `record.cjs done --review ... --goal ... --summary ...` as its last tool call and ends the turn with a full report. The Stop hook consumes the signal, checks the pointer and the contract it names, records the completion, and releases the contract by itself.

The contract's `## Standing rules` section is handed to every session that opens in the zone, so the rules survive context loss.

## Skills

| Skill | Claude Code | Codex | Purpose |
|---|---|---|---|
| planning | `/amber:planning` or model-invoked | `$amber:planning` | open a cycle, verdict, elicitation |
| set | model-invoked after planning | `$amber:set` | write the contract and plan, wait for approval |
| init | `/amber:init` | `$amber:init` | port Amber into a project (explicit request only) |
| status | `/amber:status` | `$amber:status` | installation, contract, ledger, and progress report |
| mark | model-invoked | `$amber:mark` | record a skip, finding, or hold event |
| audit | `/amber:audit` | `$amber:audit` | self-correction audit of Amber's own mechanisms (explicit request only) |

`status` and `audit` never run on the model's own judgment.

## Setting up a project

Run `/amber:init` (or `$amber:init`) inside the project. The skill scans the code into an oracle map, interviews the operator until the load-bearing tensions are exhausted, generates or maps the fixed documents (the entry point `CLAUDE.md` or `AGENTS.md`, `intent.md`, `status.md`, a work-log convention), and adds the completion-signal protocol section to the entry document. The generated documents are presented as a diff for the operator's ratification. Add `.amber/` to the project's `.gitignore`; the pointer, progress file, and completion signal live there.

The ledger and session state live outside the project, in `${AMBER_HOME:-$HOME/.amber}`.

## Contract and plan format

The contract is a Markdown file. Its polarity sentence is fixed: "No load-bearing decision absent from this contract proceeds: stop and bring the question." Required sections are `## Completion conditions`, `## Forbidden rows`, and `## Budget`; optional ones are `## Settled decisions`, `## Discretion`, `## Standing rules`, and `## Question handling`. A row that ends with `[machine: write-scope <glob>]` or `[machine: bash-deny <regex>]` is enforced by the hooks; every other row is a self-reported boundary tagged `[self-report]`.

The plan carries the work units under `## Work units`, one checkbox row per unit:

```
- [ ] U1 <title> [unit: U1 scope=<glob>[,<glob>] after=<U#>[,<U#>] oracle=<command>]
```

Both skeletons, a development contract and a research contract, ship in `plugin/skills/set/templates/`, together with a mission document for research questions that span several passes.

## Audit

`/amber:audit` (or `$amber:audit`) reads the ledger and the host's transcripts through the read-only helper `plugin/scripts/audit.cjs` and writes `docs/audits/<date>-audit-<n>.md` in the zone: the counts, the mechanisms that never fired, a ledger-versus-transcript comparison, and a candidates table whose verdict column the operator fills. Nothing is applied automatically, no transcript body is quoted, and Amber never proposes an audit on its own.

## Tests

The regression suites need only Node.js and git:

```sh
node plugin/tests/run-tests.cjs
node --test plugin/tests/codex-tests.cjs plugin/tests/audit-tests.cjs plugin/tests/model-qa-tests.cjs
```

`plugin/tests/model-qa.cjs <claude|codex> <scenario>` runs real-model scenarios (`b01`, `loop`, `planning`, `sessions`, `approve`, `audit`, `runtime`, `init`, `status`) against the installed plugin in an isolated temporary zone. They call the host CLI and cost API usage; the installed version must match `plugin/.claude-plugin/plugin.json`. `plugin/tests/host-probe.cjs` observes a real Codex parent and child session.

## Uninstall

```sh
claude plugin uninstall amber@amber
codex plugin remove amber@amber
```

The ledger in `${AMBER_HOME:-$HOME/.amber}` is not removed.

## License

MIT. See [LICENSE](LICENSE).
