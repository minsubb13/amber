# reports.md - the shapes of operator reports

Read `## The four questions` and `## Common rules`, plus only the section for
the report being written right now:
- `## Approval report` in `set` step 5.
- `## Completion report` when signalling `done` ([protocol](protocol.md), "Completion").
- `## Stop report` when stopping for a question or blocker.

Approval and completion reports answer the four questions in order; stop reports
name the work in one sentence and go straight to the decision. Optional parts
appear only when they have content. Apply [protocol](protocol.md)
"Operator-facing voice" throughout.

## The four questions

- **What** - the work in 1-2 plain sentences as an operator-visible change, not
  a file list. A newcomer should understand the work from this part alone
  without jargon, tool names, or file paths unless needed. In stop and
  completion reports, state the whole work, not the last step taken.
- **Why** - the problem or need behind the work, with one piece of evidence.
- **How** - only the key steps carrying the work, each with who does it and how
  it is checked.
- **Result** - the end state seen from the operator's side (what is different,
  what the operator now has), not the artifacts produced. In the completion
  report, also state what became of each operator decision made for this run.

Give each part a short heading in the operator's language phrased as the
question it answers ("What this work is", "Why", "How", "When it is done").
Open directly with **What** - no preamble.

## Common rules

- **Plain operator language.** Write natively in the operator's language so a
  non-engineer can follow. Omit harness coined terms, step/unit numbers,
  finding ids, and internal jargon (neither named nor softened). Keep only names
  the operator needs to act (a command, PR, or file to open), defined on first
  use with a brief example when helpful.
- **Results over process.** State outcomes that serve a decision or action, not
  routine worker steps (full rule quotes, commit messages, line numbers,
  self-check counts). Put detailed records in run files with a one-line pointer.
- **Short paragraphs.** Keep paragraphs to ~3 sentences; use lists only for
  parallel items and tables only for comparisons.
- **Provenance.** Tag numbers and claims with their provenance (`verified` /
  `quoted` / `unverified`), copied directly from the source record without
  recounting or rounding. Write explicit dates, not "yesterday" or "today".
- **One question, last.** End any report that needs an answer with a single
  question; gather interpretations to confirm and changeable defaults right
  above it, never scattered in the body.
- **Line budget.** Fit approval and stop reports in ~20 lines and completion
  reports in ~30 lines (1-3 sentences or a short list per part; put longer
  material in run files with a one-line pointer). Shortening compresses without
  dropping completion conditions, stop points, or operator actions; reporting
  "in full" at completion means answering the four questions and showing the
  deliverable (or its essential part if long).

## Approval report

Written after committing the scope document so the operator can judge the
go-ahead from this report alone:
1. **What this work is** - the work in plain words.
2. **Why** - the problem in 1-2 sentences, with one piece of evidence.
3. **How** - numbered key steps, one line each: who does it (model or operator)
   and how it is checked.
4. **When it is done** - the end state from the operator's side, plus every
   completion condition grouped and named in a few words (full wording stays in
   the scope document).
5. **What I will not do** *(when any)* - deliberate non-goals and what stays
   untouched (skip obvious negatives).
6. **For you to decide** *(when any)* - changeable model defaults,
   interpretations to confirm, points where the run waits for the operator, and
   how foreseeable events (a dependency merges first, a check fails, a review
   finds a must-fix) are handled.
7. **Close** - the scope document path in one line, then the go-ahead question
   ("Shall I go ahead with this scope?").

## Completion report

Settled during the pre-signal review and sent once as the final message after
the completion signal runs as the last tool call:
1. **What was done** - the work in plain words and the verdict against the
   original request (met, or met with a stated caveat).
2. **Why** - the goal the run set out to reach in 1-2 sentences.
3. **How** - key steps, what changed where (one line per place), and how it was
   checked: commands run, numbers with provenance, and any negative control
   (such as a break-and-revert test).
4. **Result** - what changed from the operator's side, the deliverable itself
   (in full when short, or its essential part plus path), what became of each
   operator decision, and any notable deviation, risk, or broken rule.
5. **What you need to do** *(when any)* - numbered actions with who does what
   and exact commands when needed.
6. **What this does not answer** - limits of the result.

## Stop report

Written when stopping for a question, blocker, or out-of-scope decision (leads
with the decision without repeating the approval report's why/how/conditions):
1. **What I was doing** - the whole work in 1-2 plain sentences and where it stands.
2. **Why I stopped** - what happened with evidence, what must be decided, and a
   plain definition of any unfamiliar rule or term that caused the stop.
3. **Options** - recommended option first, each with outcome and cost.
4. **Current state** - what is done and what is left half-done.
5. **Question** - one question answerable with yes, no, or one option.
