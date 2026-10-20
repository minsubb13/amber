---
name: amber-audit
description: Run a self-correction audit of Amber's own mechanisms from the operator's ledger and Claude Code or Codex transcripts, and write a candidates report for the operator's keep/remove/tune verdicts. Runs only when the operator explicitly invokes /amber:audit (or /skill:amber-audit) in pi - never by your own judgment, and Amber never proposes it.
disable-model-invocation: true
---

# amber:audit (pi)

This is Amber's `audit` skill on the **pi** host. Read
[the shared skill](../../../skills/audit/SKILL.md) in full now and follow it
exactly; this file adds nothing else.

- Host: **pi**. Wherever the shared skill or its references give per-host
  instructions, follow the **pi** lines of
  [host integration](../../../references/hosts.md); where pi is not named, the
  Codex line applies (`record.cjs` takes `PI_SESSION_ID` in place of
  `CODEX_THREAD_ID`).
- `amber_plugin_root` is three levels above this file (the directory holding
  `scripts/record.cjs`).
- Loading this file already recorded the invocation: never run
  `record.cjs invoke`.
