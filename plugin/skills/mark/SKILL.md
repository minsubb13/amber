---
name: mark
description: Record one Amber cycle event in the ledger, from anywhere in a turn. Invoke with skip arguments for a declined gate or a no-contract opening verdict, finding arguments for a verification finding whose disposition is settled, or hold arguments to announce a legitimate stop while plan units are still open. Claude Code records the Skill invocation automatically; Codex executes the recorder described here. Not for completion - that is the `record.cjs done` completion signal on both hosts.
---

# mark - cycle event record

mark records one cycle event in the ledger, from anywhere in a turn, and
returns you to the work you were doing.

## Input and preconditions

- Read [host integration](../../references/hosts.md) and use the current
  host's recording path.
- Arguments are `skip - <subject> - <reason>`,
  `finding - <finding> - <disposition>`, or `hold - U<n> - <reason>` (the
  unit you are on and why you must stop: waiting on the operator, budget
  reached, an out-of-contract decision), including its external form
  `hold - U<n> - external: <job>`. What a hold lets through, and how
  briefings show an external hold, is in the run protocol's
  ["Loop body"](../../references/protocol.md).

## Procedure

1. **Record on the current host.**
   - **Claude Code:** the S3 hook records the Skill tool invocation
     automatically. Do not run the recorder CLI as well.
   - **Codex:** actually execute the recorder's `mark skip`, `mark finding`,
     or `mark hold` command once with the supplied event text, and check
     that it succeeds. Do not run `invoke mark`. Loading this skill has not
     written the record.

   Exit: the event is recorded - by the hook on Claude Code, by a
   successful recorder command on Codex.
2. **Continue.** Do not repeat the event as a bare text marker. Continue the
   work you were doing.

   Exit: the work resumes with no bare text marker.
