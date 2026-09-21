---
name: planning
description: Open an Amber cycle - judge inside whether the work needs a contract, then either elicit the material for one or record a no-contract verdict and proceed. Invoke for any work request - anything that would change zone files or produce a deliverable - or when the operator explicitly asks for a cycle; only pure Q&A, discussion, and status checks stay outside. Never invoke while a contract is already active (resume that run instead). If the operator declines a cycle you judged necessary, comply and record the declined opening via the amber:mark skill.
allowed-tools: Read, Bash, Grep, Glob
---

# planning - elicitation

Before the opening, read [host integration](../../references/hosts.md).
On Codex, execute its `invoke planning` recorder command once for this invocation;
on Claude Code, use the automatic Skill tool record only.

Goal: decide in the open whether one unit of work needs a contract, and when
it does, turn the operator's tacit intent into settled material a contract
can be written from. The cycle is planning -> set -> execution: planning verdicts and
elicits, set writes and finalizes the two documents and reports, and the
operator's explicit approval utterance starts execution - set creates the pointer
on that utterance. There is no separate start ritual.

Opening is the default for any work request - announce the opening in one
line. The operator may decline it; record a declined opening by invoking
the amber:mark skill with args `skip - declined opening - <reason>`.

A zone holds one run at a time. If the briefing says a run is active here
and this session is not one of its driving sessions, say so before anything
else and offer the two options: open the new work in its own linked
worktree (`git worktree add ../<slug> -b <slug>`, then run the cycle there -
a worktree with its own `.amber/active.json` is a zone of its own), or wait
for the active run to close. Never prepare a second contract for the same
tree while one is active; the operator's pointer would replace the running
one. Do not run unit commands in a run you are not driving unless you are
taking it over (resume) - that command registers this session as a driver.

0. **Opening verdict.** Ground lightly (git status, the files the request
   touches), then judge: would a contract protect anything here - scope to
   hold, decisions to gate, rework worth preventing? If not - routine
   upkeep such as doc sync, formatting, a small fix, where recording the
   result is enough - state the verdict to the operator in one line,
   invoke the amber:mark skill with args
   `skip - opening verdict - no contract: <reason>`
   (record it through the host's invocation path), and proceed with the work
   immediately; do not wait for confirmation (the operator can veto on
   sight). The prefix `opening verdict` is a fixed convention - the audit
   filters on it. When a contract is warranted, route it before eliciting:
   **development** when the deliverable is a change (code, documents) and
   the operator can state the completion condition now; **research** when
   the deliverable is a verdict (promote / hold / reject) and success and
   failure need separate definitions; when the call is unclear, ask the
   operator. The route picks the contract template set will use (set
   carries both skeletons).

   Two opening questions accompany the route. First: known or unknown
   domain - can the operator write the completion condition and the
   forbidden rows right now? Second, in an unknown domain: learn it this
   run, or defer to an oracle - allocatable per claim. Learning is a
   choice, never an obligation, and deferring is equally legitimate - the
   harness only proposes. Record an uncertain answer ("I don't know",
   "you decide") as an assumption with a stated confidence, never as a
   settled decision; an accepted claim must not rest on an undisposed
   load-bearing assumption. Then continue below.
1. **Ground.** Read the zone state the task touches (git log/status, the
   relevant documents). Every question you ask later must cite evidence
   (file:line, command output, git history) - a question without evidence
   does not qualify.
2. **Elicit.** Build a tension list between scanned facts and stated intent.
   Four kinds: conflict (fact vs statement), gap (load-bearing matter whose
   status or intent is unknown), unanswered (a submitted question still open
   or answered vaguely), solo-decision (something the model would otherwise
   decide alone). Before submitting a question, try to answer it yourself
   from code and git history; if self-answered, drop it but keep the row with
   the discarding evidence. Offer answer options plus a free-form escape.
   Unanswered and vague answers stay open until re-asked or the operator
   explicitly marks them deferred.

   Solo-decision triage: this applies to every row the model
   would otherwise settle alone, whatever kind it is filed under - a
   solo-decision row, or a gap or conflict you would close by your own
   judgment. Before such a row becomes a question, apply the load-bearing
   test set uses for the contract's polarity sentence - getting it wrong
   would invalidate the deliverable, force rework, or move the boundary:
   hard to reverse, visible in the deliverable's behavior or interface, in
   conflict with a discussed direction, or a surprise to the operator
   reading the diff. A row that fails the test does not become a question:
   record its default, marked tunable, for the contract's `## Discretion` section,
   together with the evidence that it is not load-bearing (the row stays in
   the list, like a self-answered one). A row that passes becomes a
   question presented as the recommended default first plus its trade-off,
   so the operator settles it in one beat. Two kinds of row stay questions
   even when a defensible default exists - and a self-answer from code or
   convention is such a default, not a closed row: evidence supplies the
   recommended option, it never settles the row on the operator's behalf.
   They are anything irreversible, destructive, or safety- or
   security-relevant, and any cross-cutting choice the operator keeps
   living with afterward - a public interface or configuration surface,
   packaging or distribution, an external dependency or pinned version
   (including the choice not to add one), a data, file, or schema shape.
   When the test is unclear, ask: a wrongly silenced operator costs more
   than one extra question. A load-bearing row never resolves to a default
   the operator did not see. The triage applies on both routes.

   Loop body: on either route, settle the work units the plan
   will carry - for each unit its title, the zone-relative write scope
   (globs), the oracle that verifies it, and the units it must follow
   (`after`). Units whose `after` is satisfied, whose scopes do not
   overlap another ready unit's, and which share nothing outside the tree
   (ports, databases, GPUs, the global ledger) run as parallel subagents
   in worktrees by default (host integration, "Parallel unit worktrees"); when any of the three is unclear, the unit
   runs serially. The plan's last unit is the integration check in the
   main checkout after every worktree is merged.

   On the research route, the elicitation additionally covers, in order:
   the research question itself; candidate claims with the promote / hold /
   reject criteria the operator can pre-commit to; the one kill-question
   (what would overturn the conclusion - it gets answered first); the
   oracles that will verify each verdict, with reproducibility fields
   (paper version, reference implementation commit, data hash, KAT
   version); per-claim budgets and stop lines; the learn-or-defer
   allocation per claim; and whether the question spans multiple sessions
   - if so, the run gets a topic document (set creates it from its
   `templates/mission.md`).
3. **Hand off to set.** When the tension list is exhausted - every row
   settled or explicitly deferred by the operator - invoke the amber:set
   skill in this session to write the contract and plan. Do not draft those
   documents yourself, and never create or edit `.amber/active.json` - the
   pointer is set's act, after the operator's approval utterance.

Record cycle events as they happen by invoking the amber:mark skill and
following its host-specific recording step, from anywhere in a turn. Args
`skip - <subject> - <reason>` cover a gate the operator declined and your
own no-contract opening verdict (step 0); args
`finding - <finding> - <disposition>` cover a verification finding whose
disposition is settled; args `hold - U<n> - <reason>` cover a legitimate stop
while plan units are still open. Do not restate recorded events as bare text
lines.
