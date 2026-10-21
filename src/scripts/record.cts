// The recorder the model runs from the shell: Codex skill invocations and
// cycle events (invoke, mark), the loop body's unit commands, and the
// completion signal (done). Every refusal is a message on stderr and exit
// code 1, written before anything is recorded.

import fs = require('node:fs');
import path = require('node:path');

import ledger = require('../lib/ledger.cjs');
import args = require('../lib/record-args.cjs');
import clock = require('../lib/clock.cjs');
import contracts = require('../lib/contract.cjs');
import done = require('../lib/done-signal.cjs');
import guards = require('../lib/guards.cjs');
import inputs = require('../lib/hook-input.cjs');
import model = require('../lib/progress-model.cjs');
import ownership = require('../lib/ownership.cjs');
import store = require('../lib/progress-store.cjs');
import scope = require('../hooks/scope-check.cjs');
import skillRecorder = require('../lib/skill-recorder.cjs');
import state = require('../lib/state-store.cjs');
import zone = require('../lib/zone.cjs');
import type { Baseline, InvokedSkill } from '../lib/types.cjs';

const { USAGE } = args;

function recordUnitEvent(
  sessionId: string,
  cwd: string,
  event: string,
  summary: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  ledger.appendRecord(
    { session_id: sessionId, cwd },
    summary,
    fields,
    'unit-' + event,
  );
}

/**
 * The session id the environment names: AMBER_SESSION_ID, CODEX_THREAD_ID,
 * then CLAUDE_CODE_SESSION_ID (Claude Code exports it to the tool shell, equal
 * to the hooks' session_id, and subagents inherit it); '' when none is set.
 */
function envSessionId(): string {
  return (
    process.env['AMBER_SESSION_ID'] ||
    process.env['CODEX_THREAD_ID'] ||
    process.env['CLAUDE_CODE_SESSION_ID'] ||
    process.env['PI_SESSION_ID'] ||
    ''
  ).trim();
}

/** Whether `file` names a regular file (a symbolic link to one included). */
function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Activation: the pointer and the content baseline of the run written by one
 * command, so the scope check always knows what the tree looked like when
 * the run began. Refuses before writing anything: an existing pointer, a
 * missing contract file or one outside the zone, a zone outside git.
 */
function activateCommand(
  file: string | undefined,
  rest: readonly string[],
): void {
  if (!file || file.startsWith('--')) {
    throw new Error('activate needs the contract file path\n' + USAGE);
  }
  const by = args.optionText(rest, '--by');
  if (!by) throw new Error('activate needs --by <operator>\n' + USAGE);
  const at = args.optionText(rest, '--at') || clock.isoNow().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) {
    throw new Error('--at needs a date like YYYY-MM-DD, got ' + at);
  }
  const cwd = process.cwd();
  const root = zone.zoneRoot(cwd);
  const pointerPath = path.join(root, '.amber', 'active.json');
  if (fs.existsSync(pointerPath)) {
    throw new Error(
      'active contract pointer already exists: ' +
        pointerPath +
        ' - a run is active in this zone; a passed completion releases it',
    );
  }
  const boundaryPath = path.resolve(root, file);
  if (!boundaryPath.startsWith(root + path.sep)) {
    throw new Error(
      'contract file ' + file + ' lies outside the zone root ' + root,
    );
  }
  if (!isRegularFile(boundaryPath)) {
    throw new Error('contract file not found: ' + boundaryPath);
  }
  // A git failure here throws and refuses: the baseline is the command's
  // purpose, so it is never written without one.
  const baseline = scope.takeBaseline(cwd, boundaryPath);
  if (!baseline) {
    throw new Error(
      root +
        ' is not inside a git repository, so no baseline can be recorded ' +
        '(Amber runs live in git)',
    );
  }
  const boundary = contracts.boundaryRel(root, boundaryPath);
  const contractFile = path.basename(boundaryPath);
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  state.writeStateAtomic(pointerPath, {
    v: 1,
    boundary,
    ratified_by: by,
    ratified_at: at,
    baseline,
  });
  const preRun = Object.keys(baseline.manifest).length;
  ledger.appendRecord(
    { session_id: envSessionId() || 'shell', cwd },
    'contract ' + contractFile + ' activated',
    {
      contract: contractFile,
      ratified_by: by,
      ratified_at: at,
      baseline_commit: baseline.commit,
      pre_run_paths: preRun,
    },
    'activate',
  );
  process.stdout.write(
    'amber: ' +
      contractFile +
      ' activated; baseline ' +
      (baseline.commit ? baseline.commit.slice(0, 7) : 'without a commit') +
      ', ' +
      String(preRun) +
      ' pre-run path(s) recorded\n',
  );
}

