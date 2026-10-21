---
name: amber-mark
description: Record one Amber cycle event in the ledger, from anywhere in a turn. Invoke with skip arguments for a declined gate or a no-contract opening verdict, finding arguments for a verification finding whose disposition is settled, or hold arguments to announce a legitimate stop while plan units are still open. On pi, the event is recorded with the recorder command described in the skill. Not for completion - that is the `record.cjs done` completion signal on every host.
---

# amber:mark (pi)

This is Amber's `mark` skill on the **pi** host. Read
[the shared skill](../../../skills/mark/SKILL.md) in full now and follow it
exactly; this file adds nothing else.

- Host: **pi**. Wherever the shared skill or its references give per-host
  instructions, follow the **pi** lines of
  [host integration](../../../references/hosts.md); where pi is not named, the
  Codex line applies (`record.cjs` takes `PI_SESSION_ID` in place of
  `CODEX_THREAD_ID`).
- `amber_plugin_root` is three levels above this file (the directory holding
  `scripts/record.cjs`).
- Loading this file records nothing: the event row comes only from the
  `record.cjs mark` command (never run `record.cjs invoke`).
