// The recorder's command line without I/O: the usage text, the skills, mark
// kinds and unit commands it accepts, and reading an option's words.

import type { InvokedSkill, MarkKind } from './types.cjs';

const USAGE = [
  'Usage:',
  '  node record.cjs invoke <planning|set|init|status|audit> [args...]',
  '  node record.cjs mark <skip|finding|hold> <text...>',
  '  node record.cjs unit init <plan-path> [--force]',
  '  node record.cjs unit claim <U#>',
  '  node record.cjs unit start <U#>',
  '  node record.cjs unit verified <U#> --evidence <text...> (required) [--out-of-scope <path>=<reason> ...]',
  '  node record.cjs unit failed <U#> --evidence <text...> (required)',
  '  node record.cjs unit hold <U#> --reason <text...>',
  '  node record.cjs done --review <text...> [--goal <text...>] --summary <text...>',
  '                  [--out-of-scope <path>=<reason> ...]',
  '',
  'Records Codex skill invocations, cycle events, and loop-body unit events in the',
  'shared Amber ledger; unit commands also maintain <zone>/.amber/progress.json.',
  'invoke/mark require CODEX_THREAD_ID; unit commands take the session id from',
  'AMBER_SESSION_ID, CODEX_THREAD_ID, or CLAUDE_CODE_SESSION_ID (first one set),',
  'otherwise the session the E1 hook registered for this run (its id and model',
  'reach the ledger row). Uses the current directory and AMBER_HOME (default',
  '~/.amber).',
  '',
  'unit verified and unit failed refuse a missing or blank --evidence and any flag',
  'they do not read (its text would otherwise be dropped without a trace).',
  '',
  'unit hold passes the next stop once. A --reason starting with "external:" is a',
  'waiting-on-an-external-job hold: every stop passes until that unit next starts,',
  'is verified, or fails, or a new hold replaces it.',
  '',
  'done writes the completion signal (<zone>/.amber/done.json) that the Stop hook',
  'consumes: run it as the last tool call before the completion report, and only',
  'after a fresh semantic review found every required condition met by current',
  'evidence. It declares the governed work unit itself complete - never that an',
  'assessment, report, or attempt finished; incomplete, blocked, waiting, and',
  'status-only turns run nothing. --goal is required under an active contract',
  '(the goal-test result) and refused without one; the command is refused while',
  'plan units are open or the pointer is broken. A passed completion releases the',
  'contract by itself.',
  '',
  'unit verified and done compare the files git reports as changed in the tree the',
  'command runs in (commits since the contract file was added, working-tree changes,',
  'untracked files; paths already dirty at unit init excepted) with the contract',
  'write-scope. An undeclared file outside every write-scope refuses the command.',
  'Declare each with --out-of-scope <path>=<reason> (repeatable; a glob is accepted);',
  'declarations are recorded in progress.json and the ledger.',
].join('\n');

/** The skill a `record.cjs invoke <name>` records, or null. */
function invokedSkillOf(name: string | undefined): InvokedSkill | null {
  if (name === undefined) return null;
  switch (name) {
    case 'planning':
    case 'set':
    case 'init':
    case 'status':
    case 'audit':
      return name;
    default:
      return null;
  }
}

/** The cycle-event kind of a `record.cjs mark <kind>`, or null. */
function markKindOf(name: string | undefined): MarkKind | null {
  if (name === undefined) return null;
  switch (name) {
    case 'skip':
    case 'finding':
    case 'hold':
      return name;
    default:
      return null;
  }
}

/** A `record.cjs unit <command>` the recorder accepts. */
type UnitCommand = 'init' | 'claim' | 'start' | 'verified' | 'failed' | 'hold';

function unitCommandOf(name: string | undefined): UnitCommand | null {
  if (name === undefined) return null;
  switch (name) {
    case 'init':
    case 'claim':
    case 'start':
    case 'verified':
    case 'failed':
    case 'hold':
      return name;
    default:
      return null;
  }
}

/** The words after a flag up to the next flag, joined; '' without the flag. */
function optionText(rest: readonly string[], flag: string): string {
  const i = rest.indexOf(flag);
  if (i === -1) return '';
  const value: string[] = [];
  for (const word of rest.slice(i + 1)) {
    if (word.startsWith('--')) break;
    value.push(word);
  }
  return value.join(' ').trim();
}

export = { USAGE, invokedSkillOf, markKindOf, unitCommandOf, optionText };
