---
name: mark
description: Record one Amber cycle event in the ledger, from anywhere in a turn. Invoke with skip arguments for a declined gate or a no-contract opening verdict, finding arguments for a verification finding whose disposition is settled, or hold arguments to announce a legitimate stop while plan units are still open. Claude Code records the Skill invocation automatically; Codex executes the recorder described here. Not for completion - that is the `record.cjs done` completion signal on both hosts.
---

# mark - cycle event record

Read [host integration](../../references/hosts.md) and use the current host's
recording path. Arguments are `skip - <subject> - <reason>`,
`finding - <finding> - <disposition>`, or `hold - U<n> - <reason>` (the unit
you are on and why you must stop: waiting on the operator, budget reached,
an out-of-contract decision). A hold lets the next stop through once; the
Stop hook resumes sending you back afterwards while units stay open. The
external form `hold - U<n> - external: <job>` (a reason starting with
`external:`) marks the unit as waiting on an external job - a background
test run, a workflow, a long computation - and is not consumed by a stop:
every stop passes while it stands, with no cap, until the unit's next
`start|verified|failed` transition releases it or a new hold replaces it.
The S0/S1 briefing and /amber:status show it as
`external hold on U<n> since <ts>: <text>`.

- **Claude Code:** the S3 hook records the Skill tool invocation automatically.
  Do not run the recorder CLI as well.
- **Codex:** actually execute the recorder's `mark skip`, `mark finding`, or
  `mark hold` command once with the supplied event text, and check that it
  succeeds.
  Do not run `invoke mark`. Loading this skill has not written the record.

Do not repeat the event as a bare text marker. After recording, continue the
work you were doing.
