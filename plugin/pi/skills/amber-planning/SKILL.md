---
name: amber-planning
description: Open an Amber cycle - judge inside whether the work needs a contract, then either elicit the material for one or record a no-contract verdict and proceed. Invoke for any work request - anything that would change zone files or produce a deliverable - or when the operator explicitly asks for a cycle; only pure Q&A, discussion, and status checks stay outside. Never load while a contract is already active (resume that run instead). If the operator declines a cycle you judged necessary, comply and record the declined opening via the amber-mark skill.
---

# amber:planning (pi)

This is Amber's `planning` skill on the **pi** host. Read
[the shared skill](../../../skills/planning/SKILL.md) in full now and follow it
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