function unitCommand(name: string | undefined, rest: readonly string[]): void {
  const command = args.unitCommandOf(name);
  if (!command) throw new Error('invalid unit command\n' + USAGE);
  const cwd = process.cwd();
  const info = contracts.contractInfo(cwd);
  if (info.broken) {
    throw new Error(
      'active contract pointer is broken: ' + guards.toText(info.error),
    );
  }
  // Session identity: an explicit environment id wins; otherwise the recorder
  // reads back the driver E1 registered for this run just before the command.
  const fromEnv = envSessionId();
  const driver = fromEnv ? null : ownership.driverOfRun(info.boundaryFile);
  const sessionId = fromEnv || driver?.sessionId || 'shell';
  if (command === 'init') {
    const plan = rest.find((a) => !a.startsWith('--'));
    if (!plan) throw new Error('unit init needs the plan path\n' + USAGE);
    // The baseline the pointer carries (activate recorded it) applies; only
    // a pointer written without one - the hand-written form - makes init take
    // the snapshot itself and keep it in progress.json. preexisting and
    // baseline_commit are filled from whichever applies; without git they
    // stay what they always were (no paths, no commit).
    let fallback: Baseline | null = null;
    let warning = '';
    if (!info.baseline) {
      try {
        fallback = scope.takeBaseline(cwd, info.boundaryPath);
      } catch (err) {
        warning = guards.toText(guards.isObject(err) ? err['message'] : err);
      }
    }
    const applied = info.baseline ?? fallback;
    const p = store.initProgress(
      info.root,
      plan,
      info.boundaryFile,
      rest.includes('--force'),
      applied ? Object.keys(applied.manifest) : scope.snapshot(cwd),
      clock.isoNow,
      applied ? applied.commit : scope.headCommit(cwd),
      fallback,
    );
    const ids = Object.keys(p.units);
    recordUnitEvent(
      sessionId,
      cwd,
      'init',
      String(ids.length) + ' unit(s) from ' + p.plan,
      { contract: info.boundaryFile, units: ids.length },
    );
    process.stdout.write(
      'amber: progress.json initialized with ' +
        String(ids.length) +
        ' unit(s): ' +
        ids.join(', ') +
        '\n',
    );
    if (warning) {
      process.stdout.write(
        'amber: warning - no baseline recorded (' +
          warning +
          '); the scope check falls back to the contract commit without ' +
          'pre-run exclusions\n',
      );
    }
    return;
  }
  // A lowercase unit id is folded first (record-args prepareUnitArgs); the
  // strict check below still refuses anything else, a bare number included.
  const unitArgs = args.prepareUnitArgs(rest);
  const id = unitArgs[0];
  if (!/^U\d+$/.test(id || '') || id === undefined) {
    throw new Error('unit ' + command + ' needs a unit id like U1\n' + USAGE);
  }
  const p = store.loadProgress(info.root);
  if (!p) {
    throw new Error(
      'no progress.json in ' + info.root + '; run `unit init <plan>` first',
    );
  }
  if (model.isBroken(p)) {
    throw new Error('progress.json is broken: ' + p.error);
  }
  if (command === 'claim') {
    const unit = p.units[id];
    if (!unit) throw new Error('unknown unit ' + id);
    if (unit.agent_id) {
      process.stdout.write(
        'amber: unit ' + id + ' claimed by subagent ' + unit.agent_id + '\n',
      );
    } else {
      process.stdout.write(
        'amber: warning - the claim of ' +
          id +
          ' was not observed by a hook ' +
          '(no subagent context or no active contract); the unit remains unclaimed\n',
      );
    }
    return;
  }
  const text = args.optionText(
    unitArgs.slice(1),
    command === 'hold' ? '--reason' : '--evidence',
  );
  // verified and failed carry the evidence the ledger audits: a missing or
  // blank --evidence, or a flag the command does not read (its text would be
  // dropped silently), refuses the transition before anything is written.
  if (command === 'verified' || command === 'failed') {
    const accepted =
      command === 'verified'
        ? ['--evidence', '--out-of-scope']
        : ['--evidence'];
    const unknown = unitArgs
      .slice(1)
      .filter((a) => a.startsWith('--') && !accepted.includes(a));
    const problems: string[] = [];
    if (unknown.length > 0) {
      problems.push(
        'unknown flag ' +
          unknown.join(', ') +
          ' (not read, its text would be lost)',
      );
    }
    if (!text) problems.push('--evidence is missing or blank');
    if (problems.length > 0) {
      throw new Error(
        'unit ' +
          command +
          ' ' +
          id +
          ' refused: ' +
          problems.join('; ') +
          '. The command accepts ' +
          accepted.join(' and ') +
          '; nothing was recorded.',
      );
    }
  }
  // verified advances the run, so the changed files are compared with the
  // write-scope first; an undeclared out-of-scope file refuses the transition.
  let scopeFields: ReturnType<typeof scope.recordFields> = {};
  if (command === 'verified' && info.writeScopes.length > 0) {
    const options = {
      cwd,
      writeScopes: info.writeScopes,
      boundaryRel: info.boundaryRel,
      boundaryPath: info.boundaryPath,
      baseline: info.baseline ?? p.baseline ?? null,
      declarations: scope.parseDeclarations(unitArgs.slice(1)),
    };
    const result = scope.check(options);
    if (result.undeclared.length > 0) {
      throw new Error(
        scope.refusal(
          result,
          String(info.boundaryFile),
          info.writeScopes,
          'unit verified ' + id,
        ),
      );
    }
    scopeFields = scope.recordFields(result.declared);
  }
  model.applyEvent(
    p,
    command,
    id,
    {
      by: sessionId,
      evidence: text,
      reason: text,
      out_of_scope: scopeFields.out_of_scope,
    },
    clock.isoNow,
  );
  store.saveProgress(info.root, p, clock.isoNow);
  const fields: Record<string, unknown> = {
    contract: info.boundaryFile,
    unit: id,
    ...scopeFields,
  };
  if (command === 'verified' || command === 'failed') {
    fields['evidence'] = text.slice(0, 200);
  }
  if (command === 'hold') {
    fields['reason'] = text.slice(0, 200);
    if (p.hold?.kind) fields['kind'] = p.hold.kind;
  }
  recordUnitEvent(
    sessionId,
    cwd,
    command,
    id + (text ? ' - ' + text : ''),
    fields,
  );
  process.stdout.write(
    'amber: unit ' +
      id +
      ' -> ' +
      (command === 'hold' ? 'hold' : String(p.units[id]?.status)) +
      '\n',
  );
}

