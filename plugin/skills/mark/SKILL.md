---
name: mark
description: Record one Amber cycle event in the ledger, from anywhere in a turn. Invoke with skip arguments for a declined gate or a no-contract opening verdict, finding arguments for a verification finding whose disposition is settled, or hold arguments to announce a legitimate stop while plan units are still open. Claude Code records the Skill invocation automatically; Codex executes the recorder described here. Not for completion - that is the `record.cjs done` completion signal on both hosts.
---

# mark - cycle event record

Record one cycle event in the ledger and immediately resume work.

## Input and preconditions

- Read [host integration](../../references/hosts.md) (`## Skill names and package root`
  and `## Invocation and event records`).
- Arguments: `skip - <subject> - <reason>`, `finding - <finding> - <disposition>`,
  or `hold - U<n> - <reason>` (waiting on the operator, budget reached, or
  out-of-contract decision), including `hold - U<n> - external: <job>` (see
  [run protocol](../../references/protocol.md) `## Loop body`).

## Procedure

1. **Record on the current host.**
   - **Claude Code:** the S3 hook records the Skill tool invocation
     automatically; do not run `record.cjs`.
   - **Codex and pi:** run `record.cjs` (`mark skip`, `mark finding`, or `mark hold`)
     once with the supplied event text and verify exit 0. Do not run
     `invoke mark` (loading this skill does not write the record).

   *Exit:* event recorded (by S3 hook on Claude Code or `record.cjs` on Codex and pi).
2. **Continue.** Resume work without repeating the event as a bare text marker.
