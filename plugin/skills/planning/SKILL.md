---
name: planning
description: Open an Amber cycle - judge inside whether the work needs a contract, then either elicit the material for one or record a no-contract verdict and proceed. Invoke for any work request - anything that would change zone files or produce a deliverable - or when the operator explicitly asks for a cycle; only pure Q&A, discussion, and status checks stay outside. Never invoke while a contract is already active (resume that run instead). If the operator declines a cycle you judged necessary, comply and record the declined opening via the amber:mark skill.
allowed-tools: Read, Bash, Grep, Glob
---

# planning - elicitation

Goal: decide if a request needs a contract, and if so, elicit settled material
for `set` (`planning -> set -> execution`: `set` writes the contract, optional
plan, and approval report, creating `.amber/active.json` on approval).

## Principles

- Open by default on any work request: announce in one line what you will
  check ("a few things to check before I start"), not the mechanism. If
  declined, invoke `amber:mark` with `skip - declined opening - <reason>`.
- `planning` is not a passive transcription clerk; it checks the operator's
  premises and design judgment before freezing a boundary. Mechanical blocks
  bind the model; senior pushback to the operator is **advisory** (non-coercive).
- One run per zone. If an active run here is not driven by this session, state
  that first and offer: open an independent zone via
  `git worktree add ../<slug> -b <slug>` or wait for the run to close. Never
  prepare a second contract in an active tree or run `unit` commands unless
  taking it over (`hosts.md`).
- Every question must cite evidence (`file:line`, command output, git history).
- Record cycle events via `amber:mark` (`skip - declined opening - <reason>`,
  `skip - opening verdict - no contract: <reason>`; see `mark/SKILL.md`,
  `hosts.md`), never as bare text lines.

## Input and preconditions

- Read `## Skill names and package root` and `## Invocation and event records`
  in [hosts.md](../../references/hosts.md), and `## Load-bearing test` and
  `## Operator-facing voice` in [protocol.md](../../references/protocol.md). On
  Codex, run `invoke planning` once; on Claude Code, use the automatic Skill record.
- Input: any work request that changes zone files or produces a deliverable.

## Procedure

0. **Opening verdict.** Ground lightly (git status, touched files) and judge if
   a contract protects anything (scope, gated decisions, rework).
   - **No contract.** For routine upkeep (doc sync, formatting, small fix),
     state the verdict in one line, record
     `skip - opening verdict - no contract: <reason>` via `amber:mark` (fixed
     audit prefix), and proceed immediately.
   - **Route.** Otherwise route before eliciting: **development** (code/doc
     change with stateable completion condition) or **research** (promote /
     hold / reject verdict with separate success/failure definitions); ask if
     unclear.
   - **Opening questions.** Ask: (1) known or unknown domain - can completion
     conditions and forbidden rows be stated now? (2) if unknown: learn this
     run or defer to an oracle (per claim; both legitimate). Record uncertain
     replies ("I don't know", "you decide") as assumptions with confidence,
     never settled decisions; accepted claims cannot rest on undisposed
     load-bearing assumptions.
   Exit: no-contract skip recorded, or route and opening questions posed.
1. **Ground.** Read touched zone state (git log/status, relevant docs) so every
   question cites evidence. Exit: evidence in hand.
2. **Elicit.**
   - **Tension list.** Track tensions between scanned facts and stated intent:
     `conflict` (fact vs statement), `gap` (unknown load-bearing matter), `unanswered` (open/vague reply), and `solo-decision` (choice the model would settle alone).
      Self-answer from code/git history first; if answered (`verdict: "self-answered"`),
      drop the question and keep the row with evidence. Offer options plus a
      free-form escape. Keep unanswered/vague rows open until settled or explicitly deferred by the operator.
   - **Premise and proportionality check (senior pushback).** When code or git
     history shows the stated approach is disproportionate (over-engineered,
     premature abstraction, duplicating an existing mechanism) or rests on a
     fragile/unverified premise, raise a load-bearing question (`conflict` or
     `gap`, `verdict: "ask"`, `load_bearing: true`) with: (1) concrete evidence
     (`file:line`, commit history, failure mode), (2) a **simpler alternative**
     recommended first, and (3) the original direction as a valid choice.
     **Advisory non-coercion**: if the operator confirms their original
     direction after seeing the trade-off, do not repeat the objection - record
     it in `## Settled decisions` with the date and proceed.
   - **Solo-decision triage.** Applies on both routes to every row the model
     would settle alone (`solo-decision`, or a `gap`/`conflict` closed by
     judgment), using `protocol.md`'s load-bearing test:
     - **Always ask (`load_bearing: true`, `verdict: "ask"`)** - even when a
       defensible default exists in code or convention (evidence supplies the
       recommended option, never settles the row; when unclear, ask):
       1. Anything irreversible, destructive, or safety/security-relevant.
       2. Any cross-cutting choice the operator keeps living with: public interface or configuration surface, packaging or distribution, external dependency or pinned version (including choosing not to add one), data, file, or schema shape.
     - **Other load-bearing rows (`load_bearing: true`, `verdict: "ask"`)**:
       present the recommended default first plus its trade-off for one-beat
       settlement; never resolve a load-bearing row to an unseen default.
     - **Non-load-bearing rows (`load_bearing: false`, `verdict: "default"`)**:
       do not ask; keep the row in the tension list with its tunable default
       and reversibility evidence for `set`'s `## Discretion` section.
   - **Independent review unit.** Ask once per contract whether independent review is needed before integration. Recommend when conditions rest on judgment/docs or changes are hard to reverse or touch interfaces/security; omit when all oracles are mechanical and the change is small. Record reviewer and choice in settled decisions (`hosts.md`).
   - **Work units.** For a single cohesive unit (1-2 completion conditions, no parallel subagent units, no independent review unit), mark it for a **plan-less (single-file) contract** (`set` writes only `-contract.md` without `-plan.md` or `unit init`; requires a clean working tree or `--out-of-scope "<path> - pre-existing"` on `done` since `progress.json` is absent). Otherwise settle work units (`title`, zone-relative `scope` globs, `oracle`, `after`) and final integration check in the main checkout (`protocol.md` "Loop body").
   - **Research route.** Also elicit in order: research question; candidate
     claims with promote / hold / reject criteria; the one kill-question
     (answered first); oracles with reproducibility fields (paper version,
     reference commit, data hash, KAT version); per-claim budgets/stop lines;
     learn-or-defer per claim; and whether a multi-session topic doc
     (`templates/mission.md`) is needed.
   Exit: tension list exhausted (every row settled or explicitly deferred by the operator).
3. **Hand off to set.** Invoke `amber:set` in this session to write the
   contract (and `-plan.md` unless plan-less). Never draft them or write
   `.amber/active.json` yourself. Exit: `amber:set` invoked.

## Completion

Ends when the no-contract skip is recorded (step 0) or `amber:set` is invoked
(step 3). Writes no contract, plan, or pointer.
