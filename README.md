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
