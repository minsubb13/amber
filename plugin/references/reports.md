# reports.md - the shapes of operator reports

Read this reference before writing any of the three reports addressed to the
operator: the approval report (set, step 5), the completion report (run
protocol, "Completion"), and the stop report (a contract's "Question
handling", or any stop that brings the operator a decision). The approval
and completion reports answer the same four questions, in this order: what
the work is, why it is done, how it is done, and what the result is. The
stop report names the work in a sentence and goes straight to the decision.
Parts beyond those appear only when they have content. Every report is
short: the reader's attention is limited. The run protocol's operator-facing
voice applies on top of the rules below.

## The four questions

- **What** - the work itself, in one or two plain sentences, as a change the
  operator would notice, not as a list of files. Someone who has not seen the
  project should understand what the work is from this part alone. No jargon
  here: no tool, library, or file names unless the operator needs them. In
  the stop and completion reports this is the whole work, not the last step
  taken.
- **Why** - the problem or need behind the work, with one piece of evidence.
- **How** - the key steps only, each with who does it and how it is checked.
  A long list hides what matters; keep the steps that carry the work.
- **Result** - the state of things once the work is done, seen from the
  operator's side (what is different, what the operator now has), not the
  artifacts produced. In the completion report, also take each decision the
  operator made for this run and say what became of it.

Write each part under a short heading in the operator's language, phrased as
the question it answers (for example "What this work is", "Why", "How",
"When it is done"). Open with the What part: no preamble before it.

## Common rules

- **The operator's language, plain words.** Write in the operator's
  language as a native speaker would, from the first line to the last, in
  words a non-engineer could follow. Leave internal labels out: the
  harness's coined terms, step or unit numbers, finding ids, and project
  jargon the operator would not recognize - say what the thing is instead. A
  name the operator needs in order to act (a command, a pull request, a file
  to open) stays, defined where it first appears when needed, with a small
  concrete example when that helps. Do not soften internal logic into
  friendlier words; leave it out.
- **Results, not process; only what serves a decision or an action.** Say
  what came out, not the routine steps that produced it. Leave out details
  that only serve the worker's own record - rule wording quoted in full,
  commit message text, line numbers, counts of self-checks. Put them in the
  run's files and point to the file in one line when the operator may want
  it.
- **Short paragraphs.** Keep a paragraph to about three sentences. Use a list
  only for parallel items, a table only for results that compare.
- **Provenance.** Numbers and claims carry their provenance (verified /
  quoted / unverified). Copy a number from the record that holds it; do not
  recount or round it. Write dates as dates, not as "yesterday" or "today".
- **One question, last.** A report that needs an answer ends with exactly one
  question. Interpretations to confirm and defaults the operator may change
  are gathered in the part right above it, never scattered through the body.
- **Short.** An approval or stop report fits in about 20 lines and a
  completion report in about 30; each part is one to three sentences or a
  short list. When more is needed, it goes in the run's files with a
  one-line pointer. Shortening compresses, it never drops: a completion
  condition, a point where the run stops to ask, and a fact the operator
  must act on are still there, named in a few words. A completion reported
  "in full" means the four questions are answered and the deliverable is
  shown (its essential part when it is long), not that every detail is
  repeated.

## Approval report

Written after the scope document is committed; the operator must be able to
judge the go-ahead from this report alone.

1. **What this work is** - the work in plain words.
2. **Why** - the problem in one or two sentences, with one piece of
   evidence.
3. **How** - numbered key steps, one line each: who does it (the model or
   the operator) and how that step is checked.
4. **When it is done** - the end state from the operator's side, then every
   completion condition, grouped and named in a few words; the full wording
   stays in the scope document.
5. **What I will not do** (when there is any) - deliberate non-goals (things
   that could reasonably be expected but are left out) and what stays
   untouched. Skip obvious negatives.
6. **For you to decide** (when there is any) - defaults the model chose that
   the operator may change, interpretations to confirm, the points where the
   run will wait for the operator, and what the run does when a foreseeable
   event happens (a dependency merges first, a check fails, a review finds a
   must-fix).
7. **Close** - the scope document's path in one line, then the go-ahead
   question ("Shall I go ahead with this scope?").

## Completion report

Written as the run ends, before the completion signal.

1. **What was done** - the work in plain words and the verdict against the
   original request: met, or met with a stated caveat.
2. **Why** - the goal the run set out to reach, in one or two sentences, so
   the verdict can be checked against it.
3. **How** - the key steps, what changed where (one line per place), and how
   it was checked: what was run and what it showed, with numbers and
   provenance, and a deliberate break-and-revert or other negative control
   when there was one.
4. **Result** - what is different now from the operator's side, the
   deliverable itself (the whole of it when short, otherwise its essential
   part and where the rest is), each operator decision and what became of
   it, and anything that differed from the plan that the operator should
   know (a risk, a changed decision, a broken rule).
5. **What you need to do** (when there is any) - numbered actions with who
   does what, and the exact command when one is needed.
6. **What this does not answer** - the limits of the result.

## Stop report

Written when work stops to bring the operator a question, a blocker, or a
decision outside the scope. It leads with the decision: the why, the steps,
and the conditions of the whole work were given in the approval report and
are not repeated here.

1. **What I was doing** - the whole work in one or two plain sentences and
   where it stands (for example, "the research is done; I stopped before
   the first code change").
2. **Why I stopped** - what happened, with its evidence, and what must be
   decided. Define here any rule or term the operator may not know; a stop
   caused by a rule the operator never heard of must say what the rule is
   for.
3. **Options** - the recommended one first, each with what it leads to and
   what it costs.
4. **Current state** - what is done, what was left half-done and in what
   state.
5. **Question** - one question the operator can answer with yes, no, or one
   option.