/**
 * The completion signal. Form checks live here, at write time, so the Stop
 * hook only has to judge the pointer and the worktrees.
 */
function doneCommand(rest: readonly string[]): void {
  const cwd = process.cwd();
  const info = contracts.contractInfo(cwd);
  if (info.broken) {
    throw new Error(
      'active contract pointer is broken: ' +
        guards.toText(info.error) +
        '; fix or remove it before signalling completion',
    );
  }
  const review = args.optionText(rest, '--review');
  const goal = args.optionText(rest, '--goal');
  const summary = args.optionText(rest, '--summary');
  if (!review || !summary) {
    throw new Error('done needs --review and --summary\n' + USAGE);
  }
  if (info.boundaryFile && !goal) {
    throw new Error(
      'done under contract ' +
        info.boundaryFile +
        ' needs --goal <goal-test result>\n' +
        USAGE,
    );
  }
  if (!info.boundaryFile && rest.includes('--goal')) {
    throw new Error('no active contract in ' + info.root + '; omit --goal');
  }
  if (!info.boundaryFile && rest.includes('--out-of-scope')) {
    throw new Error(
      'no active contract in ' + info.root + '; omit --out-of-scope',
    );
  }
  let scopeFields: ReturnType<typeof scope.recordFields> = {};
  if (info.boundaryFile) {
    const p = store.loadProgress(info.root);
    if (p && model.isBroken(p)) {
      throw new Error('progress.json is broken: ' + p.error);
    }
    const open = p ? model.openUnits(p) : [];
    if (open.length > 0) {
      throw new Error(
        'units still open: ' +
          open.join(', ') +
          ' - verify them (or record a hold and stop) before signalling completion',
      );
    }
    // The changed files of the whole run against the write-scope; declared
    // out-of-scope files ride in the signal and S2 records them.
    if (info.writeScopes.length > 0) {
      const options = {
        cwd,
        writeScopes: info.writeScopes,
        boundaryRel: info.boundaryRel,
        boundaryPath: info.boundaryPath,
        baseline: info.baseline ?? p?.baseline ?? null,
        declarations: scope.parseDeclarations(rest),
      };
      const result = scope.check(options);
      if (result.undeclared.length > 0) {
        throw new Error(
          scope.refusal(result, info.boundaryFile, info.writeScopes, 'done'),
        );
      }
      scopeFields = scope.recordFields(result.declared);
    }
  }
  const target = info.boundaryFile || 'request';
  done.writeDoneSignal(info.root, {
    target,
    review,
    goal: goal || null,
    summary,
    ...scopeFields,
  });
  process.stdout.write(
    'amber: completion signal written for ' +
      target +
      '; end the turn with the completion report (no marker lines)\n',
  );
}

