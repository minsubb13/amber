<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/amber/lockup-dark.svg">
    <img src="assets/amber/lockup-light.svg" width="440" alt="Amber">
  </picture>
</p>

**A contract-checking harness for Claude Code, Codex, and pi.**

- Define scope and completion evidence before work begins.
- Delegate inside an approved contract; stop and ask at its boundary.
- Review the result against real evidence before declaring completion.

`planning → set → approve → execute → review`

## Install

Requires Node.js 20+, git, and Claude Code 2.1+, Codex CLI 0.155+, or pi 1.3+.

**Claude Code**

```sh
claude plugin marketplace add minsubb13/amber#release
claude plugin install amber@amber
```

Claude Code leaves auto-update off for third-party marketplaces. To receive new releases automatically, run `/plugin`, open the **Marketplaces** tab, select `amber`, and choose **Enable auto-update**.

**Codex**

```sh
codex plugin marketplace add minsubb13/amber@release
codex plugin add amber@amber
```

Enable Amber in your project's `.codex/config.toml`:

```toml
[plugins."amber@amber"]
enabled = true
```

Review and trust Amber's hooks in Codex. Start a new session after installation.

**pi**

```sh
pi install git:github.com/minsubb13/amber@release
```

Add `-l` to install for the current project only. The package loads one extension (the hooks' events, enforcement, and the completion gate) and the skills as `amber-<name>`. Start a new session after installation.

All hosts install from the `release` branch; [RELEASING.md](RELEASING.md) describes how releases are cut.

### Optional pi runtime controls

Amber's enforcement works without runtime helpers. To opt in for one pi process, start:

```sh
pi --amber-runtime
# Or try this checkout without installing it:
pi -e ./plugin/pi/index.ts --amber-runtime
```

Without `--amber-runtime` (the default), Amber adds no model-switch tool, `/fast` command, fast status, priority payload, tier notices or recovery. No extra package or dependency is needed. This is a pi-only helper, not an enforcement policy; it does not change Claude Code or Codex.

- `switch_model` hands the next response to `openai/gpt-6.1-sol` or `anthropic/claude-opus-5-5`, optionally selecting pi's thinking level. It asks no confirmation, records the switch in the session, and never changes startup defaults. The target must have usable credentials. Amber's contract still applies after a switch.
- `/fast` reports state; `/fast on` and `/fast off` toggle OpenAI agent-loop priority requests. It starts on in each opted-in process and shows `fast` while on; toggles and the once-only tier notice survive `/reload`. It does not affect other providers, summaries or compaction.
- The completed response's tier is authoritative. A downgrade or unknown tier warns at most once per process. An HTTP400 naming `service_tier` turns fast off and continues once at default tier, without duplicating pi's native retry. Other errors use normal pi handling. Recovery cannot complete unfinished Amber work.

**Migrating from standalone pi-model-tools:** first run `pi list`, then remove its package with `pi remove <the exact source shown by pi list>` (add `-l` for a project install). If you loaded individual switch-model/fast extension files instead, remove those entries yourself. Restart pi before enabling `--amber-runtime`. Amber detects an existing `switch_model` or `/fast`, warns and disables its optional runtime rather than overriding either; it never edits your settings or uninstalls anything.

**Priority is a request, not a speed guarantee.** Quoted standalone evidence at `814562b`: the corrected real request returned HTTP200 but its completed tier was `default`, not `priority`; an earlier HTTP400 concerned unsupported reasoning, not service tier. Priority execution, speed and quota impact remain unverified. Integration tests use loopback mocks only; see the [development instructions](DEVELOPMENT.md#optional-pi-runtime-tests).

## Start

In your git repository, run `/amber:init` (Claude Code and pi) or `$amber:init` (Codex) once.
An empty repository works too: init then asks for the project's purpose, its first oracle, and what it will never do.
Check setup with `/amber:status` or `$amber:status`. On pi, `/amber:<name>` and `/skill:amber-<name>` are the same command.

Ask for work normally. Amber opens planning, decides whether a contract is useful,
and waits for your approval when one is needed.

### Example session

1. **Operator:** "Add a `config` command with a custom INI/YAML parser layer."
2. **Amber (`planning`):** Cites grounded evidence (`package.json`, `src/cli.cjs:12`), pushes back on unnecessary complexity with a simpler alternative, asks the load-bearing schema question, and defaults a reversible knob:
   > `src/cli.cjs:12` already uses `node:util` `parseArgs` and `package.json` has zero runtime dependencies. Rather than a custom parser layer, reading `.rc.json` via `JSON.parse` keeps the CLI dependency-free in ~25 lines. Does `.rc.json` work (and which keys belong in the schema), or do you need INI/YAML? I'll default the file size limit to 64 KB.
3. **Operator:** "`.rc.json` with `port` and `host` works."
4. **Amber (`set`):** Commits the scope document and gives the approval report (`What / Why / How / Verification and boundaries / Settled / Discretion / Not answered`):
   > **What & why:** Add `config` command reading `port` and `host` from `.rc.json` using `JSON.parse` (keeps zero runtime dependencies).
   > **How & verification:** Edit `src/cli.cjs` and `test/cli.test.cjs` only; verify `npm test` passes valid, missing, and >64 KB cases (64 KB limit under discretion; YAML/INI out of scope).
   >
   > Shall I go ahead with this scope?
5. **Operator:** "Yes, go ahead."
6. **Amber (`approve → execute`):** Activates `.amber/active.json`, enforces write-scope and `bash-deny` hooks, verifies the oracle, runs `record.cjs done`, and closes with the completion report.

[MIT License](LICENSE)
