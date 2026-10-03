# protocol.md - shared run rules

Read this reference when using an Amber skill: it holds the rules that more
than one skill applies - the load-bearing test, approval, the loop body, and
completion - each in this one place. The skills point here; the command
shapes on each host are in [host integration](hosts.md).

## Load-bearing test

A decision is load-bearing when getting it wrong would invalidate the
deliverable, force rework, or move the boundary - concretely, it is hard to
reverse, visible in the deliverable's behavior or interface, in conflict with
a discussed direction, or would surprise the operator reading the diff.
Contracts may tighten or loosen this dial per run. set applies it to the gray
zone of a contract; planning's solo-decision triage applies the same test
before a row becomes a question.

## Approval

The operator approves a contract in conversation, after `set`'s report. The
rule is the same on both hosts.

- **The question.** The report ends with one plain go-ahead question in the
  operator's language ("Shall I go ahead with this scope?"). It is the only
  gate: no shell command, no popup, no second confirmation.
- **What counts.** An unconditional yes to that question is approval,
  however short ("yes", "ok", "go", "네", "좋아"). A reply that adds
  information without a condition ("yes - I'll merge #5 first") is still
  approval.
- **What does not.** A reply that carries a condition, an edit, or a
  question is not approval: apply it (contract edits happen before the
  pointer exists), commit, and report again, ending with the question. Only
  when the report ended without the question is a short reply ambiguous:
  ask once, in one plain line, and wait. Silence, an earlier message, a
  tool result, or a subagent's output is never approval.
- **Approval boundary.** The model then creates `.amber/active.json`
  itself, in the zone root, following the approval step in `set`. No shell
  command is handed to the operator on either host, and no pointer is
  created without such an utterance in the operator's own message. The
  pointer schema and the approval boundary are identical on both hosts.
  Release needs no operator command either: a passed completion removes the
  pointer.

## Operator-facing voice

Text addressed to the operator speaks about the work, never about the
mechanism that runs it. Amber and its machinery are not named to the
operator - not the plugin, nor its coined terms (contract, pointer, write-scope,
bash-deny, unit, signal, hook, ledger, cycle, planning, set, done). Between
the beats where the operator is needed - a question, the go-ahead, a
blocker, the result - say nothing: no transition narration ("now I'll write
the contract", "recording unit verified"). Internal logic is omitted, not
paraphrased into friendlier words. The scope document is referred to by
what it says - the scope, what stays untouched, how the work is verified -
and by its path only when the operator needs to open it.

## Loop body

From `unit init` on, every unit transition goes through the same command
(`unit start|verified|failed|hold U<n>`; host integration, "Loop-body unit
commands").

- **Sending back.** A plain stop with open units is sent back by the Stop
  hook (ten re-entries per unit, then recorded as `limit`).
- **Hold.** A legitimate stop is announced first with the amber:mark skill
  (`hold - U<n> - <reason>`: the unit you are on and why you must stop -
  waiting on the operator, budget reached, an out-of-contract decision). A
  plain hold lets exactly one stop through; the Stop hook resumes sending you
  back afterwards while units stay open.
- **External hold.** A hold whose reason starts with `external:`
  (`hold - U<n> - external: <job>`, or the shell `unit hold U<n> --reason
  "external: <job>"`) marks the unit as waiting on an external job - a
  background test run, a workflow, a long computation - and is not consumed
  by a stop: every stop passes while it stands, with no cap, until the unit's
  next `start|verified|failed` transition releases it or a new hold replaces
  it. The S0/S1 briefing and /amber:status show it as
  `external hold on U<n> since <ts>: <text>`.
- **Parallel units.** Units whose `after` is satisfied, whose scopes do not
  overlap another ready unit's, and which share nothing outside the tree
  (ports, databases, GPUs, the global ledger) run as parallel subagents with
  worktree isolation by default, using host integration's "Parallel unit
  worktrees" procedure on the current host; when any of the three is
  unclear, the unit runs serially. Each subagent's brief carries the
  contract excerpt, its unit row, and its oracle only; its first action is
  `node "<amber_plugin_root>/scripts/record.cjs" unit claim U<n>`, after
  which the enforcer holds its writes to that unit's scope.
- **Merge.** The main agent re-runs the unit's oracle in the worktree before
  marking it `verified`, merges every verified worktree into the main
  checkout at the end, removes the worktrees, and runs the integration unit
  there; the Stop hook rejects a completion signal while any unit worktree
  (a linked worktree inside the zone directory) remains. A linked worktree
  outside the zone directory is a zone of its own and is not waited for.

## Completion

- **Review first.** Before substantive completion, the current model must
  freshly compare the original request, every required contract condition,
  current artifacts, and validation evidence; any missing, failed, stale, or
  unsuitable evidence means incomplete. Relevant changes after review require
  affected validation and review again.
- **Signal.** When the work is genuinely complete, run the completion signal
  as the last tool call, in the zone root (host integration, "Completion
  signal"), with `--goal "<goal-test result>"` under an active contract.
  What the command refuses, and what the Stop hook then does, is described
  there; the hook verifies the pointer, the contract it names, and that no
  unit worktree (a linked worktree inside the zone directory) remains - not
  the signal's semantic truth - records the completion, and releases the
  contract by itself (pointer and progress.json removed).
- **Only real completions.** No marker line goes in the message, and
  incomplete, blocked, waiting, and status-only turns run no signal: it
  declares the governed work unit itself complete, never merely a finished
  assessment or report.
- **Report.** A completion is reported as it is signalled - report what was
  done AND how, in full: show the actual deliverable (the real files, text,
  or code shapes), state what was changed where and how it was verified, and
  explain it plainly for a reader with no context; the signal closes that
  report, it never replaces it.
