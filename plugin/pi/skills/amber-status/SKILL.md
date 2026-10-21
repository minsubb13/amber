---
name: amber-status
description: Report Amber's installation, sensor, and contract status. Runs only when the user explicitly invokes /amber:status (or /skill:amber-status) in pi.
disable-model-invocation: true
---

# amber:status (pi)

This is Amber's `status` skill on the **pi** host. Read
[the shared skill](../../../skills/status/SKILL.md) in full now and follow it
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
