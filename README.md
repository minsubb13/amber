<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/amber/lockup-dark.svg">
    <img src="assets/amber/lockup-light.svg" width="440" alt="Amber">
  </picture>
</p>

**A contract-checking harness for Claude Code and Codex.**

- Define scope and completion evidence before work begins.
- Delegate inside an approved contract; stop and ask at its boundary.
- Review the result against real evidence before declaring completion.

`planning → set → approve → execute → review`

## Install

Requires Node.js 20+, git, and Claude Code 2.1+ or Codex CLI 0.155+.

**Claude Code**

```sh
claude plugin marketplace add minsubb13/amber
claude plugin install amber@amber
```

**Codex**

```sh
codex plugin marketplace add minsubb13/amber
codex plugin add amber@amber
```

Enable Amber in your project's `.codex/config.toml`:

```toml
[plugins."amber@amber"]
enabled = true
```

Review and trust Amber's hooks in Codex. Start a new session after installation.

## Start

In your git repository, run `/amber:init` (Claude Code) or `$amber:init` (Codex) once.
An empty repository works too: init then asks for the project's purpose, its first oracle, and what it will never do.
Check setup with `/amber:status` or `$amber:status`.

Ask for work normally. Amber opens planning, decides whether a contract is useful,
and waits for your approval when one is needed.

[MIT License](LICENSE)
