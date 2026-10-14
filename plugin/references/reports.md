# reports.md - the shapes of operator reports

Read this reference before writing any of the three reports addressed to the
operator: the approval report (set, step 5), the completion report (run
protocol, "Completion"), and the stop report (a contract's "Question
handling", or any stop that brings the operator a decision). Each report has
a fixed order of parts, so the operator finds the same thing in the same
place every time. The rules below apply to all three; the run protocol's
operator-facing voice applies on top of them.

## Common rules

- **Conclusion first.** The first line says the one thing the operator needs:
  what will be done (approval), whether the original request is met
  (completion), or that work stopped and what must be decided (stop). Never
  open with a file path, a commit, or an internal step number.
- **Fixed parts, in order.** Write each part under a short heading in the
  operator's language, in the order given below. A part with nothing to say
  stays as one line ("none") instead of disappearing.
- **Only what serves a decision or an action.** Leave out details that only
  serve the worker's own record - rule wording quoted in full, commit message
  text, line numbers, counts of self-checks. Put them in the run's files and
  point to the file in one line when the operator may want it.
- **Separate weights.** Things of different weight go in different parts:
  what is settled, what the operator must do, what is out of scope, what went
  wrong. What the operator must do always has its own part.
- **Short paragraphs.** Keep a paragraph to about three sentences. Use a list
  only for parallel items, a table only for results that compare.
- **Define before use.** A technical term the operator may not know is
  defined where it first appears, with a small concrete example first when
  that helps. No metaphors in place of the definition.
- **Provenance.** Numbers and claims carry their provenance (verified /
  quoted / unverified).
- **One question, last.** A report that needs an answer ends with exactly one
  question. Interpretations to confirm and defaults the operator may change
  are gathered in the part right above it, never scattered through the body.
- **Length.** Aim for one screen. When the work is large, shorten each part
  rather than drop a part. A completion reported "in full" means every part
  is present and the deliverable is shown, not that every detail is
  repeated.

## Approval report

Written after the scope document is committed; the operator must be able to
judge the go-ahead from this report alone.

1. **First line** - what will be done and what the operator gets at the end.
2. **Why** - the problem in one or two sentences, with one piece of evidence.
3. **What I will do** - numbered steps, one line each: who does it (the
   model or the operator) and how that step is checked.
4. **When it counts as done** - the completion conditions in plain words.
5. **What I will not do** - deliberate non-goals (things that could
   reasonably be expected but are left out) and what stays untouched. Skip
   obvious negatives.
6. **For you to decide** - defaults the model chose that the operator may
   change, interpretations to confirm, and the points where the run will
   wait for the operator.
7. **Close** - the scope document's path in one line, then the go-ahead
   question ("Shall I go ahead with this scope?").

## Completion report

Written as the run ends, before the completion signal.

1. **First line** - the verdict against the original request (met, or met
   with a stated caveat) and the one next action the operator owns, if any.
2. **What you get** - the deliverable itself: the whole of it when short,
   otherwise its essential part and where the rest is.
3. **What changed where** - one line per place: what changed and why.
4. **How it was checked** - what was run and what it showed, with numbers
   and provenance; a deliberate break-and-revert or other negative control
   when there was one.
5. **What differed from the plan** - only what the operator should know: a
   risk, a changed decision, a broken rule. Notes for the worker's own record
   stay in the run's files.
6. **What you need to do** - numbered actions with who does what, and the
   exact command when one is needed.
7. **What this does not answer** - the limits of the result.

## Stop report

Written when work stops to bring the operator a question, a blocker, or a
decision outside the scope. This is the three-part SBAR order - what
happened, the options, the recommendation - framed by a first line and one
question.

1. **First line** - that the work stopped, where the whole job stands in
   plain words (for example, "the research is done; I stopped before the
   first code change"), and what must be decided.
2. **What happened** - the situation and its evidence. Define here any rule
   or term the operator may not know; a stop caused by a rule the operator
   never heard of must say what the rule is for.
3. **Options** - the recommended option first, each with its consequence and
   cost.
4. **Current state** - what was left half-done and in what state, or "none".
5. **Question** - one question the operator can answer with yes, no, or one
   option.
