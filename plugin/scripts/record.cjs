#!/usr/bin/env node
const { runS3, recordUnitEvent, contractInfo, writeDoneSignal, driverOfRun } = require('../hooks/amber-hook.cjs');
const progress = require('../hooks/progress.cjs');
const scope = require('../hooks/scope-check.cjs');

const USAGE = [
  'Usage:',
  '  node record.cjs invoke <planning|set|init|status|audit> [args...]',
  '  node record.cjs mark <skip|finding|hold> <text...>',
  '  node record.cjs unit init <plan-path> [--force]',
  '  node record.cjs unit claim <U#>',
  '  node record.cjs unit start <U#>',
  '  node record.cjs unit verified <U#> --evidence <text...> [--out-of-scope <path>=<reason> ...]',
  '  node record.cjs unit failed <U#> --evidence <text...>',
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

const UNIT_EVENTS = ['init', 'claim', 'start', 'verified', 'failed', 'hold'];

function optionText(rest, flag) {
  const i = rest.indexOf(flag);
  if (i === -1) return '';
  const value = [];
  for (let j = i + 1; j < rest.length; j += 1) {
    if (rest[j].startsWith('--')) break;
    value.push(rest[j]);
  }
  return value.join(' ').trim();
}

function unitCommand(name, rest) {
  if (!UNIT_EVENTS.includes(name)) throw new Error('invalid unit command\n' + USAGE);
  const cwd = process.cwd();
  const info = contractInfo(cwd);
  if (info.broken) throw new Error('active contract pointer is broken: ' + info.error);
  // Session identity: an explicit environment id wins
  // (AMBER_SESSION_ID, CODEX_THREAD_ID, then CLAUDE_CODE_SESSION_ID - Claude
  // Code exports it to the tool shell, equal to the hooks' session_id, and
  // subagents inherit it); otherwise the recorder reads back the driver E1
  // registered for this run just before the command.
  const envSessionId = (process.env.AMBER_SESSION_ID || process.env.CODEX_THREAD_ID ||
    process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  const driver = envSessionId ? null : driverOfRun(info.boundaryFile);
  const sessionId = envSessionId || (driver && driver.sessionId) || 'shell';
  if (name === 'init') {
    const plan = rest.find((a) => !a.startsWith('--'));
    if (!plan) throw new Error('unit init needs the plan path\n' + USAGE);
    const p = progress.initProgress(info.root, plan, info.boundaryFile, rest.includes('--force'),
      scope.snapshot(cwd));
    const count = Object.keys(p.units).length;
    recordUnitEvent(sessionId, cwd, 'init', count + ' unit(s) from ' + p.plan,
      { contract: info.boundaryFile, units: count });
    process.stdout.write('amber: progress.json initialized with ' + count + ' unit(s): ' +
      Object.keys(p.units).join(', ') + '\n');
    return;
  }
  const id = rest[0];
  if (!/^U\d+$/.test(id || '')) throw new Error('unit ' + name + ' needs a unit id like U1\n' + USAGE);
  const p = progress.loadProgress(info.root);
  if (!p) throw new Error('no progress.json in ' + info.root + '; run `unit init <plan>` first');
  if (p.broken) throw new Error('progress.json is broken: ' + p.error);
  if (name === 'claim') {
    const unit = p.units[id];
    if (!unit) throw new Error('unknown unit ' + id);
    if (unit.agent_id) {
      process.stdout.write('amber: unit ' + id + ' claimed by subagent ' + unit.agent_id + '\n');
    } else {
      process.stdout.write('amber: warning - the claim of ' + id + ' was not observed by a hook ' +
        '(no subagent context or no active contract); the unit remains unclaimed\n');
    }
    return;
  }
  const text = optionText(rest.slice(1), name === 'hold' ? '--reason' : '--evidence');
  // verified advances the run, so the changed files are compared with the
  // write-scope first; an undeclared out-of-scope file refuses the transition.
  let scopeFields = {};
  if (name === 'verified' && info.writeScopes.length > 0) {
    const result = scope.check({
      cwd, writeScopes: info.writeScopes, boundaryRel: info.boundaryRel,
      preexisting: p.preexisting, declarations: scope.parseDeclarations(rest.slice(1)),
    });
    if (result.undeclared.length > 0) {
      throw new Error(scope.refusal(result, info.boundaryFile, info.writeScopes, 'unit verified ' + id));
    }
    scopeFields = scope.recordFields(result.declared);
  }
  progress.applyEvent(p, name, id, {
    by: sessionId, evidence: text, reason: text, out_of_scope: scopeFields.out_of_scope,
  });
  progress.saveProgress(info.root, p);
  const fields = Object.assign({ contract: info.boundaryFile, unit: id }, scopeFields);
  if (name === 'verified' || name === 'failed') fields.evidence = text.slice(0, 200);
  if (name === 'hold') {
    fields.reason = text.slice(0, 200);
    if (p.hold && p.hold.kind) fields.kind = p.hold.kind;
  }
  recordUnitEvent(sessionId, cwd, name, id + (text ? ' - ' + text : ''), fields);
  process.stdout.write('amber: unit ' + id + ' -> ' + (name === 'hold' ? 'hold' : p.units[id].status) + '\n');
}

// The completion signal. Form checks live here, at write time, so the Stop
// hook only has to judge the pointer and the worktrees.
function doneCommand(rest) {
  const cwd = process.cwd();
  const info = contractInfo(cwd);
  if (info.broken) {
    throw new Error('active contract pointer is broken: ' + info.error +
      '; fix or remove it before signalling completion');
  }
  const review = optionText(rest, '--review');
  const goal = optionText(rest, '--goal');
  const summary = optionText(rest, '--summary');
  if (!review || !summary) throw new Error('done needs --review and --summary\n' + USAGE);
  if (info.boundaryFile && !goal) {
    throw new Error('done under contract ' + info.boundaryFile +
      ' needs --goal <goal-test result>\n' + USAGE);
  }
  if (!info.boundaryFile && rest.includes('--goal')) {
    throw new Error('no active contract in ' + info.root + '; omit --goal');
  }
  if (!info.boundaryFile && rest.includes('--out-of-scope')) {
    throw new Error('no active contract in ' + info.root + '; omit --out-of-scope');
  }
  let scopeFields = {};
  if (info.boundaryFile) {
    const p = progress.loadProgress(info.root);
    if (p && p.broken) throw new Error('progress.json is broken: ' + p.error);
    const open = p ? progress.openUnits(p) : [];
    if (open.length > 0) {
      throw new Error('units still open: ' + open.join(', ') +
        ' - verify them (or record a hold and stop) before signalling completion');
    }
    // The changed files of the whole run against the write-scope; declared
    // out-of-scope files ride in the signal and S2 records them.
    if (info.writeScopes.length > 0) {
      const result = scope.check({
        cwd, writeScopes: info.writeScopes, boundaryRel: info.boundaryRel,
        preexisting: p ? p.preexisting : [], declarations: scope.parseDeclarations(rest),
      });
      if (result.undeclared.length > 0) {
        throw new Error(scope.refusal(result, info.boundaryFile, info.writeScopes, 'done'));
      }
      scopeFields = scope.recordFields(result.declared);
    }
  }
  const target = info.boundaryFile || 'request';
  writeDoneSignal(info.root, Object.assign({ target, review, goal: goal || null, summary }, scopeFields));
  process.stdout.write('amber: completion signal written for ' + target +
    '; end the turn with the completion report (no marker lines)\n');
}

function main(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const [command, name, ...rest] = args;
  if (command === 'unit') {
    unitCommand(name, rest);
    return;
  }
  if (command === 'done') {
    doneCommand(name === undefined ? [] : [name, ...rest]);
    return;
  }
  let skill;
  let skillArgs;
  if (command === 'invoke' && ['planning', 'set', 'init', 'status', 'audit'].includes(name)) {
    skill = 'amber:' + name;
    skillArgs = rest.join(' ').trim();
  } else if (command === 'mark' && ['skip', 'finding', 'hold'].includes(name) && rest.join(' ').trim()) {
    skill = 'amber:mark';
    skillArgs = name + ' - ' + rest.join(' ').trim();
  } else {
    throw new Error('invalid recording arguments\n' + USAGE);
  }
  const sessionId = (process.env.CODEX_THREAD_ID || '').trim();
  if (!sessionId) throw new Error('CODEX_THREAD_ID is required; run this command inside the Codex session being recorded');
  runS3({
    session_id: sessionId,
    cwd: process.cwd(),
    tool_input: { skill, args: skillArgs },
  });
  process.stdout.write('amber: recorded ' + command + ' ' + name + '\n');
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write('amber: ' + err.message + '\n');
  process.exitCode = 1;
}
