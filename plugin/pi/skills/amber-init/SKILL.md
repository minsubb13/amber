---
name: amber-init
description: Port Amber into a project zone - scan the code into an oracle map, interview the operator until tensions are exhausted, generate or map the fixed documents, and finish the sensor install. Invoke ONLY on an explicit operator request to install, port, or initialize Amber in a project ("install amber here", "port amber into this project"); never by your own judgment. Do not open a planning cycle for init itself - init is the bootstrap act and its human gate is the ratification beat.
---

# amber:init (pi)

This is Amber's `init` skill on the **pi** host. Read
[the shared skill](../../../skills/init/SKILL.md) in full now and follow it
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