/** invoke and mark: a Codex or pi skill call or cycle event, recorded through S3. */
function recordCall(
  command: string | undefined,
  name: string | undefined,
  rest: readonly string[],
): void {
  const invoked = command === 'invoke' ? args.invokedSkillOf(name) : null;
  const mark = command === 'mark' ? args.markKindOf(name) : null;
  // Two quoted phrases become "<a> - <b>" (record-args joinMarkWords); S3
  // then folds separator and unit-id variants with prepareMarkText, the same
  // way as a Claude Code Skill call.
  const markText = mark !== null ? args.joinMarkWords(rest) : '';
  let skill: `amber:${InvokedSkill}` | 'amber:mark';
  let skillArgs: string;
  let recorded: string;
  if (invoked !== null) {
    skill = `amber:${invoked}`;
    skillArgs = rest.join(' ').trim();
    recorded = 'invoke ' + invoked;
  } else if (mark !== null && markText) {
    skill = 'amber:mark';
    skillArgs = mark + ' - ' + markText;
    recorded = 'mark ' + mark;
  } else {
    throw new Error('invalid recording arguments\n' + USAGE);
  }
  const sessionId = (
    process.env['CODEX_THREAD_ID'] ||
    process.env['PI_SESSION_ID'] ||
    ''
  ).trim();
  if (!sessionId) {
    throw new Error(
      'CODEX_THREAD_ID or PI_SESSION_ID is required; run this command inside the Codex or pi session being recorded',
    );
  }
  skillRecorder.runS3(
    inputs.hookInput(
      {
        session_id: sessionId,
        cwd: process.cwd(),
        tool_input: { skill, args: skillArgs },
      },
      'S3',
    ),
  );
  process.stdout.write('amber: recorded ' + recorded + '\n');
}

function main(argv: readonly string[]): void {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const [command, name, ...rest] = argv;
  if (command === 'unit') {
    unitCommand(name, rest);
    return;
  }
  if (command === 'done') {
    doneCommand(name === undefined ? [] : [name, ...rest]);
    return;
  }
  if (command === 'activate') {
    activateCommand(name, rest);
    return;
  }
  recordCall(command, name, rest);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  const message = guards.isObject(err) ? err['message'] : undefined;
  process.stderr.write('amber: ' + guards.toText(message) + '\n');
  process.exitCode = 1;
}
