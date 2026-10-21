---
name: amber-set
description: Write and finalize an Amber per-run contract from a completed planning dialogue - draft the contract document and its plan, check the machine rows, commit, report, and wait for the operator's approval utterance; on an explicit approval create .amber/active.json and start the run. Invoke automatically when planning's elicitation is exhausted, or when the operator asks to finalize a hand-written draft. Approval is the operator's explicit utterance in conversation - never create the pointer without one.
---

# amber:set (pi)

This is Amber's `set` skill on the **pi** host. Read
[the shared skill](../../../skills/set/SKILL.md) in full now and follow it
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
