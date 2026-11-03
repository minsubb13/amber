// Amber hook test runner. Builds throwaway zones (contract / empty / broken
// pointer / bad regex) under a temp directory, pipes synthetic hook events
// through amber-hook.cjs with AMBER_HOME redirected, and asserts on stdout,
// the ledger, and gate-counter state. Never touches the real ~/.amber or the
// real zone. Every check is computed in order while the module loads, so the
// product sees the same calls in the same order as the standalone runner
// this replaces; each check then reports as one node:test test named by its
// label.
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { at, get, list, parseJson, show } from './support/json.mjs';
import { loadModule, PLUGIN } from './support/plugin.mjs';

const HOOK = path.join(PLUGIN, 'hooks', 'amber-hook.cjs');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-test-'));
after(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

function makeZone(
  name: string,
  boundaryText: string | null,
  pointer: unknown,
): string {
  const zone = path.join(BASE, name);
  fs.mkdirSync(zone, { recursive: true });
  execFileSync('git', ['-C', zone, 'init', '-q']);
  if (boundaryText !== null) {
    fs.writeFileSync(path.join(zone, 'test-boundary.md'), boundaryText);
  }
  if (pointer !== null) {
    fs.mkdirSync(path.join(zone, '.amber'), { recursive: true });
    fs.writeFileSync(
      path.join(zone, '.amber', 'active.json'),
      JSON.stringify(pointer),
    );
  }
  return zone;
}

const BOUNDARY = [
  '# boundary - test contract',
  '',
  '## forbidden lines',
  '- writes stay inside plugin/ [machine: write-scope plugin/**]',
  '- docs are writable too [machine: write-scope docs/*.md]',
  '- no merge or push [machine: bash-deny git\\s+(merge|push)\\b]',
  '',
  '## goal test',
  '- all runner cases pass',
  '',
  '## Standing rules',
  '- keep the journal current [hook: gate]',
].join('\n');

const zoneContract = makeZone('contract', BOUNDARY, {
  v: 1,
  boundary: 'test-boundary.md',
  ratified_by: 'operator',
  ratified_at: '2026-08-10',
});
// Same contract with the standing-rules title spaced and cased differently -
// S0 must extract it regardless.
const zoneRule = makeZone(
  'rule',
  BOUNDARY.replace('## Standing rules', '##  STANDING RULES'),
  {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-08-11',
  },
);
const zoneEmpty = makeZone('empty', null, null);
const zoneBrokenPtr = makeZone('broken', null, {
  v: 1,
  boundary: 'missing-boundary.md',
  ratified_by: 'operator',
  ratified_at: '2026-08-10',
});
const zoneBadRegex = makeZone(
  'badregex',
  '- bad pattern [machine: bash-deny (unclosed]',
  {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-08-10',
  },
);

function freshHome(tag: string): string {
  const home = path.join(BASE, 'home-' + tag);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

interface HookRun {
  readonly exit: number | null;
  readonly out: unknown;
}

function runHook(event: string, input: unknown, home: string): HookRun {
  const res = spawnSync('node', [HOOK, event], {
    input: JSON.stringify(input),
    env: { ...process.env, AMBER_HOME: home },
    encoding: 'utf8',
    timeout: 10000,
  });
  if (res.status !== 0) return { exit: res.status, out: null };
  const trimmed = (res.stdout || '').trim();
  return { exit: 0, out: trimmed ? parseJson(trimmed) : null };
}

function ledger(home: string): unknown[] {
  try {
    return fs
      .readFileSync(path.join(home, 'runs.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => parseJson(l));
  } catch {
    return [];
  }
}

function gateFileExists(home: string, sessionId: string): boolean {
  return fs.existsSync(path.join(home, 'state', 'gate-' + sessionId + '.json'));
}

/** String(value), the coercion string concatenation and regex tests apply. */
function stringOf(value: unknown): string {
  return String(value);
}

/** String(value.k1.k2...): a plain read, coerced as a regex test coerces it. */
function stringAt(
  value: unknown,
  ...path: readonly (string | number)[]
): string {
  return stringOf(get(value, ...path));
}

function check(label: string, cond: unknown, detail?: unknown): void {
  test(label, () => {
    assert.ok(cond, detail ? label + ' - ' + stringOf(detail) : label);
  });
}

/** `key in value`, throwing for a non-object as the `in` operator does. */
function has(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(
      `Cannot use 'in' operator to search for '${key}' in ${show(value)}`,
    );
  }
  return key in value;
}

/**
 * `out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext`:
 * whatever the answer holds there, falsy where a step is missing.
 */
function contextOf(out: unknown): unknown {
  return at(out, 'hookSpecificOutput', 'additionalContext');
}

/** Object.keys(value): a TypeError for null or undefined, as the original. */
function keysOf(value: unknown): string[] {
  if (value === null || value === undefined) {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  if (typeof value === 'object') return Object.keys(value);
  return typeof value === 'string'
    ? Array.from({ length: value.length }, (_, i) => String(i))
    : [];
}

/** value.join(): a TypeError where value is not an array. */
function joined(value: unknown): string {
  return list(value).join();
}

// `!!(out && out.hookSpecificOutput && ... === 'deny')` in the original.
function isDeny(out: unknown): boolean {
  return at(out, 'hookSpecificOutput', 'permissionDecision') === 'deny';
}

function e1(
  zone: string,
  tool: string,
  toolInput: unknown,
  home: string,
): unknown {
  return runHook(
    'E1',
    {
      session_id: 'e1-test',
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: toolInput,
    },
    home,
  ).out;
}

function stopEvent(zone: string, message: string, active?: boolean): unknown {
  return {
    session_id: 's2-test',
    cwd: zone,
    hook_event_name: 'Stop',
    stop_hook_active: !!active,
    last_assistant_message: message,
  };
}

const RECORD_CLI = path.join(PLUGIN, 'scripts', 'record.cjs');
// The completion signal: `record.cjs done` run in the zone, as the model does,
// from the shell of the session the Stop events name (the recorder refuses a
// shell without a session id).
function done(
  zone: string,
  home: string,
  args: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync('node', [RECORD_CLI, 'done', ...args], {
    cwd: zone,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      AMBER_HOME: home,
      AMBER_SESSION_ID: 's2-test',
      ...extraEnv,
    },
  });
}
const signalPath = (zone: string): string =>
  path.join(zone, '.amber', 'done.json');
const signalExists = (zone: string): boolean => fs.existsSync(signalPath(zone));
// A hand-written signal for cases the command itself refuses (broken pointer,
// another contract, stale timestamp).
function plantSignal(
  zone: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  fs.mkdirSync(path.join(zone, '.amber'), { recursive: true });
  fs.writeFileSync(
    signalPath(zone),
    JSON.stringify({
      v: 1,
      ts: new Date().toISOString(),
      target: 'test-boundary.md',
      review: 'planted review',
      goal: 'planted goal',
      summary: 'planted summary',
      ...fields,
    }),
  );
}
const OK_DONE = [
  '--review',
  'current artifact and test evidence satisfy every row',
  '--goal',
  'all runner cases pass',
  '--summary',
  'unit complete',
];
// Session binding: the recorder registers the session its environment names
// when that session runs a unit or done command. Tests that need a driver
// without running one seed the same registration through the plugin's own
// ownership module.
// `<call>(sessionId, <the zone's contract>)` of the plugin's ownership module,
// run with the given AMBER_HOME; its result as JSON on stdout.
function ownership(
  call: 'registerSession' | 'ownsRun',
  zone: string,
  home: string,
  sessionId: string,
): string {
  const lib = (name: string): string =>
    JSON.stringify(path.join(PLUGIN, 'lib', name));
  const script =
    'process.stdout.write(String(JSON.stringify(require(' +
    lib('ownership.cjs') +
    ').' +
    call +
    '(' +
    JSON.stringify(sessionId) +
    ', require(' +
    lib('contract.cjs') +
    ').loadContract(' +
    JSON.stringify(zone) +
    ')))));';
  const r = spawnSync('node', ['-e', script], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, AMBER_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function register(zone: string, home: string, sessionId: string): void {
  ownership('registerSession', zone, home, sessionId);
}
// Whether the session drives the zone's run, as the hooks judge it.
function owns(home: string, sessionId: string, zone: string): boolean {
  return ownership('ownsRun', zone, home, sessionId) === 'true';
}
// A Bash call through E1 as the session itself makes it (no agent id).
function e1Bash(
  zone: string,
  home: string,
  sessionId: string,
  command: string,
): unknown {
  return runHook(
    'E1',
    {
      session_id: sessionId,
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    },
    home,
  ).out;
}
const sessionState = (home: string, sessionId: string): unknown => {
  try {
    return parseJson(
      fs.readFileSync(
        path.join(home, 'state', 'session-' + sessionId + '.json'),
        'utf8',
      ),
    );
  } catch {
    return {};
  }
};
// The boundary file the session's `runs` registers for a zone, keyed by the
// zone root as git reports it; undefined without one.
const runAt = (home: string, sessionId: string, zone: string): unknown =>
  at(sessionState(home, sessionId), 'runs', fs.realpathSync(zone), 'run');
// Whether the session's state registers any run at all.
const registersAny = (home: string, sessionId: string): boolean => {
  const runs = at(sessionState(home, sessionId), 'runs');
  return typeof runs === 'object' && runs !== null && keysOf(runs).length > 0;
};

// ---- E1: contract zone ----
{
  const home = freshHome('e1');
  check(
    'E1 write inside scope allowed',
    e1(
      zoneContract,
      'Write',
      { file_path: path.join(zoneContract, 'plugin/hooks/x.cjs') },
      home,
    ) === null,
  );
  check(
    'E1 write in second scope allowed',
    e1(
      zoneContract,
      'Write',
      { file_path: path.join(zoneContract, 'docs/a.md') },
      home,
    ) === null,
  );
  const outsideDeny = e1(
    zoneContract,
    'Write',
    { file_path: path.join(zoneContract, 'secrets.txt') },
    home,
  );
  check(
    'E1 write outside scope denied',
    isDeny(outsideDeny),
    JSON.stringify(outsideDeny),
  );
  check(
    'E1 edit escaping the zone denied',
    isDeny(
      e1(
        zoneContract,
        'Edit',
        { file_path: path.join(BASE, 'outside.txt') },
        home,
      ),
    ),
  );
  check(
    'E1 bash matching deny pattern denied',
    isDeny(e1(zoneContract, 'Bash', { command: 'git merge feature' }, home)),
  );
  check(
    'E1 normal bash allowed',
    e1(zoneContract, 'Bash', { command: 'git status' }, home) === null,
  );
  check(
    'E1 pointer edit denied (tamper guard)',
    isDeny(
      e1(
        zoneContract,
        'Edit',
        { file_path: path.join(zoneContract, '.amber/active.json') },
        home,
      ),
    ),
  );
  check(
    'E1 boundary edit denied (tamper guard)',
    isDeny(
      e1(
        zoneContract,
        'Edit',
        { file_path: path.join(zoneContract, 'test-boundary.md') },
        home,
      ),
    ),
  );
  // Monitor runs a shell command like Bash: the bash-deny rows apply to it.
  check(
    'E1 Monitor command matching deny pattern denied',
    isDeny(
      e1(
        zoneContract,
        'Monitor',
        { command: 'git merge feature', description: 'd', timeout_ms: 1000 },
        home,
      ),
    ),
  );
  check(
    'E1 Monitor command otherwise allowed',
    e1(
      zoneContract,
      'Monitor',
      { command: 'tail -f build.log', description: 'd', timeout_ms: 1000 },
      home,
    ) === null,
  );
  // A host may name the file under `path`; it is the write target too.
  check(
    'E1 path key read as the write target',
    isDeny(
      e1(
        zoneContract,
        'Write',
        { path: path.join(zoneContract, 'secrets.txt') },
        home,
      ),
    ),
  );
  check(
    'E1 path key inside scope allowed',
    e1(
      zoneContract,
      'Write',
      { path: path.join(zoneContract, 'docs/b.md') },
      home,
    ) === null,
  );
}

// ---- E1: the run's state under .amber/ is no file tool's to write ----
{
  const home = freshHome('e1s');
  const zoneBroad = makeZone(
    'broad',
    '# boundary - broad\n- everything [machine: write-scope **]\n',
    {
      v: 1,
      boundary: 'test-boundary.md',
      ratified_by: 'operator',
      ratified_at: '2026-10-19',
    },
  );
  check(
    'E1 broad scope: ordinary write allowed',
    e1(
      zoneBroad,
      'Write',
      { file_path: path.join(zoneBroad, 'anything.txt') },
      home,
    ) === null,
  );
  const stateDeny = e1(
    zoneBroad,
    'Edit',
    { file_path: path.join(zoneBroad, '.amber/progress.json') },
    home,
  );
  check(
    'E1 broad scope: progress.json edit denied (tamper guard)',
    isDeny(stateDeny) &&
      /\.amber\//.test(
        stringAt(stateDeny, 'hookSpecificOutput', 'permissionDecisionReason'),
      ),
    JSON.stringify(stateDeny),
  );
  check(
    'E1 broad scope: done.json write denied (tamper guard)',
    isDeny(
      e1(
        zoneBroad,
        'Write',
        { file_path: path.join(zoneBroad, '.amber/done.json') },
        home,
      ),
    ),
  );
}

// ---- E1: no contract, broken pointer, bad regex ----
{
  const home = freshHome('e1b');
  check(
    'E1 no-contract zone: write anywhere allowed',
    e1(
      zoneEmpty,
      'Write',
      { file_path: path.join(zoneEmpty, 'anything.txt') },
      home,
    ) === null,
  );
  check(
    'E1 no-contract zone: bash allowed',
    e1(zoneEmpty, 'Bash', { command: 'git merge feature' }, home) === null,
  );
  const brokenOut = e1(
    zoneBrokenPtr,
    'Write',
    { file_path: path.join(zoneBrokenPtr, 'a.txt') },
    home,
  );
  check('E1 broken pointer: write denied', isDeny(brokenOut));
  check(
    'E1 broken pointer: reason says how to release',
    !!(
      brokenOut &&
      /remove the file to release/.test(
        stringAt(brokenOut, 'hookSpecificOutput', 'permissionDecisionReason'),
      )
    ),
  );
  check(
    'E1 invalid bash-deny pattern: bash denied (fail closed)',
    isDeny(e1(zoneBadRegex, 'Bash', { command: 'git status' }, home)),
  );
}

// ---- S2: no contract - the done command and its signal ----
{
  const home = freshHome('s2plain');
  runHook(
    'S0',
    { session_id: 's2-test', cwd: zoneEmpty, model: 'claude-fable-5' },
    home,
  );
  const withGoal = done(zoneEmpty, home, OK_DONE);
  check(
    'done refuses --goal without a contract',
    withGoal.status !== 0 &&
      /omit --goal/.test(withGoal.stderr) &&
      !signalExists(zoneEmpty),
    withGoal.stderr,
  );
  const noSummary = done(zoneEmpty, home, ['--review', 'checked']);
  check(
    'done refuses a missing --summary',
    noSummary.status !== 0 &&
      /--summary/.test(noSummary.stderr) &&
      !signalExists(zoneEmpty),
  );
  const ok = done(zoneEmpty, home, [
    '--review',
    'requested artifact exists and its focused test passes',
    '--summary',
    'built the thing',
  ]);
  check(
    'done without a contract writes the signal',
    ok.status === 0 && /request/.test(ok.stdout) && signalExists(zoneEmpty),
    ok.stderr,
  );
  const pass = runHook(
    'S2',
    stopEvent(zoneEmpty, 'work done - report body only'),
    home,
  ).out;
  const recs = ledger(home);
  check(
    'S2 consumes the no-contract signal and records it',
    pass === null && recs.length === 1 && !signalExists(zoneEmpty),
    JSON.stringify(recs),
  );
  check(
    'S2 no-contract record has no gate fields',
    recs.length === 1 && !has(recs[0], 'gate') && !has(recs[0], 'contract'),
  );
  check(
    'S2 no-contract record carries the review attestation and summary',
    recs.length === 1 &&
      get(recs, 0, 'review_target') === 'request' &&
      /focused test passes/.test(stringAt(recs, 0, 'review')) &&
      get(recs, 0, 'summary') === 'built the thing',
  );
  check(
    'S2 no-contract record carries model from S0 state',
    recs.length === 1 && get(recs, 0, 'model') === 'claude-fable-5',
  );
  runHook(
    'S2',
    stopEvent(zoneEmpty, 'just a quiet answer, nothing finished'),
    home,
  );
  runHook(
    'S2',
    stopEvent(
      zoneEmpty,
      'AMBER_REVIEW: request - old marker lines\nAMBER_DONE: must be ignored now',
    ),
    home,
  );
  runHook(
    'S2',
    stopEvent(zoneEmpty, 'retry turn without a signal', true),
    home,
  );
  check(
    'S2 quiet/old-marker/reentrant turns add no records',
    ledger(home).length === 1,
  );
  plantSignal(zoneEmpty, {
    target: 'request',
    goal: null,
    ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  });
  const stale = runHook('S2', stopEvent(zoneEmpty, 'late stop'), home).out;
  check(
    'S2 drops a stale signal without recording it',
    stale === null && ledger(home).length === 1 && !signalExists(zoneEmpty),
  );
}

// ---- S2 under a contract: signal, pass, release ----
{
  const zone = makeZone('release', BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-09-15',
  });
  const home = freshHome('release');
  runHook(
    'S0',
    { session_id: 's2-test', cwd: zone, model: 'claude-fable-5' },
    home,
  );
  register(zone, home, 's2-test');
  check(
    'S0 briefed the contract session',
    get(sessionState(home, 's2-test'), 'briefed') === 'test-boundary.md',
  );
  const noGoal = done(zone, home, [
    '--review',
    'checked',
    '--summary',
    'unit complete',
  ]);
  check(
    'done under a contract refuses a missing --goal',
    noGoal.status !== 0 && /--goal/.test(noGoal.stderr) && !signalExists(zone),
    noGoal.stderr,
  );
  fs.writeFileSync(
    path.join(zone, '.amber', 'progress.json'),
    JSON.stringify({
      v: 1,
      contract: 'test-boundary.md',
      plan: 'plan.md',
      units: {},
    }),
  );
  const ok = done(zone, home, OK_DONE);
  check(
    'done under a contract writes the signal naming the contract',
    ok.status === 0 &&
      signalExists(zone) &&
      get(parseJson(fs.readFileSync(signalPath(zone), 'utf8')), 'target') ===
        'test-boundary.md',
    ok.stderr,
  );
  const pass = runHook(
    'S2',
    stopEvent(zone, 'completion report body'),
    home,
  ).out;
  check(
    'gate passes a sound signal on the first try',
    pass === null,
    JSON.stringify(pass),
  );
  const recs = ledger(home);
  check(
    'gated record carries contract/goal/gate fields',
    recs.length === 1 &&
      get(recs, 0, 'gate') === 'passed' &&
      get(recs, 0, 'contract') === 'test-boundary.md' &&
      get(recs, 0, 'goal') === 'all runner cases pass' &&
      get(recs, 0, 'review_target') === 'test-boundary.md' &&
      /test evidence/.test(stringAt(recs, 0, 'review')) &&
      get(recs, 0, 'summary') === 'unit complete',
    JSON.stringify(recs),
  );
  check('gate counter absent after pass', !gateFileExists(home, 's2-test'));
  check('pass consumes the signal', !signalExists(zone));
  check(
    'pass releases the contract pointer',
    !fs.existsSync(path.join(zone, '.amber', 'active.json')),
  );
  check(
    'pass removes progress.json',
    !fs.existsSync(path.join(zone, '.amber', 'progress.json')),
  );
  check(
    'pass clears the session briefing so a re-approval briefs again',
    !has(sessionState(home, 's2-test'), 'briefed'),
  );
  const afterPass = runHook(
    'S2',
    stopEvent(zone, 'next turn in the released zone'),
    home,
  ).out;
  check(
    'released zone is quiet afterwards',
    afterPass === null && ledger(home).length === 1,
  );
}

// ---- S2 gate: broken pointer - block, exhaustion, withdrawal ----
{
  const home = freshHome('gate3');
  const refused = done(zoneBrokenPtr, home, OK_DONE);
  check(
    'done refuses a broken pointer',
    refused.status !== 0 &&
      /broken/.test(refused.stderr) &&
      !signalExists(zoneBrokenPtr),
    refused.stderr,
  );
  const attempt = (active: boolean): unknown => {
    plantSignal(zoneBrokenPtr, {});
    return runHook('S2', stopEvent(zoneBrokenPtr, 'claimed done', active), home)
      .out;
  };
  const b1 = attempt(false);
  check(
    'gate blocks a signal under a broken pointer and says why',
    !!(
      b1 &&
      get(b1, 'decision') === 'block' &&
      /broken/.test(stringAt(b1, 'reason')) &&
      /done command again/.test(stringAt(b1, 'reason'))
    ),
    JSON.stringify(b1),
  );
  check('gate counter created', gateFileExists(home, 's2-test'));
  check('block consumes the signal', !signalExists(zoneBrokenPtr));
  const b2 = attempt(true);
  const b3 = attempt(true);
  const b4 = attempt(true);
  check(
    'gate blocks exactly 3 times then releases',
    !!(b2 && get(b2, 'decision') === 'block') &&
      !!(b3 && get(b3, 'decision') === 'block') &&
      b4 === null,
    JSON.stringify([b2 && get(b2, 'decision'), b3 && get(b3, 'decision'), b4]),
  );
  const recs = ledger(home);
  check(
    'exhausted declaration recorded with gate:exhausted',
    recs.length === 1 &&
      get(recs, 0, 'gate') === 'exhausted' &&
      get(recs, 0, 'goal') === null &&
      get(recs, 0, 'contract') === 'broken',
    JSON.stringify(recs),
  );
  check(
    'gate counter cleared after exhaustion',
    !gateFileExists(home, 's2-test'),
  );
  check(
    'broken contract never produces a passed completion',
    !recs.some((r) => get(r, 'gate') === 'passed'),
  );

  const home2 = freshHome('gate4');
  attempt(false);
  fs.writeFileSync(path.join(home2, 'placeholder'), '');
  const b = ((): unknown => {
    plantSignal(zoneBrokenPtr, {});
    return runHook('S2', stopEvent(zoneBrokenPtr, 'claimed'), home2).out;
  })();
  check('withdrawal setup blocked', !!(b && get(b, 'decision') === 'block'));
  const withdrawal = runHook(
    'S2',
    stopEvent(zoneBrokenPtr, 'resuming the work instead, no signal', true),
    home2,
  ).out;
  check('withdrawal releases the gate', withdrawal === null);
  check('withdrawal clears the counter', !gateFileExists(home2, 's2-test'));
  check('withdrawal records nothing', ledger(home2).length === 0);
}

// ---- S2 gate: foreign re-entry, stale counter, quiet turn, old markers ----
{
  const home = freshHome('gate5');
  const foreign = runHook(
    'S2',
    stopEvent(
      zoneContract,
      'done\n\nAMBER_REVIEW: test-boundary.md - current evidence checked\n' +
        'AMBER_GOAL: goal met\nAMBER_DONE: foreign re-entry',
      true,
    ),
    home,
  ).out;
  check('foreign re-entry without a signal stays silent', foreign === null);
  check('foreign re-entry records nothing', ledger(home).length === 0);

  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'state', 'gate-s2-test.json'),
    '{"attempts":1}',
  );
  const afterStale = runHook(
    'S2',
    stopEvent(zoneContract, 'ordinary quiet turn'),
    home,
  ).out;
  check(
    'stale counter on a normal turn is reclaimed silently',
    afterStale === null && !gateFileExists(home, 's2-test'),
  );

  check(
    'quiet turn under contract not blocked',
    runHook('S2', stopEvent(zoneContract, 'just discussing'), home).out ===
      null,
  );
  const markers = runHook(
    'S2',
    stopEvent(
      zoneContract,
      'done\n\nAMBER_REVIEW: test-boundary.md - old protocol\nAMBER_GOAL: met\nAMBER_DONE: old protocol',
    ),
    home,
  ).out;
  check(
    'old marker lines under a contract neither block nor record',
    markers === null &&
      ledger(home).length === 0 &&
      fs.existsSync(path.join(zoneContract, '.amber', 'active.json')),
    JSON.stringify(markers),
  );
  check('quiet turns under contract record nothing', ledger(home).length === 0);
}

// ---- S1 briefing: contract activated mid-session ----
{
  const home = freshHome('brief1');
  runHook('S0', { session_id: 'b1', cwd: zoneEmpty, model: 'm' }, home);
  const out1 = runHook(
    'S1',
    { session_id: 'b1', cwd: zoneContract, prompt: 'please continue' },
    home,
  ).out;
  const ctx1 = contextOf(out1);
  check(
    'S1 briefs once when a contract is active and the session is unbriefed',
    !!ctx1 &&
      /test-boundary\.md/.test(stringOf(ctx1)) &&
      / done --review /.test(stringOf(ctx1)),
    JSON.stringify(out1),
  );
  const out2 = runHook(
    'S1',
    { session_id: 'b1', cwd: zoneContract, prompt: 'next turn' },
    home,
  ).out;
  check('S1 does not re-brief the same boundary', out2 === null);
  const out3 = runHook(
    'S1',
    { session_id: 'b1', cwd: zoneEmpty, prompt: 'elsewhere' },
    home,
  ).out;
  check('S1 stays silent without a contract', out3 === null);

  const home2 = freshHome('brief2');
  runHook('S0', { session_id: 'b2', cwd: zoneContract, model: 'm' }, home2);
  const out4 = runHook(
    'S1',
    { session_id: 'b2', cwd: zoneContract, prompt: 'hello' },
    home2,
  ).out;
  check('S1 skips sessions S0 already briefed', out4 === null);
}

// ---- S0: no-contract briefing by source ----
{
  const home = freshHome('s0src');
  const brief = (id: string, source?: string): string => {
    const input = {
      session_id: id,
      cwd: zoneEmpty,
      model: 'm',
      ...(source === undefined ? {} : { source }),
    };
    return stringOf(contextOf(runHook('S0', input, home).out));
  };
  const isFull = (ctx: string): boolean =>
    /Completion signal:/.test(ctx) &&
    /semantic review/.test(ctx) &&
    /Never run the command for incomplete/.test(ctx);
  const isIndex = (ctx: string): boolean =>
    !/Completion signal:/.test(ctx) &&
    !/semantic review/.test(ctx) &&
    / done --review /.test(ctx) &&
    !/--goal/.test(ctx) &&
    /loads with the amber:planning skill/.test(ctx);
  for (const source of ['startup', 'clear']) {
    const ctx = brief('src-' + source, source);
    check(
      'S0 ' +
        source +
        ' without a contract briefs the arming note and the index only',
      /^amber: no active contract in this zone\./.test(ctx) && isIndex(ctx),
      ctx.slice(0, 400),
    );
  }
  for (const source of ['compact', 'resume']) {
    const ctx = brief('src-' + source, source);
    check(
      'S0 ' +
        source +
        ' without a contract briefs the full completion procedure',
      /^amber: no active contract in this zone\./.test(ctx) && isFull(ctx),
      ctx.slice(0, 400),
    );
  }
  const first = brief('src-none');
  check(
    'S0 without a source and without prior state briefs the index only',
    isIndex(first),
    first.slice(0, 400),
  );
  const again = brief('src-none');
  check(
    "S0 without a source but with this session's state briefs the full procedure",
    isFull(again),
    again.slice(0, 400),
  );
}

// ---- S0 regression ----
{
  const home = freshHome('s0');
  const out = runHook(
    'S0',
    {
      session_id: 'abc',
      cwd: zoneEmpty,
      model: 'claude-fable-5',
      source: 'startup',
    },
    home,
  ).out;
  const armCtx = contextOf(out);
  check(
    'S0 contract-less session injects the arming note',
    !!armCtx &&
      /no active contract/.test(stringOf(armCtx)) &&
      /amber:planning/.test(stringOf(armCtx)),
    JSON.stringify(out),
  );
  check(
    'S0 arming note carries the opening criterion',
    !!armCtx &&
      /work request/.test(stringOf(armCtx)) &&
      /Q&A/.test(stringOf(armCtx)),
  );
  check(
    'S0 arming note routes the contract judgment inside planning',
    !!armCtx &&
      /judged inside planning/.test(stringOf(armCtx)) &&
      /recorded/.test(stringOf(armCtx)),
  );
  check(
    'S0 contract-less startup briefing names the done command without --goal and only the index',
    !!armCtx &&
      / done --review /.test(stringOf(armCtx)) &&
      !/--goal/.test(stringOf(armCtx)) &&
      /loads with the amber:planning skill/.test(stringOf(armCtx)) &&
      !/semantic review/.test(stringOf(armCtx)),
  );
  const resumeCtx = contextOf(
    runHook(
      'S0',
      {
        session_id: 'abc-resume',
        cwd: zoneEmpty,
        model: 'claude-fable-5',
        source: 'resume',
      },
      home,
    ).out,
  );
  check(
    'S0 contract-less resume briefing names the done command without --goal',
    !!resumeCtx &&
      / done --review /.test(stringOf(resumeCtx)) &&
      !/--goal/.test(stringOf(resumeCtx)) &&
      /semantic review/.test(stringOf(resumeCtx)),
  );
  check(
    'S0 contract-less resume briefing forbids the signal for incomplete reports',
    !!resumeCtx &&
      /Never run the command for incomplete/.test(stringOf(resumeCtx)) &&
      /governed work unit itself complete/.test(stringOf(resumeCtx)) &&
      !/AMBER_/.test(stringOf(resumeCtx)),
  );
  check(
    'S0 wrote the session state file',
    fs.existsSync(path.join(home, 'state', 'session-abc.json')),
  );
  fs.appendFileSync(
    path.join(home, 'state', 'sensor-failures.log'),
    'x failure\n',
  );
  const out2 = runHook(
    'S0',
    { session_id: 'abc', cwd: zoneEmpty, model: 'claude-fable-5' },
    home,
  ).out;
  check(
    'S0 surfaces recorded sensor failures',
    !!(
      out2 &&
      get(out2, 'hookSpecificOutput') &&
      /sensor failure/.test(
        stringAt(out2, 'hookSpecificOutput', 'additionalContext'),
      )
    ),
  );
}

// ---- S1: planning-invocation sensor ----
{
  const home = freshHome('s1');
  runHook(
    'S0',
    { session_id: 's1-test', cwd: zoneEmpty, model: 'claude-fable-5' },
    home,
  );
  runHook(
    'S1',
    {
      session_id: 's1-test',
      cwd: zoneEmpty,
      prompt: '/amber:planning refactor the parser',
    },
    home,
  );
  const recs = ledger(home);
  check(
    'S1 records a planning invocation',
    recs.length === 1 &&
      get(recs, 0, 'trigger') === 'planning-invocation' &&
      get(recs, 0, 'summary') === '/amber:planning refactor the parser',
    JSON.stringify(recs),
  );
  check(
    'S1 record carries model from S0 state',
    recs.length === 1 && get(recs, 0, 'model') === 'claude-fable-5',
  );
  runHook(
    'S1',
    {
      session_id: 's1-test',
      cwd: zoneEmpty,
      prompt: 'ordinary prompt that mentions /amber:planning mid-sentence',
    },
    home,
  );
  runHook(
    'S1',
    { session_id: 's1-test', cwd: zoneEmpty, prompt: '/amber:planningish' },
    home,
  );
  runHook(
    'S1',
    { session_id: 's1-test', cwd: zoneEmpty, prompt: '/amber:status' },
    home,
  );
  check('S1 ignores non-planning prompts', ledger(home).length === 1);
  const res = runHook(
    'S1',
    { session_id: 's1-test', cwd: zoneEmpty, prompt: '/amber:planning again' },
    home,
  );
  check(
    'S1 stays exit-0 and stdout-silent',
    res.exit === 0 && res.out === null,
  );
}

// ---- session state TTL: inactivity, not age ----
{
  const home = freshHome('ttl');
  const stateOf = (id: string): string =>
    path.join(home, 'state', 'session-' + id + '.json');
  const setOld = (id: string, hours: number): void => {
    const past = new Date(Date.now() - hours * 3600 * 1000);
    fs.utimesSync(stateOf(id), past, past);
  };
  runHook(
    'S0',
    { session_id: 'alive', cwd: zoneEmpty, model: 'claude-fable-5' },
    home,
  );
  runHook(
    'S0',
    { session_id: 'other', cwd: zoneEmpty, model: 'claude-fable-5' },
    home,
  );
  setOld('alive', 49);
  setOld('other', 49);
  runHook(
    'S1',
    { session_id: 'alive', cwd: zoneEmpty, prompt: 'any prompt' },
    home,
  );
  check(
    'S1 refreshes its own session state mtime',
    fs.statSync(stateOf('alive')).mtimeMs > Date.now() - 60000,
  );
  check(
    "S1 leaves other sessions' state untouched",
    fs.statSync(stateOf('other')).mtimeMs < Date.now() - 48 * 3600 * 1000,
  );
  setOld('alive', 49);
  runHook(
    'S2',
    {
      session_id: 'alive',
      cwd: zoneEmpty,
      last_assistant_message: 'quiet turn',
    },
    home,
  );
  check(
    'S2 refreshes its own session state mtime',
    fs.statSync(stateOf('alive')).mtimeMs > Date.now() - 60000,
  );
  check(
    'S1 for a stateless session creates no state file',
    ((): boolean => {
      runHook(
        'S1',
        { session_id: 'ghost', cwd: zoneEmpty, prompt: 'hi' },
        home,
      );
      return !fs.existsSync(stateOf('ghost'));
    })(),
  );
  // The sweep itself is unchanged: idle past TTL still reclaimed, active kept.
  runHook(
    'S0',
    { session_id: 'sweeper', cwd: zoneEmpty, model: 'claude-fable-5' },
    home,
  );
  check(
    'S0 sweep reclaims state idle past the TTL',
    !fs.existsSync(stateOf('other')),
  );
  check(
    'S0 sweep keeps recently active state',
    fs.existsSync(stateOf('alive')),
  );
}

// ---- S3: model-invoked amber-skill sensor ----
{
  const home = freshHome('s3');
  runHook(
    'S0',
    { session_id: 's3-test', cwd: zoneEmpty, model: 'claude-fable-5' },
    home,
  );
  const s3 = (toolInput: unknown): HookRun =>
    runHook(
      'S3',
      {
        session_id: 's3-test',
        cwd: zoneEmpty,
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: toolInput,
      },
      home,
    );
  s3({ skill: 'amber:planning', args: 'auth refactor' });
  let recs = ledger(home);
  check(
    'S3 records a prefixed skill invocation with args',
    recs.length === 1 &&
      get(recs, 0, 'trigger') === 'skill-invocation' &&
      get(recs, 0, 'summary') === 'amber:planning auth refactor',
    JSON.stringify(recs),
  );
  check(
    'S3 record carries model from S0 state',
    recs.length === 1 && get(recs, 0, 'model') === 'claude-fable-5',
  );
  s3({ skill: 'set' });
  recs = ledger(home);
  check(
    'S3 records an unprefixed skill name too',
    recs.length === 2 && get(recs, 1, 'summary') === 'set',
  );
  s3({ skill: 'superpowers:brainstorming' });
  s3({ skill: 'amber:planningish' });
  s3({ name: 'code-review' });
  s3({});
  check(
    'S3 ignores non-amber skills and empty input',
    ledger(home).length === 2,
  );
  const res = s3({ skill: 'amber:status' });
  check(
    'S3 stays exit-0 and stdout-silent (no permission decision)',
    res.exit === 0 && res.out === null && ledger(home).length === 3,
  );
  s3({ skill: 'amber:init', args: '/home/x/proj' });
  recs = ledger(home);
  check(
    'S3 records an init invocation with args',
    recs.length === 4 && get(recs, 3, 'summary') === 'amber:init /home/x/proj',
    JSON.stringify(recs),
  );
  s3({ skill: 'amber:initx' });
  check('S3 ignores near-miss init names', ledger(home).length === 4);
  s3({ skill: 'amber:audit', args: 'exclude=amber' });
  recs = ledger(home);
  check(
    'S3 records an audit invocation with args',
    recs.length === 5 &&
      get(recs, 4, 'trigger') === 'skill-invocation' &&
      get(recs, 4, 'summary') === 'amber:audit exclude=amber',
    JSON.stringify(recs),
  );
}

// ---- S0: contract awareness injection ----
{
  const home = freshHome('s0c');
  const out = runHook(
    'S0',
    { session_id: 'c1', cwd: zoneContract, model: 'm' },
    home,
  ).out;
  const ctx = contextOf(out);
  check(
    'S0 injects active-contract identity',
    !!ctx &&
      /test-boundary\.md/.test(stringOf(ctx)) &&
      /approved by operator/.test(stringOf(ctx)),
    JSON.stringify(out),
  );
  check(
    'S0 injection carries the standing obligations verbatim',
    !!ctx && /keep the journal current/.test(stringOf(ctx)),
  );
  check(
    'S0 injection carries the completion-signal and mark conventions',
    !!ctx &&
      / done --review /.test(stringOf(ctx)) &&
      /--goal "<goal-test result of test-boundary\.md>"/.test(stringOf(ctx)) &&
      /releases the contract by itself/.test(stringOf(ctx)) &&
      /amber:mark/.test(stringOf(ctx)) &&
      !/AMBER_/.test(stringOf(ctx)),
  );
  check(
    'S0 contract briefing forbids the signal for an incomplete assessment',
    !!ctx &&
      /Never run the command for incomplete/.test(stringOf(ctx)) &&
      /never that an assessment, report, or attempt finished/.test(
        stringOf(ctx),
      ),
  );
  check(
    'S0 contract session carries no arming note',
    !!ctx && !/no active contract/.test(stringOf(ctx)),
  );
  const outRule = runHook(
    'S0',
    { session_id: 'c4', cwd: zoneRule, model: 'm' },
    home,
  ).out;
  const ctxRule = contextOf(outRule);
  check(
    'S0 extracts the standing-rules section whatever its spacing and case',
    !!ctxRule && /keep the journal current/.test(stringOf(ctxRule)),
    JSON.stringify(outRule),
  );
  const out3 = runHook(
    'S0',
    { session_id: 'c3', cwd: zoneBrokenPtr, model: 'm' },
    home,
  ).out;
  const ctx3 = contextOf(out3);
  check(
    'S0 surfaces a broken pointer at session start',
    !!ctx3 && /broken/.test(stringOf(ctx3)),
    JSON.stringify(out3),
  );

  plantSignal(zoneBrokenPtr, {
    target: 'missing-boundary.md',
    summary: 'must not pass',
  });
  const brokenDone = runHook(
    'S2',
    stopEvent(zoneBrokenPtr, 'claimed done'),
    home,
  ).out;
  check(
    'S2 broken contract cannot produce a passed completion',
    !!(
      brokenDone &&
      get(brokenDone, 'decision') === 'block' &&
      /broken/.test(stringAt(brokenDone, 'reason'))
    ) && !ledger(home).some((row) => get(row, 'gate') === 'passed'),
    JSON.stringify(brokenDone),
  );
}

// ---- S2 signal target is mechanically tied to the current contract ----
{
  const home = freshHome('review-target');
  register(zoneContract, home, 's2-test');
  plantSignal(zoneContract, {
    target: 'older-boundary.md',
    summary: 'wrong target',
  });
  const wrong = runHook('S2', stopEvent(zoneContract, 'done'), home).out;
  check(
    'gate rejects a signal written for another contract',
    !!(
      wrong &&
      get(wrong, 'decision') === 'block' &&
      /test-boundary\.md/.test(stringAt(wrong, 'reason')) &&
      /older-boundary\.md/.test(stringAt(wrong, 'reason'))
    ),
    JSON.stringify(wrong),
  );
  check(
    'wrong signal target records no completion and keeps the pointer',
    ledger(home).length === 0 &&
      !signalExists(zoneContract) &&
      fs.existsSync(path.join(zoneContract, '.amber', 'active.json')),
  );
  runHook('S2', stopEvent(zoneContract, 'withdrawn', true), home);
}

// ---- mark: cycle events as tool calls ----
{
  const home = freshHome('mark');
  const call = (name: string, args: string): HookRun =>
    runHook(
      'S3',
      {
        session_id: 's3-mark',
        cwd: zoneEmpty,
        tool_input: { skill: name, args },
      },
      home,
    );
  call(
    'amber:mark',
    'skip - opening verdict - no contract: outputs land outside the zone',
  );
  const recs = ledger(home);
  check(
    'mark skip call records a skip row carrying the verdict text',
    recs.length === 1 &&
      get(recs, 0, 'trigger') === 'skip' &&
      /opening verdict/.test(stringAt(recs, 0, 'summary')) &&
      !/^skip\b/.test(stringAt(recs, 0, 'summary')),
    JSON.stringify(recs),
  );
  call('mark', 'finding: null check missing - applied');
  check(
    'mark finding call records a finding row (unprefixed name, colon form)',
    ledger(home).length === 2 &&
      get(ledger(home), 1, 'trigger') === 'finding' &&
      /null check/.test(stringAt(ledger(home), 1, 'summary')),
  );
  call('amber:mark', 'note - malformed kind');
  check(
    'malformed mark args fall back to a skill-invocation row',
    ledger(home).length === 3 &&
      get(ledger(home), 2, 'trigger') === 'skill-invocation' &&
      /mark/.test(stringAt(ledger(home), 2, 'summary')),
    JSON.stringify(ledger(home)),
  );
  runHook(
    'S2',
    stopEvent(
      zoneEmpty,
      [
        'AMBER_SKIP: text marker - must no longer record',
        'AMBER_FINDING: text marker - must no longer record',
      ].join('\n'),
    ),
    home,
  );
  check('S2 no longer collects text-marker lines', ledger(home).length === 3);
  const gated = runHook(
    'S2',
    stopEvent(zoneContract, 'work summary\n\nAMBER_DONE: with no goal line'),
    home,
  ).out;
  check(
    'a bare AMBER_DONE line is plain text now - no gate, no record',
    gated === null && ledger(home).length === 3,
    JSON.stringify(gated),
  );
}

// ---- loop body: progress.json, unit commands, worktree-aware E1, S2 continuation ----
{
  const RECORD = path.join(PLUGIN, 'scripts', 'record.cjs');
  const LOOP_BOUNDARY = [
    '# boundary - loop test contract',
    '',
    '## forbidden lines',
    '- writes stay inside plugin/ [machine: write-scope plugin/**]',
    '- docs are writable too [machine: write-scope docs/*.md]',
    '- no push [machine: bash-deny git\\s+push\\b]',
    '',
    '## Standing rules',
    '- keep the journal current',
  ].join('\n');
  const PLAN = [
    '# loop test plan',
    '',
    '## Work units',
    '- [ ] U1 hook part [unit: U1 scope=plugin/hooks/** oracle=node plugin/tests/run-tests.cjs]',
    '- [ ] U2 docs part [unit: U2 scope=docs/*.md oracle=grep -c ok docs/a.md]',
    '- [ ] U3 integrate [unit: U3 scope=plugin/**,docs/*.md after=U1,U2 oracle=node plugin/tests/run-tests.cjs]',
    '',
    '## Progress log',
  ].join('\n');
  const zone = makeZone('loop', LOOP_BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-09-14',
  });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(zone, 'plugin', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  fs.writeFileSync(
    path.join(zone, '.gitignore'),
    '.amber/\n.claude/worktrees/\n',
  );
  execFileSync('git', ['-C', zone, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', zone, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', zone, 'add', '-A']);
  execFileSync('git', ['-C', zone, 'commit', '-q', '-m', 'init']);
  const home = freshHome('loop');
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = (): unknown =>
    parseJson(fs.readFileSync(progressFile, 'utf8'));
  const record = (
    args: readonly string[],
    extraEnv?: NodeJS.ProcessEnv,
  ): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD, ...args], {
      cwd: zone,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AMBER_HOME: home,
        AMBER_SESSION_ID: 'loop-shell',
        ...extraEnv,
      },
    });
  const rows = (trigger: string): unknown[] =>
    ledger(home).filter((r) => get(r, 'trigger') === trigger);

  // unit init / start
  const init = record(['unit', 'init', 'docs/plan.md']);
  check(
    'unit init creates progress.json from the plan unit rows',
    init.status === 0 &&
      fs.existsSync(progressFile) &&
      keysOf(get(progress(), 'units')).join(',') === 'U1,U2,U3',
    (init.stderr || '') + (init.stdout || ''),
  );
  check(
    'unit init parses scope, after, and oracle',
    fs.existsSync(progressFile) &&
      joined(get(progress(), 'units', 'U1', 'scope')) === 'plugin/hooks/**' &&
      joined(get(progress(), 'units', 'U3', 'after')) === 'U1,U2' &&
      joined(get(progress(), 'units', 'U3', 'scope')) ===
        'plugin/**,docs/*.md' &&
      get(progress(), 'units', 'U2', 'oracle') === 'grep -c ok docs/a.md',
    fs.existsSync(progressFile)
      ? JSON.stringify(get(progress(), 'units'))
      : 'no progress file',
  );
  check(
    'unit init writes a unit-init ledger row',
    rows('unit-init').length === 1,
    JSON.stringify(ledger(home)),
  );
  const start = record(['unit', 'start', 'U1']);
  check(
    'unit start marks the unit running and current',
    start.status === 0 &&
      fs.existsSync(progressFile) &&
      get(progress(), 'units', 'U1', 'status') === 'running' &&
      get(progress(), 'current') === 'U1',
    (start.stderr || '') + (start.stdout || ''),
  );
  check(
    'unit start writes a unit-start ledger row',
    rows('unit-start').length === 1,
  );

  // worktree-aware E1
  const wt = path.join(zone, '.claude', 'worktrees', 'agent-a1');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync('git', [
    '-C',
    zone,
    'worktree',
    'add',
    '-q',
    '-b',
    'worktree-agent-a1',
    wt,
  ]);
  const e1wt = (tool: string, toolInput: unknown, agentId?: string): unknown =>
    runHook(
      'E1',
      {
        session_id: 'e1-loop',
        cwd: wt,
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: toolInput,
        ...(agentId
          ? { agent_id: agentId, agent_type: 'general-purpose' }
          : {}),
      },
      home,
    ).out;
  check(
    'E1 in a worktree still finds the zone contract (outside-scope write denied)',
    isDeny(e1wt('Write', { file_path: path.join(wt, 'secrets.txt') })),
    JSON.stringify(e1wt('Write', { file_path: path.join(wt, 'secrets.txt') })),
  );
  check(
    'E1 in a worktree maps the path back to the zone (inside-scope write allowed)',
    e1wt('Write', { file_path: path.join(wt, 'plugin', 'hooks', 'a.cjs') }) ===
      null,
  );
  const unclaimed = e1wt(
    'Write',
    { file_path: path.join(wt, 'plugin', 'hooks', 'a.cjs') },
    'a1',
  );
  check(
    'E1 denies a subagent write before it claims a unit',
    isDeny(unclaimed) &&
      /claim/.test(
        stringAt(unclaimed, 'hookSpecificOutput', 'permissionDecisionReason'),
      ),
    JSON.stringify(unclaimed),
  );
  const claim = e1wt(
    'Bash',
    { command: 'node ' + RECORD + ' unit claim U1' },
    'a1',
  );
  check(
    'E1 observes a subagent unit claim and records its agent id',
    claim === null && get(progress(), 'units', 'U1', 'agent_id') === 'a1',
    JSON.stringify(claim) +
      ' ' +
      JSON.stringify(get(progress(), 'units', 'U1')),
  );
  check(
    'E1 allows the claimed subagent inside its unit scope',
    e1wt(
      'Write',
      { file_path: path.join(wt, 'plugin', 'hooks', 'a.cjs') },
      'a1',
    ) === null,
  );
  const outside = e1wt(
    'Write',
    { file_path: path.join(wt, 'docs', 'a.md') },
    'a1',
  );
  check(
    'E1 denies the claimed subagent outside its unit scope even inside the contract scope',
    isDeny(outside) &&
      /U1/.test(
        stringAt(outside, 'hookSpecificOutput', 'permissionDecisionReason'),
      ),
    JSON.stringify(outside),
  );
  const claimRun = record(['unit', 'claim', 'U1']);
  check(
    'unit claim command reports the observed claim',
    claimRun.status === 0 && /a1/.test(claimRun.stdout),
    (claimRun.stderr || '') + (claimRun.stdout || ''),
  );

  // S2 continuation
  const plain = (active: boolean): unknown =>
    stopEvent(zone, 'Finished the hook part for now.', active);
  runHook(
    'S0',
    { session_id: 's2-test', cwd: zone, model: 'loop-model' },
    home,
  );
  register(zone, home, 's2-test');
  check(
    'registration lists the session in progress.json',
    joined(get(progress(), 'session_ids')) === 'loop-shell,s2-test',
  );
  const b1 = runHook('S2', plain(false), home).out;
  check(
    'S2 blocks a plain stop while units remain open',
    !!(
      b1 &&
      get(b1, 'decision') === 'block' &&
      /U1/.test(stringAt(b1, 'reason'))
    ),
    JSON.stringify(b1),
  );
  check(
    'S2 counts the re-entry on the current unit',
    get(progress(), 'units', 'U1', 'reentries') === 1,
  );
  let last = b1;
  for (let i = 2; i <= 10; i += 1) last = runHook('S2', plain(true), home).out;
  check(
    'S2 keeps blocking up to the tenth re-entry',
    !!(last && get(last, 'decision') === 'block') &&
      get(progress(), 'units', 'U1', 'reentries') === 10,
    JSON.stringify(last),
  );
  const eleventh = runHook('S2', plain(true), home).out;
  check(
    'S2 releases the stop after ten re-entries and marks the unit limit',
    eleventh === null &&
      get(progress(), 'units', 'U1', 'status') === 'limit' &&
      rows('unit-limit').length === 1,
    JSON.stringify(eleventh) +
      ' ' +
      JSON.stringify(get(progress(), 'units', 'U1')),
  );
  record(['unit', 'start', 'U2']);
  const b2 = runHook('S2', plain(false), home).out;
  check(
    'S2 starts a fresh count when the current unit changes',
    !!(
      b2 &&
      get(b2, 'decision') === 'block' &&
      /U2/.test(stringAt(b2, 'reason'))
    ) && get(progress(), 'units', 'U2', 'reentries') === 1,
    JSON.stringify(b2),
  );
  const hold = record([
    'unit',
    'hold',
    'U2',
    '--reason',
    'waiting for the operator',
  ]);
  check(
    'unit hold records the hold',
    hold.status === 0 &&
      get(progress(), 'hold') &&
      get(progress(), 'hold', 'unit') === 'U2' &&
      rows('unit-hold').length === 1,
    (hold.stderr || '') + JSON.stringify(get(progress(), 'hold')),
  );
  const held = runHook('S2', plain(false), home).out;
  check(
    'S2 lets a held stop through and consumes the hold',
    held === null && get(progress(), 'hold') === null,
    JSON.stringify(held) + ' ' + JSON.stringify(get(progress(), 'hold')),
  );
  const afterHold = runHook('S2', plain(false), home).out;
  check(
    'S2 blocks again once the hold is consumed',
    !!(afterHold && get(afterHold, 'decision') === 'block'),
  );
  const s3 = runHook(
    'S3',
    {
      session_id: 's2-test',
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_input: {
        skill: 'amber:mark',
        args: 'hold - U2 - need operator decision',
      },
    },
    home,
  ).out;
  check(
    'mark hold via S3 records the hold in progress and ledger',
    s3 === null &&
      get(progress(), 'hold') &&
      /operator/.test(stringAt(progress(), 'hold', 'reason')) &&
      rows('unit-hold').length === 2,
    JSON.stringify(get(progress(), 'hold')),
  );
  runHook('S2', plain(false), home); // consume

  // verified / failed transitions
  const ver = record([
    'unit',
    'verified',
    'U2',
    '--evidence',
    'grep found 1 ok',
  ]);
  check(
    'unit verified records the transition',
    ver.status === 0 &&
      get(progress(), 'units', 'U2', 'status') === 'verified' &&
      rows('unit-verified').length === 1,
    (ver.stderr || '') + (ver.stdout || ''),
  );
  const fail = record([
    'unit',
    'failed',
    'U3',
    '--evidence',
    'runner 1 failed',
  ]);
  check(
    'unit failed keeps the unit open and records it',
    fail.status === 0 &&
      get(progress(), 'units', 'U3', 'status') === 'failed' &&
      rows('unit-failed').length === 1,
  );

  // verified / failed refuse a missing or blank --evidence and flags they do not read
  const u3History = get(progress(), 'units', 'U3', 'history', 'length');
  const refuses = (res: SpawnSyncReturns<string>, re: RegExp): boolean =>
    res.status !== 0 &&
    re.test(res.stderr || '') &&
    get(progress(), 'units', 'U3', 'status') === 'failed' &&
    get(progress(), 'units', 'U3', 'history', 'length') === u3History &&
    rows('unit-verified').length === 1 &&
    rows('unit-failed').length === 1;
  const noFlag = record(['unit', 'verified', 'U3']);
  check(
    'unit verified refuses a missing --evidence and records nothing',
    refuses(noFlag, /--evidence is missing or blank/) &&
      /accepts --evidence and --out-of-scope/.test(noFlag.stderr),
    noFlag.stderr,
  );
  const blank = record(['unit', 'verified', 'U3', '--evidence', '']);
  check(
    'unit verified refuses a blank --evidence',
    refuses(blank, /--evidence is missing or blank/),
    blank.stderr,
  );
  const note = record(['unit', 'verified', 'U3', '--note', 'oracle green']);
  check(
    'unit verified refuses a flag it does not read and names it',
    refuses(note, /unknown flag --note/) &&
      /--evidence is missing or blank/.test(note.stderr),
    note.stderr,
  );
  const failNoFlag = record(['unit', 'failed', 'U3']);
  check(
    'unit failed refuses a missing --evidence and records nothing',
    refuses(failNoFlag, /--evidence is missing or blank/) &&
      /accepts --evidence;/.test(failNoFlag.stderr),
    failNoFlag.stderr,
  );
  const failReason = record([
    'unit',
    'failed',
    'U3',
    '--evidence',
    'runner red',
    '--reason',
    'x',
  ]);
  check(
    'unit failed refuses a flag it does not read even with evidence present',
    refuses(failReason, /unknown flag --reason/) &&
      !/missing or blank/.test(failReason.stderr),
    failReason.stderr,
  );

  // the done command refuses while units are open
  const home2 = freshHome('loop-decl');
  runHook(
    'S0',
    { session_id: 's2-test', cwd: zone, model: 'loop-model' },
    home2,
  );
  register(zone, home2, 's2-test');
  const LOOP_DONE = [
    '--review',
    'all units verified',
    '--goal',
    'met',
    '--summary',
    'loop test complete',
  ];
  const openRefusal = done(zone, home2, LOOP_DONE);
  check(
    'done refuses while plan units are open',
    openRefusal.status !== 0 &&
      /units still open: U3/.test(openRefusal.stderr) &&
      !signalExists(zone),
    openRefusal.stderr,
  );
  record(['unit', 'verified', 'U3', '--evidence', 'runner passed'], {
    AMBER_HOME: home2,
  });
  const okDone = done(zone, home2, LOOP_DONE);
  check(
    'done accepts once every unit is closed (limit counts as closed)',
    okDone.status === 0 && signalExists(zone),
    okDone.stderr,
  );

  // declaration gate: worktrees must be gone
  const wtBlock = runHook('S2', stopEvent(zone, 'report', false), home2).out;
  check(
    'S2 rejects a completion signal while a worktree remains',
    !!(
      wtBlock &&
      get(wtBlock, 'decision') === 'block' &&
      /worktree/.test(stringAt(wtBlock, 'reason')) &&
      /done command again/.test(stringAt(wtBlock, 'reason'))
    ) && !signalExists(zone),
    JSON.stringify(wtBlock),
  );
  execFileSync('git', ['-C', zone, 'worktree', 'remove', '--force', wt]);
  done(zone, home2, LOOP_DONE);
  const wtPass = runHook('S2', stopEvent(zone, 'report', true), home2).out;
  check(
    'S2 records the completion once no worktree remains',
    wtPass === null &&
      ledger(home2).some(
        (r) =>
          get(r, 'trigger') === 'done-declaration' &&
          get(r, 'gate') === 'passed',
      ),
    JSON.stringify(wtPass) + ' ' + JSON.stringify(ledger(home2)),
  );
  check(
    'the passed loop completion releases pointer and progress',
    !fs.existsSync(path.join(zone, '.amber', 'active.json')) &&
      !fs.existsSync(progressFile),
  );

  // a completion that closes a turn our continuation brought back is recorded
  const reactivate = (h: string): void => {
    fs.writeFileSync(
      path.join(zone, '.amber', 'active.json'),
      JSON.stringify({
        v: 1,
        boundary: 'test-boundary.md',
        ratified_by: 'operator',
        ratified_at: '2026-09-15',
      }),
    );
    record(['unit', 'init', 'docs/plan.md', '--force'], { AMBER_HOME: h });
  };
  const home3 = freshHome('loop-cont-decl');
  runHook(
    'S0',
    { session_id: 's2-test', cwd: zone, model: 'loop-model' },
    home3,
  );
  reactivate(home3);
  register(zone, home3, 's2-test');
  for (const u of ['U1', 'U2']) {
    record(['unit', 'start', u], { AMBER_HOME: home3 });
    record(['unit', 'verified', u, '--evidence', 'ok'], { AMBER_HOME: home3 });
  }
  record(['unit', 'start', 'U3'], { AMBER_HOME: home3 });
  record(
    [
      'unit',
      'failed',
      'U3',
      '--evidence',
      'reopened for the continuation case',
    ],
    { AMBER_HOME: home3 },
  );
  const contBlock = runHook('S2', plain(false), home3).out;
  check(
    'S2 continuation blocks again with a reopened unit',
    !!(contBlock && get(contBlock, 'decision') === 'block'),
    JSON.stringify(contBlock),
  );
  record(['unit', 'verified', 'U3', '--evidence', 'closed again'], {
    AMBER_HOME: home3,
  });
  done(zone, home3, LOOP_DONE);
  const contDecl = runHook('S2', stopEvent(zone, 'report', true), home3).out;
  check(
    'S2 records a completion on the re-entered stop after its own continuation',
    contDecl === null &&
      ledger(home3).some(
        (r) =>
          get(r, 'trigger') === 'done-declaration' &&
          get(r, 'gate') === 'passed',
      ),
    JSON.stringify(contDecl) +
      ' ' +
      JSON.stringify(ledger(home3).map((r) => get(r, 'trigger'))),
  );
  const foreign = runHook('S2', stopEvent(zone, 'report', true), home3).out;
  check(
    'S2 stays silent on a re-entered stop once the signal is consumed',
    foreign === null &&
      ledger(home3).filter((r) => get(r, 'trigger') === 'done-declaration')
        .length === 1,
  );

  // S0 briefing carries progress; no progress file means no continuation
  reactivate(home);
  const s0 = runHook(
    'S0',
    { session_id: 'brief-loop', cwd: zone, model: 'm' },
    home,
  ).out;
  const ctx = contextOf(s0);
  check(
    'S0 briefing summarizes progress.json',
    !!ctx &&
      /3 of 3 unit\(s\) open/.test(stringOf(ctx)) &&
      /U1/.test(stringOf(ctx)),
    String(ctx).slice(0, 300),
  );
  const home4 = freshHome('loop-s1');
  runHook(
    'S0',
    { session_id: 'brief-loop-s1', cwd: zoneEmpty, model: 'm' },
    home4,
  );
  const s1 = runHook(
    'S1',
    { session_id: 'brief-loop-s1', cwd: zone, prompt: 'continue' },
    home4,
  ).out;
  const ctx1 = contextOf(s1);
  check(
    'S1 mid-session briefing also carries the progress summary',
    !!ctx1 &&
      /test-boundary\.md/.test(stringOf(ctx1)) &&
      /amber progress/.test(stringOf(ctx1)) &&
      /U1/.test(stringOf(ctx1)),
    String(ctx1).slice(0, 300),
  );
  // A session registered nowhere: s2-test drives this block's loop zone,
  // whose open units its stops would follow.
  const quiet = runHook(
    'S2',
    {
      session_id: 's2-quiet',
      cwd: zoneContract,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'plain turn without progress',
    },
    home,
  ).out;
  check(
    'S2 stays quiet under a contract without progress.json',
    quiet === null,
    JSON.stringify(quiet),
  );
}

// ---- session binding: the loop body and the completion gate act only for driving sessions ----
{
  const PLAN = [
    '## Work units',
    '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]',
    '- [ ] U2 two [unit: U2 scope=docs/*.md after=U1 oracle=true]',
  ].join('\n');
  const zone = makeZone('bind', BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-09-15',
  });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const home = freshHome('bind');
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = (): unknown =>
    parseJson(fs.readFileSync(progressFile, 'utf8'));
  const record = (
    args: readonly string[],
    extraEnv?: NodeJS.ProcessEnv,
  ): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD_CLI, ...args], {
      cwd: zone,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AMBER_HOME: home,
        AMBER_SESSION_ID: 'bind-shell',
        ...extraEnv,
      },
    });
  record(['unit', 'init', 'docs/plan.md']);
  record(['unit', 'start', 'U1']);
  check(
    'the recorder registers the session its environment names',
    joined(get(progress(), 'session_ids')) === 'bind-shell' &&
      runAt(home, 'bind-shell', zone) === 'test-boundary.md',
    JSON.stringify(sessionState(home, 'bind-shell')),
  );
  for (const id of ['drv', 'talk']) {
    runHook('S0', { session_id: id, cwd: zone, model: 'm' }, home);
  }

  const reg = e1Bash(
    zone,
    home,
    'drv',
    'node ' + RECORD_CLI + ' unit start U1',
  );
  check(
    'E1 lets a unit command through without registering the session',
    reg === null &&
      !registersAny(home, 'drv') &&
      joined(get(progress(), 'session_ids')) === 'bind-shell',
    JSON.stringify(sessionState(home, 'drv')) +
      ' ' +
      JSON.stringify(get(progress(), 'session_ids')),
  );
  register(zone, home, 'drv');
  const drv2 = record(['done', ...OK_DONE], { AMBER_SESSION_ID: 'drv2' });
  check(
    'a done command refused for open units registers nobody',
    drv2.status !== 0 &&
      !registersAny(home, 'drv2') &&
      !list(get(progress(), 'session_ids')).includes('drv2'),
    drv2.stderr,
  );
  register(zone, home, 'drv');
  check(
    'registration is idempotent',
    list(get(progress(), 'session_ids')).filter((x) => x === 'drv').length ===
      1,
  );
  runHook(
    'E1',
    {
      session_id: 'sub',
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      agent_id: 'a9',
      agent_type: 'general-purpose',
      tool_input: { command: 'node ' + RECORD_CLI + ' unit claim U1' },
    },
    home,
  );
  check(
    'a subagent call does not register a session',
    !registersAny(home, 'sub') &&
      !list(get(progress(), 'session_ids')).includes('sub'),
  );
  runHook(
    'E1',
    {
      session_id: 'talk',
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    },
    home,
  );
  check('an ordinary command does not register', !registersAny(home, 'talk'));
  // E1 registers nobody, whatever form the command takes: the same words
  // inside prose (a commit message, a grep argument, a document heredoc, a
  // node -e probe), and the command itself behind a loop keyword, an env
  // prefix, a quoted path or a shell variable. The recorder registers.
  const prose: [string, string][] = [
    [
      'a commit message naming record.cjs does not register',
      'git commit -m "fix record.cjs done" docs/x.md',
    ],
    [
      'a grep for the unit command does not register',
      'grep -rn "record.cjs unit init" docs/',
    ],
    [
      'a heredoc quoting a unit command does not register',
      "cat > docs/x.md <<'EOF'\n# contract\n- the main agent runs node " +
        RECORD_CLI +
        ' unit start U1 first\nEOF',
    ],
    [
      'a node -e probe quoting a unit command does not register',
      'node -e \'const cases=[[false,"node record.cjs unit verified U1 ' +
        '--evidence \\"x\\""]];console.log(cases)\'',
    ],
    [
      'inline code in a heredoc naming the command does not register',
      "cat > docs/x.md <<'EOF'\n# contract\n- then run `node " +
        RECORD_CLI +
        ' unit start U1` once\nEOF',
    ],
  ];
  prose.forEach(([label, command], i) => {
    const id = 'prose' + String(i);
    e1Bash(zone, home, id, command);
    check(label, !registersAny(home, id));
  });
  const commands: [string, string][] = [
    [
      'a for loop running the unit command does not register through E1',
      'for u in U1 U2; do node ' + RECORD_CLI + ' unit start $u; done',
    ],
    [
      'an env prefix before node does not register through E1',
      'env GIT_OPTIONAL_LOCKS=0 node ' + RECORD_CLI + ' unit start U1',
    ],
    [
      'a quoted record.cjs path does not register through E1',
      'node "' + RECORD_CLI + '" unit start U1',
    ],
    [
      'a plugin-root variable path does not register through E1',
      'AMBER_HOME=/tmp/h node "$amber_plugin_root/scripts/record.cjs" unit start U1',
    ],
  ];
  commands.forEach(([label, command], i) => {
    const id = 'cmd' + String(i);
    e1Bash(zone, home, id, command);
    check(label, !registersAny(home, id));
  });
  const brief = runHook(
    'E1',
    {
      session_id: 'sub2',
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      agent_id: 'a10',
      agent_type: 'general-purpose',
      tool_input: {
        command:
          "cat > docs/brief.md <<'EOF'\nFirst run: node " +
          RECORD_CLI +
          ' unit claim U2\nEOF',
      },
    },
    home,
  ).out;
  check(
    'a heredoc brief quoting unit claim does not claim',
    brief === null && !get(progress(), 'units', 'U2', 'agent_id'),
    JSON.stringify(brief),
  );
  const lowerClaim = runHook(
    'E1',
    {
      session_id: 'sub3',
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      agent_id: 'a11',
      agent_type: 'general-purpose',
      tool_input: { command: 'node ' + RECORD_CLI + ' unit claim u2' },
    },
    home,
  ).out;
  check(
    'a lowercase unit id in a subagent claim is observed as the unit',
    lowerClaim === null && get(progress(), 'units', 'U2', 'agent_id') === 'a11',
    JSON.stringify(lowerClaim) +
      ' ' +
      JSON.stringify(get(progress(), 'units', 'U2')),
  );
  const inlineBrief = runHook(
    'E1',
    {
      session_id: 'sub4',
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      agent_id: 'a12',
      agent_type: 'general-purpose',
      tool_input: {
        command:
          "cat > docs/brief2.md <<'EOF'\nYour first action is `node " +
          RECORD_CLI +
          ' unit claim U2`.\nEOF',
      },
    },
    home,
  ).out;
  check(
    'inline code in a heredoc brief naming unit claim does not claim',
    inlineBrief === null &&
      get(progress(), 'units', 'U2', 'agent_id') === 'a11',
    JSON.stringify(inlineBrief),
  );

  const talkStop = runHook(
    'S2',
    {
      session_id: 'talk',
      cwd: zone,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'just chatting',
    },
    home,
  ).out;
  check(
    'a non-driving session is not sent back while units are open',
    talkStop === null &&
      get(progress(), 'units', 'U1', 'reentries') === 0 &&
      // progress().blocks > 0 compares the value converted to a number.
      !(Number(get(progress(), 'blocks')) > 0) &&
      !fs.existsSync(path.join(home, 'state', 'loop-talk.json')),
    JSON.stringify(talkStop),
  );
  const drvStop = runHook(
    'S2',
    {
      session_id: 'drv',
      cwd: zone,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'stopping',
    },
    home,
  ).out;
  check(
    'the driving session is still sent back',
    !!(drvStop && get(drvStop, 'decision') === 'block') &&
      get(progress(), 'units', 'U1', 'reentries') === 1,
    JSON.stringify(drvStop),
  );

  plantSignal(zone, { summary: 'planted by nobody' });
  const talkSignal = runHook(
    'S2',
    {
      session_id: 'talk',
      cwd: zone,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'x',
    },
    home,
  ).out;
  check(
    'a non-driving session leaves a completion signal untouched',
    talkSignal === null &&
      signalExists(zone) &&
      ledger(home).every((r) => get(r, 'trigger') !== 'done-declaration'),
  );
  fs.writeFileSync(
    path.join(home, 'state', 'session-drv3.json'),
    JSON.stringify({ run: 'other-boundary.md' }),
  );
  const drv3 = runHook(
    'S2',
    {
      session_id: 'drv3',
      cwd: zone,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'x',
    },
    home,
  ).out;
  check(
    'a registration for another contract does not count',
    drv3 === null &&
      signalExists(zone) &&
      get(progress(), 'units', 'U1', 'reentries') === 1,
  );
  record(['unit', 'verified', 'U1', '--evidence', 'ok']);
  record(['unit', 'start', 'U2']);
  record(['unit', 'verified', 'U2', '--evidence', 'ok']);
  const drvSignal = runHook(
    'S2',
    {
      session_id: 'drv',
      cwd: zone,
      hook_event_name: 'Stop',
      stop_hook_active: true,
      last_assistant_message: 'report',
    },
    home,
  ).out;
  check(
    'the driving session consumes the signal and releases the run',
    drvSignal === null &&
      !signalExists(zone) &&
      !fs.existsSync(progressFile) &&
      !fs.existsSync(path.join(zone, '.amber', 'active.json')) &&
      ledger(home).some(
        (r) =>
          get(r, 'trigger') === 'done-declaration' &&
          get(r, 'gate') === 'passed',
      ),
    JSON.stringify(drvSignal),
  );

  // briefing and resume
  fs.writeFileSync(
    path.join(zone, '.amber', 'active.json'),
    JSON.stringify({
      v: 1,
      boundary: 'test-boundary.md',
      ratified_by: 'operator',
      ratified_at: '2026-09-15',
    }),
  );
  record(['unit', 'init', 'docs/plan.md', '--force']);
  register(zone, home, 'drv4');
  const resumed = runHook(
    'S0',
    { session_id: 'drv4', cwd: zone, model: 'm', source: 'compact' },
    home,
  ).out;
  const rctx = contextOf(resumed);
  check(
    'S0 on resume/compact keeps the session driving its run',
    runAt(home, 'drv4', zone) === 'test-boundary.md' &&
      !!rctx &&
      /this session drives the run/.test(stringOf(rctx)),
    String(rctx).slice(-300),
  );
  const other = runHook(
    'S0',
    { session_id: 'talk2', cwd: zone, model: 'm' },
    home,
  ).out;
  const octx = contextOf(other);
  check(
    'S0 tells a non-driving session so and how to take over',
    !!octx &&
      /not one of them/.test(stringOf(octx)) &&
      /2 session\(s\) drive/.test(stringOf(octx)) &&
      /unit/.test(stringOf(octx)),
    String(octx).slice(-400),
  );
  const s1 = runHook(
    'S1',
    { session_id: 'talk3', cwd: zone, prompt: 'hello' },
    home,
  ).out;
  const s1ctx = contextOf(s1);
  check(
    'S1 briefing carries the ownership line too',
    !!s1ctx && /not one of them/.test(stringOf(s1ctx)),
  );
}

// ---- no session id: the recorder refuses unit and done commands and writes nothing ----
{
  const PLAN = [
    '## Work units',
    '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]',
    '- [ ] U2 two [unit: U2 scope=docs/*.md oracle=true]',
  ].join('\n');
  const zone = makeZone('attr', BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-09-17',
  });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const home = freshHome('attr');
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = (): unknown =>
    parseJson(fs.readFileSync(progressFile, 'utf8'));
  // No environment session id unless a case sets one. The runner may itself
  // run inside a Claude Code, Codex or pi session, whose ids would otherwise
  // be inherited - blank them explicitly.
  const bare = (
    args: readonly string[],
    extraEnv?: NodeJS.ProcessEnv,
  ): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD_CLI, ...args], {
      cwd: zone,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AMBER_HOME: home,
        AMBER_SESSION_ID: '',
        CODEX_THREAD_ID: '',
        CLAUDE_CODE_SESSION_ID: '',
        PI_SESSION_ID: '',
        ...extraEnv,
      },
    });
  // Everything a refused command must leave as it was: the zone's .amber/
  // files and every state file, byte for byte, and the ledger.
  const snapshot = (): string => {
    const files = (dir: string): [string, string][] => {
      try {
        return fs
          .readdirSync(dir)
          .sort()
          .map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]);
      } catch {
        return [];
      }
    };
    return JSON.stringify([
      files(path.join(zone, '.amber')),
      files(path.join(home, 'state')),
      ledger(home).length,
    ]);
  };
  const lastRow = (): unknown => ledger(home).slice(-1)[0] || {};
  const NAMES_VARS =
    /AMBER_SESSION_ID[\s\S]*CODEX_THREAD_ID[\s\S]*CLAUDE_CODE_SESSION_ID[\s\S]*PI_SESSION_ID/;
  runHook('S0', { session_id: 'sa', cwd: zone, model: 'model-a' }, home);
  runHook('S0', { session_id: 'sb', cwd: zone, model: 'model-b' }, home);
  const fresh = snapshot();
  const noInit = bare(['unit', 'init', 'docs/plan.md']);
  check(
    'unit init without a session id is refused, naming the variables, and writes nothing',
    noInit.status === 1 &&
      NAMES_VARS.test(noInit.stderr) &&
      /nothing was recorded/.test(noInit.stderr) &&
      !fs.existsSync(progressFile) &&
      snapshot() === fresh,
    noInit.stderr,
  );
  const init = bare(['unit', 'init', 'docs/plan.md'], {
    AMBER_SESSION_ID: 'sa',
  });
  check(
    'a unit init with a session id carries that session and its model and registers it',
    init.status === 0 &&
      get(lastRow(), 'trigger') === 'unit-init' &&
      get(lastRow(), 'session_id') === 'sa' &&
      get(lastRow(), 'model') === 'model-a' &&
      runAt(home, 'sa', zone) === 'test-boundary.md' &&
      joined(get(progress(), 'session_ids')) === 'sa',
    (init.stderr || '') + JSON.stringify(lastRow()),
  );
  const initialized = snapshot();
  const noStart = bare(['unit', 'start', 'U1']);
  check(
    'unit start without a session id is refused, naming the variables, and changes no progress or state',
    noStart.status === 1 &&
      NAMES_VARS.test(noStart.stderr) &&
      snapshot() === initialized,
    noStart.stderr,
  );
  bare(['unit', 'start', 'U1'], { AMBER_SESSION_ID: 'sa' });
  bare(['unit', 'verified', 'U1', '--evidence', 'ok'], {
    AMBER_SESSION_ID: 'sa',
  });
  bare(['unit', 'start', 'U2'], { AMBER_SESSION_ID: 'sa' });
  const started = snapshot();
  const blank = bare(['unit', 'verified', 'U2', '--evidence', ' '], {
    AMBER_SESSION_ID: 'sb',
  });
  check(
    'a refused unit call does not register the session',
    blank.status === 1 &&
      /--evidence is missing or blank/.test(blank.stderr) &&
      !registersAny(home, 'sb') &&
      snapshot() === started,
    blank.stderr,
  );
  const retry = bare(['unit', 'verified', 'U2', '--evidence', 'ok'], {
    AMBER_SESSION_ID: 'sb',
  });
  check(
    'the valid call that follows registers it and carries its model',
    retry.status === 0 &&
      runAt(home, 'sb', zone) === 'test-boundary.md' &&
      joined(get(progress(), 'session_ids')) === 'sa,sb' &&
      get(lastRow(), 'session_id') === 'sb' &&
      get(lastRow(), 'model') === 'model-b',
    (retry.stderr || '') + JSON.stringify(lastRow()),
  );
  const verified = snapshot();
  const noDone = bare(['done', ...OK_DONE]);
  check(
    'done without a session id is refused, naming the variables, and writes no signal',
    noDone.status === 1 &&
      NAMES_VARS.test(noDone.stderr) &&
      !signalExists(zone) &&
      snapshot() === verified,
    noDone.stderr,
  );
  const okDone = bare(['done', ...OK_DONE], { AMBER_SESSION_ID: 'sc' });
  check(
    'done with a session id writes the signal and registers that session',
    okDone.status === 0 &&
      signalExists(zone) &&
      runAt(home, 'sc', zone) === 'test-boundary.md' &&
      list(get(progress(), 'session_ids')).includes('sc'),
    okDone.stderr,
  );
}

// ---- zone link: a session in zone A drives the run of a linked worktree B outside it ----
const LINK_PLAN = [
  '## Work units',
  '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]',
  '- [ ] U2 two [unit: U2 scope=docs/*.md oracle=true]',
].join('\n');
const LINK_POINTER = {
  v: 1,
  boundary: 'test-boundary.md',
  ratified_by: 'operator',
  ratified_at: '2026-11-02',
};
interface LinkPair {
  readonly zoneA: string;
  readonly zoneB: string;
  readonly home: string;
  /** record.cjs run in `cwd` from the shell of a session. */
  readonly rec: (
    cwd: string,
    sessionId: string,
    args: readonly string[],
  ) => SpawnSyncReturns<string>;
}
// Zone A (`<tag>-a`, a repository with a contract) and zone B (`<tag>-b`, a
// linked worktree of A outside it with its own pointer), both governed by a
// contract file named test-boundary.md, and a fresh AMBER_HOME (`<tag>`).
function linkPair(tag: string): LinkPair {
  const zoneA = makeZone(tag + '-a', BOUNDARY, LINK_POINTER);
  fs.mkdirSync(path.join(zoneA, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zoneA, 'docs', 'plan.md'), LINK_PLAN);
  fs.writeFileSync(path.join(zoneA, '.gitignore'), '.amber/\n');
  execFileSync('git', ['-C', zoneA, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', zoneA, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', zoneA, 'add', '-A']);
  execFileSync('git', ['-C', zoneA, 'commit', '-q', '-m', 'init']);
  const zoneB = path.join(BASE, tag + '-b');
  execFileSync('git', [
    '-C',
    zoneA,
    'worktree',
    'add',
    '-q',
    '-b',
    tag + '-b',
    zoneB,
  ]);
  fs.mkdirSync(path.join(zoneB, '.amber'), { recursive: true });
  fs.writeFileSync(
    path.join(zoneB, '.amber', 'active.json'),
    JSON.stringify(LINK_POINTER),
  );
  const home = freshHome(tag);
  // Claude Code's own variable only; the others are blanked.
  const rec = (
    cwd: string,
    sessionId: string,
    args: readonly string[],
  ): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD_CLI, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AMBER_HOME: home,
        AMBER_SESSION_ID: '',
        CODEX_THREAD_ID: '',
        CLAUDE_CODE_SESSION_ID: sessionId,
        PI_SESSION_ID: '',
      },
    });
  return { zoneA, zoneB, home, rec };
}
const progressOf = (zone: string): unknown =>
  parseJson(
    fs.readFileSync(path.join(zone, '.amber', 'progress.json'), 'utf8'),
  );
const amberFiles = (zone: string): string =>
  JSON.stringify(
    fs
      .readdirSync(path.join(zone, '.amber'))
      .sort()
      .map((n) => [n, fs.readFileSync(path.join(zone, '.amber', n), 'utf8')]),
  );
{
  const { zoneA, zoneB, home, rec } = linkPair('link');
  const atOf = (sessionId: string, zone: string): string =>
    stringOf(
      at(sessionState(home, sessionId), 'runs', fs.realpathSync(zone), 'at'),
    );
  rec(zoneA, 'a-owner', ['unit', 'init', 'docs/plan.md']);
  rec(zoneA, 'a-owner', ['unit', 'start', 'U1']);
  rec(zoneB, 'b-init', ['unit', 'init', 'docs/plan.md']);
  // The driving session stands in A: its hooks see cwd A.
  runHook('S0', { session_id: 'zl', cwd: zoneA, model: 'model-zl' }, home);
  const aBefore = amberFiles(zoneA);
  const startB = rec(zoneB, 'zl', ['unit', 'start', 'U1']);
  check(
    'a unit command run in B registers the session in B only and leaves A untouched',
    startB.status === 0 &&
      list(get(progressOf(zoneB), 'session_ids')).includes('zl') &&
      runAt(home, 'zl', zoneB) === 'test-boundary.md' &&
      runAt(home, 'zl', zoneA) === undefined &&
      !list(get(progressOf(zoneA), 'session_ids')).includes('zl') &&
      amberFiles(zoneA) === aBefore,
    (startB.stderr || '') + JSON.stringify(sessionState(home, 'zl')),
  );
  check(
    'ownsRun holds for B and not for A, though both contract files are test-boundary.md',
    owns(home, 'zl', zoneB) && !owns(home, 'zl', zoneA),
  );
  check(
    'the unit row of B carries the session and its model',
    ledger(home).some(
      (r) =>
        get(r, 'trigger') === 'unit-start' &&
        get(r, 'session_id') === 'zl' &&
        get(r, 'model') === 'model-zl' &&
        get(r, 'cwd') === zoneB,
    ),
  );
  check(
    'a registration in A alone does not own B',
    owns(home, 'a-owner', zoneA) && !owns(home, 'a-owner', zoneB),
  );
  const firstAtB = atOf('zl', zoneB);
  const holdA = rec(zoneA, 'zl', ['unit', 'hold', 'U1', '--reason', 'r']);
  check(
    'driving A after B keeps both registrations',
    holdA.status === 0 &&
      runAt(home, 'zl', zoneA) === 'test-boundary.md' &&
      runAt(home, 'zl', zoneB) === 'test-boundary.md' &&
      owns(home, 'zl', zoneA) &&
      owns(home, 'zl', zoneB) &&
      atOf('zl', zoneB) === firstAtB &&
      atOf('zl', zoneA) > firstAtB,
    (holdA.stderr || '') + JSON.stringify(sessionState(home, 'zl')),
  );
  rec(zoneB, 'zl', ['unit', 'verified', 'U1', '--evidence', 'ok']);
  check(
    "driving B again refreshes B's time and keeps A's registration",
    atOf('zl', zoneB) > firstAtB &&
      atOf('zl', zoneB) > atOf('zl', zoneA) &&
      runAt(home, 'zl', zoneA) === 'test-boundary.md',
    JSON.stringify(sessionState(home, 'zl')),
  );
  const e1Out = e1Bash(
    zoneA,
    home,
    'e1zl',
    'cd ' + zoneB + ' && node ' + RECORD_CLI + ' unit start U2',
  );
  check(
    'E1 registers nobody for a unit command, in A or in B',
    e1Out === null &&
      !registersAny(home, 'e1zl') &&
      !list(get(progressOf(zoneA), 'session_ids')).includes('e1zl') &&
      !list(get(progressOf(zoneB), 'session_ids')).includes('e1zl'),
    JSON.stringify(e1Out),
  );
  const registered = JSON.stringify(at(sessionState(home, 'zl'), 'runs'));
  for (const source of ['resume', 'compact', 'clear']) {
    runHook(
      'S0',
      { session_id: 'zl', cwd: zoneA, model: 'model-zl', source },
      home,
    );
    check(
      'S0 on ' + source + ' carries both registrations over',
      JSON.stringify(at(sessionState(home, 'zl'), 'runs')) === registered &&
        owns(home, 'zl', zoneA) &&
        owns(home, 'zl', zoneB),
      JSON.stringify(sessionState(home, 'zl')),
    );
  }
  // A state file written before `runs` existed: its single `run` owns any run
  // with that boundary file, and S0 does not carry it.
  fs.writeFileSync(
    path.join(home, 'state', 'session-legacy.json'),
    JSON.stringify({ model: 'm', run: 'test-boundary.md' }),
  );
  fs.writeFileSync(
    path.join(home, 'state', 'session-legacy-other.json'),
    JSON.stringify({ model: 'm', run: 'other-boundary.md' }),
  );
  check(
    'a pre-upgrade state file with only run owns a run with that boundary file',
    owns(home, 'legacy', zoneA) &&
      owns(home, 'legacy', zoneB) &&
      !owns(home, 'legacy-other', zoneA),
  );
  rec(zoneB, 'legacy', ['unit', 'start', 'U2']);
  check(
    'once the recorder registers it, runs decides and run is left as found',
    owns(home, 'legacy', zoneB) &&
      !owns(home, 'legacy', zoneA) &&
      get(sessionState(home, 'legacy'), 'run') === 'test-boundary.md',
    JSON.stringify(sessionState(home, 'legacy')),
  );
  for (const id of ['legacy-other', 'legacy']) {
    runHook(
      'S0',
      { session_id: id, cwd: zoneA, model: 'm', source: 'resume' },
      home,
    );
  }
  check(
    'S0 on resume carries a pre-upgrade run as found, alone or beside runs',
    get(sessionState(home, 'legacy-other'), 'run') === 'other-boundary.md' &&
      !has(sessionState(home, 'legacy-other'), 'runs') &&
      get(sessionState(home, 'legacy'), 'run') === 'test-boundary.md' &&
      runAt(home, 'legacy', zoneB) === 'test-boundary.md',
    JSON.stringify([
      sessionState(home, 'legacy-other'),
      sessionState(home, 'legacy'),
    ]),
  );
  // A present `runs` alone decides ownership, even when it is malformed.
  fs.writeFileSync(
    path.join(home, 'state', 'session-nullruns.json'),
    JSON.stringify({ run: 'test-boundary.md', runs: null }),
  );
  check(
    'a state file with run and a null runs owns neither A nor B',
    !owns(home, 'nullruns', zoneA) && !owns(home, 'nullruns', zoneB),
  );
  runHook(
    'S0',
    { session_id: 'nullruns', cwd: zoneA, model: 'm', source: 'resume' },
    home,
  );
  check(
    'S0 on resume carries the null runs, so the run beside it still owns nothing',
    has(sessionState(home, 'nullruns'), 'runs') &&
      !owns(home, 'nullruns', zoneA) &&
      !owns(home, 'nullruns', zoneB),
    JSON.stringify(sessionState(home, 'nullruns')),
  );
  // A session state that is JSON but not an object reads as an empty state.
  const malformed = ['null', '5', '"text"', '[1, 2]'];
  malformed.forEach((json, i) => {
    fs.writeFileSync(
      path.join(home, 'state', 'session-bad' + String(i) + '.json'),
      json,
    );
  });
  check(
    'ownsRun reads a non-object session state as owning nothing, without throwing',
    malformed.every(
      (_, i) =>
        !owns(home, 'bad' + String(i), zoneA) &&
        !owns(home, 'bad' + String(i), zoneB),
    ),
  );
  const badBefore = JSON.stringify(progressOf(zoneB));
  const badStart = rec(zoneB, 'bad0', ['unit', 'start', 'U2']);
  check(
    'a unit command over a null session state passes and registers the session',
    badStart.status === 0 &&
      JSON.stringify(progressOf(zoneB)) !== badBefore &&
      runAt(home, 'bad0', zoneB) === 'test-boundary.md' &&
      list(get(progressOf(zoneB), 'session_ids')).includes('bad0'),
    (badStart.stderr || '') + JSON.stringify(sessionState(home, 'bad0')),
  );
  fs.writeFileSync(
    path.join(home, 'state', 'session-badruns.json'),
    JSON.stringify({ runs: { [fs.realpathSync(zoneB)]: 7, x: null } }),
  );
  const badRuns = rec(zoneB, 'badruns', [
    'unit',
    'hold',
    'U2',
    '--reason',
    'r',
  ]);
  check(
    'malformed runs entries are skipped and replaced by the registration',
    badRuns.status === 0 &&
      runAt(home, 'badruns', zoneB) === 'test-boundary.md',
    (badRuns.stderr || '') + JSON.stringify(sessionState(home, 'badruns')),
  );
}

// ---- zone link: the completion signal names its session, and a stop follows the zones the session drives ----
{
  // A Stop of the session standing in `cwd`, with the pair's AMBER_HOME.
  const stopIn = (
    home: string,
    sessionId: string,
    cwd: string,
    active?: boolean,
  ): HookRun =>
    runHook(
      'S2',
      {
        session_id: sessionId,
        cwd,
        hook_event_name: 'Stop',
        stop_hook_active: !!active,
        last_assistant_message: 'report',
      },
      home,
    );
  const realB = (zone: string): string => fs.realpathSync(zone);
  const blocksOf = (zone: string): unknown => get(progressOf(zone), 'blocks');
  const noFailures = (home: string): boolean =>
    !fs.existsSync(path.join(home, 'state', 'sensor-failures.log'));
  // The signal file's text, '' once it is gone.
  const signalText = (zone: string): string =>
    signalExists(zone) ? fs.readFileSync(signalPath(zone), 'utf8') : '';
  // The parsed signal, null once it is gone.
  const readSignal = (zone: string): unknown =>
    signalExists(zone) ? parseJson(signalText(zone)) : null;
  const passedRows = (home: string): unknown[] =>
    ledger(home).filter((r) => get(r, 'gate') === 'passed');
  const DRIVEN_LINE =
    /this session also drives the run of test-boundary\.md in /;
  // Every unit of the pair's plan verified by the session, in `zone`.
  const finish = (
    rec: LinkPair['rec'],
    zone: string,
    sessionId: string,
  ): void => {
    for (const id of ['U1', 'U2']) {
      rec(zone, sessionId, ['unit', 'start', id]);
      rec(zone, sessionId, ['unit', 'verified', id, '--evidence', 'ok']);
    }
  };

  // B finished, A open: the session in A signals in B; a second session
  // registered in B leaves that signal alone; the owner's stop takes it.
  {
    const { zoneA, zoneB, home, rec } = linkPair('sig');
    rec(zoneA, 's1', ['unit', 'init', 'docs/plan.md']);
    rec(zoneA, 's1', ['unit', 'start', 'U1']);
    rec(zoneB, 's1', ['unit', 'init', 'docs/plan.md']);
    finish(rec, zoneB, 's1');
    const s0 = contextOf(
      runHook('S0', { session_id: 's1', cwd: zoneA, model: 'm1' }, home).out,
    );
    check(
      'S0 in A names the run the session also drives in B, once',
      DRIVEN_LINE.test(stringOf(s0)) &&
        stringOf(s0).includes(' in ' + realB(zoneB) + ' ') &&
        stringOf(s0).split('also drives').length === 2,
      stringOf(s0).slice(-500),
    );
    const s1 = contextOf(
      runHook('S1', { session_id: 's1', cwd: zoneA, prompt: 'go on' }, home)
        .out,
    );
    check(
      'S1 after S0 does not repeat the briefing line',
      !DRIVEN_LINE.test(stringOf(s1)),
      stringOf(s1),
    );
    const doneB = rec(zoneB, 's1', ['done', ...OK_DONE]);
    check(
      "done run in B writes the session's id into B's signal",
      doneB.status === 0 &&
        get(readSignal(zoneB), 'session_id') === 's1' &&
        get(readSignal(zoneB), 'target') === 'test-boundary.md' &&
        !signalExists(zoneA),
      doneB.stderr,
    );
    register(zoneB, home, 's2');
    register(zoneA, home, 's1b');
    register(zoneB, home, 's1b');
    const s1first = contextOf(
      runHook('S1', { session_id: 's1b', cwd: zoneA, prompt: 'hello' }, home)
        .out,
    );
    check(
      'the first S1 briefing in A carries the line for B with the contract briefing',
      /an active contract governs/.test(stringOf(s1first)) &&
        DRIVEN_LINE.test(stringOf(s1first)),
      stringOf(s1first).slice(-400),
    );
    const signalBefore = signalText(zoneB);
    const ledgerBefore = ledger(home).length;
    const otherFromA = stopIn(home, 's2', zoneA);
    const otherFromB = stopIn(home, 's2', zoneB);
    check(
      "another session's stops, from A or from B, leave the signal byte-identical",
      otherFromA.exit === 0 &&
        otherFromB.exit === 0 &&
        otherFromA.out === null &&
        otherFromB.out === null &&
        signalText(zoneB) === signalBefore &&
        ledger(home).length === ledgerBefore &&
        fs.existsSync(path.join(zoneB, '.amber', 'active.json')),
      JSON.stringify([otherFromA, otherFromB]),
    );
    const s0other = contextOf(
      runHook('S0', { session_id: 's2', cwd: zoneB, model: 'm' }, home).out,
    );
    check(
      'S0 in B tells the other session that a signal from another session waits',
      /completion signal is waiting in this zone from another session/.test(
        stringOf(s0other),
      ),
      stringOf(s0other).slice(-400),
    );
    const aBefore = amberFiles(zoneA);
    const own = stopIn(home, 's1', zoneA);
    const row = passedRows(home).find(
      (r) => get(r, 'summary') === 'unit complete',
    );
    check(
      "the session's stop in A takes its signal in B and releases B only",
      own.exit === 0 &&
        own.out === null &&
        !signalExists(zoneB) &&
        !fs.existsSync(path.join(zoneB, '.amber', 'active.json')) &&
        !fs.existsSync(path.join(zoneB, '.amber', 'progress.json')) &&
        amberFiles(zoneA) === aBefore,
      JSON.stringify(own),
    );
    check(
      "the passed row carries B's contract, B's place and the session",
      !!row &&
        get(row, 'contract') === 'test-boundary.md' &&
        get(row, 'review_target') === 'test-boundary.md' &&
        get(row, 'cwd') === realB(zoneB) &&
        get(row, 'project') === path.basename(zoneB) &&
        get(row, 'session_id') === 's1' &&
        get(row, 'model') === 'm1',
      JSON.stringify(row),
    );
    const next = stopIn(home, 's1', zoneA);
    check(
      "with B released, the next stop is sent back for A's open units",
      get(next.out, 'decision') === 'block' && blocksOf(zoneA) === 1,
      JSON.stringify(next.out),
    );
    check(
      'a send-back for the zone the session stands in keeps the plain commands',
      stringAt(next.out, 'reason').startsWith(
        'amber loop (contract test-boundary.md): ',
      ) &&
        stringAt(next.out, 'reason').includes(
          'run `node ' + RECORD_CLI + ' unit start U1`',
        ) &&
        !stringAt(next.out, 'reason').includes('cd '),
      stringAt(next.out, 'reason'),
    );
    check('no sensor failure in the signal pair', noFailures(home));
  }

  // A finished, B open: A's completion passes and the next stop goes to B.
  {
    const { zoneA, zoneB, home, rec } = linkPair('waitb');
    rec(zoneB, 'w', ['unit', 'init', 'docs/plan.md']);
    rec(zoneB, 'w', ['unit', 'start', 'U1']);
    rec(zoneA, 'w', ['unit', 'init', 'docs/plan.md']);
    finish(rec, zoneA, 'w');
    rec(zoneA, 'w', ['done', ...OK_DONE]);
    const pass = stopIn(home, 'w', zoneA);
    check(
      "A's own signal passes and releases A while B stays open",
      pass.out === null &&
        !fs.existsSync(path.join(zoneA, '.amber', 'active.json')) &&
        fs.existsSync(path.join(zoneB, '.amber', 'active.json')) &&
        get(passedRows(home)[0], 'cwd') === realB(zoneA),
      JSON.stringify(pass),
    );
    const back = stopIn(home, 'w', zoneA);
    const reason = stringAt(back.out, 'reason');
    const inB = "cd '" + realB(zoneB) + "' && node '";
    check(
      'the next stop in A is sent back for B, the zone with open units',
      get(back.out, 'decision') === 'block' &&
        reason.startsWith(
          'amber loop (contract test-boundary.md in ' + realB(zoneB) + '): ',
        ) &&
        blocksOf(zoneB) === 1,
      JSON.stringify(back.out),
    );
    check(
      "the send-back for B gives every command with B's directory, in one line",
      reason.includes(inB + RECORD_CLI + "' unit start U1`") &&
        reason.includes(inB + RECORD_CLI + "' unit verified U1 --evidence") &&
        reason.includes(inB + RECORD_CLI + "' unit hold U1 --reason") &&
        !reason.includes('amber:mark') &&
        !reason.includes('`node '),
      reason,
    );
  }

  // F8: a zone root with a space and a single quote reaches the directive
  // as one shell argument, and that `cd` lands in the root.
  {
    const { zoneB, rec } = linkPair('quote');
    rec(zoneB, 'q', ['unit', 'init', 'docs/plan.md']);
    const text = loadModule<typeof import('../src/lib/hook-text.cjs')>(
      'lib/hook-text.cjs',
      ['continuationDirective'],
    );
    const store = loadModule<typeof import('../src/lib/progress-store.cjs')>(
      'lib/progress-store.cjs',
      ['loadProgress'],
    );
    const p = store.loadProgress(zoneB);
    const odd = path.join(BASE, "zone B'x");
    fs.mkdirSync(odd, { recursive: true });
    const directive =
      p && !('broken' in p)
        ? text.continuationDirective('test-boundary.md', p, 'U1', 1, odd)
        : '';
    const cdPart = "cd '" + BASE + "/zone B'\\''x'";
    const landed = spawnSync('sh', ['-c', cdPart + ' && pwd'], {
      encoding: 'utf8',
    });
    check(
      'a root with a space and a quote is one quoted argument, and its cd lands in the root',
      directive.includes(
        '`' + cdPart + " && node '" + RECORD_CLI + "' unit start U1`",
      ) &&
        landed.status === 0 &&
        landed.stdout.trim() === odd,
      JSON.stringify([directive, landed.stdout, landed.stderr]),
    );
  }

  // F4: the completion signal is consumed by renaming it to a claim file.
  const doneSignal = loadModule<typeof import('../src/lib/done-signal.cjs')>(
    'lib/done-signal.cjs',
    ['takeDoneSignal', 'writeDoneSignal'],
  );
  const claimsOf = (zone: string): string[] =>
    fs
      .readdirSync(path.join(zone, '.amber'))
      .filter((n) => n.startsWith('done.json.taking-'));
  const signalOf = (sessionId: string): Record<string, string> => ({
    session_id: sessionId,
    target: 'test-boundary.md',
    review: sessionId + ' review',
    goal: sessionId + ' goal',
    summary: sessionId + ' complete',
  });

  // (a) Replaced between the first read and the claim: the claim holds the
  // replacement, which goes back in place, and the owner takes nothing.
  {
    const { zoneB, home, rec } = linkPair('race');
    rec(zoneB, 'r1', ['unit', 'init', 'docs/plan.md']);
    finish(rec, zoneB, 'r1');
    rec(zoneB, 'r1', ['done', ...OK_DONE]);
    let replacement = '';
    const first = doneSignal.takeDoneSignal(zoneB, (sessionId) => {
      if (replacement === '') {
        // r2's recorder writes its signal while r1's stop decides.
        doneSignal.writeDoneSignal(zoneB, signalOf('r2'));
        replacement = signalText(zoneB);
      }
      return sessionId === 'r1';
    });
    check(
      'a signal replaced before the claim is restored byte-identical, and the owner takes nothing',
      !first.taken &&
        first.signal === null &&
        get(parseJson(replacement), 'session_id') === 'r2' &&
        signalText(zoneB) === replacement &&
        claimsOf(zoneB).length === 0,
      JSON.stringify([first, replacement, signalText(zoneB), claimsOf(zoneB)]),
    );
    const own = stopIn(home, 'r2', zoneB);
    check(
      "the restored replacement is consumed by its own session's stop",
      own.out === null &&
        !signalExists(zoneB) &&
        passedRows(home).some(
          (r) =>
            get(r, 'summary') === 'r2 complete' &&
            get(r, 'session_id') === 'r2',
        ),
      JSON.stringify([own, ledger(home)]),
    );
    doneSignal.writeDoneSignal(zoneB, signalOf('r1'));
    const later = doneSignal.takeDoneSignal(zoneB, (id) => id === 'r1');
    check(
      "the first session's signal written later is taken",
      later.taken &&
        at(later.signal, 'session_id') === 'r1' &&
        !signalExists(zoneB) &&
        claimsOf(zoneB).length === 0,
      JSON.stringify(later),
    );
  }

  // (b) Replaced right after the claim (the afterClaim seam): the claimed
  // signal is consumed and the replacement lands in a fresh done.json.
  {
    const { zoneB, rec } = linkPair('claim');
    rec(zoneB, 'k1', ['unit', 'init', 'docs/plan.md']);
    finish(rec, zoneB, 'k1');
    rec(zoneB, 'k1', ['done', ...OK_DONE]);
    let replacement = '';
    const first = doneSignal.takeDoneSignal(
      zoneB,
      (id) => id === 'k1',
      () => {
        doneSignal.writeDoneSignal(zoneB, signalOf('k2'));
        replacement = signalText(zoneB);
      },
    );
    check(
      'a signal written after the claim survives byte-identical, and the claimed one is taken',
      first.taken &&
        at(first.signal, 'session_id') === 'k1' &&
        get(parseJson(replacement), 'session_id') === 'k2' &&
        signalText(zoneB) === replacement &&
        claimsOf(zoneB).length === 0,
      JSON.stringify([first, replacement, signalText(zoneB), claimsOf(zoneB)]),
    );
  }

  // (d) Replaced before the claim and again before the restore: the first
  // replacement stays as a claim file, swept once older than the TTL.
  {
    const { zoneB } = linkPair('sweep');
    doneSignal.writeDoneSignal(zoneB, signalOf('d1'));
    let calls = 0;
    const first = doneSignal.takeDoneSignal(
      zoneB,
      (id) => {
        calls += 1;
        if (calls === 1) doneSignal.writeDoneSignal(zoneB, signalOf('d2'));
        return id === 'd1';
      },
      () => {
        doneSignal.writeDoneSignal(zoneB, signalOf('d3'));
      },
    );
    const left = claimsOf(zoneB);
    const leftText =
      left.length === 1
        ? fs.readFileSync(path.join(zoneB, '.amber', left[0] ?? ''), 'utf8')
        : '';
    check(
      'a restore blocked by a newer signal leaves the claimed one as a claim file',
      !first.taken &&
        at(readSignal(zoneB), 'session_id') === 'd3' &&
        leftText !== '' &&
        at(parseJson(leftText), 'session_id') === 'd2',
      JSON.stringify([first, left, leftText, signalText(zoneB)]),
    );
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(path.join(zoneB, '.amber', left[0] ?? ''), old, old);
    const fresh = 'done.json.taking-1-1-1';
    fs.writeFileSync(path.join(zoneB, '.amber', fresh), '{}');
    const swept = doneSignal.takeDoneSignal(zoneB, () => false);
    check(
      'a claim file older than the TTL is swept, a fresh one is not',
      !swept.taken &&
        JSON.stringify(claimsOf(zoneB)) === JSON.stringify([fresh]) &&
        at(readSignal(zoneB), 'session_id') === 'd3',
      JSON.stringify([swept, claimsOf(zoneB)]),
    );
  }

  // F10: s2's Stop runs while s1 holds s2's signal as a claim (inside
  // afterClaim): s2 takes it over from the claim and s1 finds its claim gone.
  {
    const { zoneB, home, rec } = linkPair('inflight');
    rec(zoneB, 's2', ['unit', 'init', 'docs/plan.md']);
    finish(rec, zoneB, 's2');
    doneSignal.writeDoneSignal(zoneB, signalOf('s1'));
    const seen: {
      done?: SpawnSyncReturns<string>;
      stop?: HookRun;
      claims?: number;
      signal?: boolean;
    } = {};
    const first = doneSignal.takeDoneSignal(
      zoneB,
      (id) => {
        // s2's recorder replaces s1's signal while s1's stop decides.
        seen.done ??= rec(zoneB, 's2', ['done', ...OK_DONE]);
        return id === 's1';
      },
      () => {
        seen.claims = claimsOf(zoneB).length;
        seen.signal = signalExists(zoneB);
        seen.stop = stopIn(home, 's2', zoneB);
      },
    );
    check(
      "the owner's stop takes its signal from another session's in-flight claim and releases B",
      seen.done?.status === 0 &&
        seen.claims === 1 &&
        seen.signal === false &&
        seen.stop?.out === null &&
        passedRows(home).some(
          (r) =>
            get(r, 'session_id') === 's2' && get(r, 'cwd') === realB(zoneB),
        ) &&
        !fs.existsSync(path.join(zoneB, '.amber', 'active.json')),
      JSON.stringify([seen, ledger(home)]),
    );
    check(
      'the holder then takes nothing and leaves no signal or claim behind',
      !first.taken &&
        first.signal === null &&
        !signalExists(zoneB) &&
        claimsOf(zoneB).length === 0,
      JSON.stringify([first, signalText(zoneB), claimsOf(zoneB)]),
    );
    doneSignal.writeDoneSignal(zoneB, signalOf('s1'));
    const later = doneSignal.takeDoneSignal(zoneB, (id) => id === 's1');
    check(
      "the holder's own signal written later is taken",
      later.taken &&
        at(later.signal, 'session_id') === 's1' &&
        !signalExists(zoneB) &&
        claimsOf(zoneB).length === 0,
      JSON.stringify(later),
    );
  }

  // A claim naming the caller is taken while fresh and swept once stale.
  {
    const { zoneB } = linkPair('heldclaim');
    const plantClaim = (name: string, sessionId: string): string => {
      const file = path.join(zoneB, '.amber', name);
      fs.writeFileSync(
        file,
        JSON.stringify({
          v: 1,
          ts: new Date().toISOString(),
          ...signalOf(sessionId),
        }),
      );
      return file;
    };
    plantClaim('done.json.taking-1-1-3', 'h1');
    const fresh = doneSignal.takeDoneSignal(zoneB, (id) => id === 'h1');
    const staleFile = plantClaim('done.json.taking-1-1-4', 'h2');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(staleFile, old, old);
    const stale = doneSignal.takeDoneSignal(zoneB, (id) => id === 'h2');
    check(
      'a fresh claim naming the caller is taken, a stale one is swept and not taken',
      fresh.taken &&
        at(fresh.signal, 'session_id') === 'h1' &&
        !stale.taken &&
        stale.signal === null &&
        claimsOf(zoneB).length === 0 &&
        !signalExists(zoneB),
      JSON.stringify([fresh, stale, claimsOf(zoneB)]),
    );
  }

  // F11: a restore whose hard link fails (not EEXIST) falls back to a rename.
  {
    const { zoneB } = linkPair('nolink');
    doneSignal.writeDoneSignal(zoneB, signalOf('n1'));
    let replacement = '';
    // Every hard link fails as on a filesystem without them, for this call.
    const withoutLinks = <T,>(run: () => T): T => {
      const realLink: unknown = Reflect.get(fs, 'linkSync');
      Reflect.set(fs, 'linkSync', () => {
        throw Object.assign(new Error('EPERM: operation not permitted, link'), {
          code: 'EPERM',
        });
      });
      try {
        return run();
      } finally {
        Reflect.set(fs, 'linkSync', realLink);
      }
    };
    const first = withoutLinks(() =>
      doneSignal.takeDoneSignal(zoneB, (id) => {
        if (replacement === '') {
          doneSignal.writeDoneSignal(zoneB, signalOf('n2'));
          replacement = signalText(zoneB);
        }
        return id === 'n1';
      }),
    );
    check(
      'a claimed foreign signal is restored by rename, byte-identical, when the link fails with EPERM',
      !first.taken &&
        at(parseJson(replacement), 'session_id') === 'n2' &&
        signalText(zoneB) === replacement &&
        claimsOf(zoneB).length === 0,
      JSON.stringify([first, replacement, signalText(zoneB), claimsOf(zoneB)]),
    );
  }

  // Two sessions submit in B before the first one stops.
  {
    const { zoneA, zoneB, home, rec } = linkPair('concur');
    rec(zoneB, 'c1', ['unit', 'init', 'docs/plan.md']);
    finish(rec, zoneB, 'c1');
    const doneC1 = rec(zoneB, 'c1', ['done', ...OK_DONE]);
    const doneC2 = rec(zoneB, 'c2', ['done', ...OK_DONE]);
    const c2Signal = signalText(zoneB);
    const c1Stop = stopIn(home, 'c1', zoneA);
    check(
      "the first session's stop leaves the second session's replacement in place",
      doneC1.status === 0 &&
        doneC2.status === 0 &&
        get(parseJson(c2Signal), 'session_id') === 'c2' &&
        c1Stop.out === null &&
        signalText(zoneB) === c2Signal &&
        passedRows(home).length === 0 &&
        fs.existsSync(path.join(zoneB, '.amber', 'active.json')),
      JSON.stringify([doneC1.stderr, doneC2.stderr, c1Stop]),
    );
    const c2Stop = stopIn(home, 'c2', zoneB);
    check(
      "the second session's stop consumes its own signal and releases B",
      c2Stop.out === null &&
        !signalExists(zoneB) &&
        passedRows(home).length === 1 &&
        get(passedRows(home)[0], 'session_id') === 'c2' &&
        !fs.existsSync(path.join(zoneB, '.amber', 'active.json')),
      JSON.stringify([c2Stop, ledger(home)]),
    );
  }

  // Malformed progress in the newest registered zone does not hide A.
  {
    const { zoneA, zoneB, home, rec } = linkPair('badprog');
    rec(zoneA, 'bp', ['unit', 'init', 'docs/plan.md']);
    rec(zoneA, 'bp', ['unit', 'start', 'U1']);
    rec(zoneB, 'bp', ['unit', 'init', 'docs/plan.md']);
    rec(zoneB, 'bp', ['unit', 'start', 'U1']);
    fs.writeFileSync(
      path.join(zoneB, '.amber', 'progress.json'),
      JSON.stringify({ units: null }),
    );
    const back = stopIn(home, 'bp', zoneA);
    check(
      'a stop is sent back for A when the newer zone B holds units: null',
      back.exit === 0 &&
        back.out !== null &&
        get(back.out, 'decision') === 'block' &&
        stringAt(back.out, 'reason').startsWith(
          'amber loop (contract test-boundary.md): ',
        ) &&
        blocksOf(zoneA) === 1 &&
        noFailures(home),
      JSON.stringify(back),
    );
  }

  // S1 names the other driven zones once per change of their set.
  {
    const { zoneA, zoneB, home, rec } = linkPair('brief');
    const s1 = (sessionId: string, cwd: string): string =>
      stringOf(
        contextOf(
          runHook('S1', { session_id: sessionId, cwd, prompt: 'go' }, home).out,
        ),
      );
    runHook('S0', { session_id: 'f6', cwd: zoneEmpty, model: 'm' }, home);
    rec(zoneB, 'f6', ['unit', 'init', 'docs/plan.md']);
    const firstLine = s1('f6', zoneEmpty);
    const again = s1('f6', zoneEmpty);
    check(
      'in a zone without a contract, the prompt after driving B names B once',
      DRIVEN_LINE.test(firstLine) &&
        firstLine.includes(' in ' + realB(zoneB) + ' ') &&
        !DRIVEN_LINE.test(again),
      JSON.stringify([firstLine, again]),
    );
    rec(zoneA, 'f6', ['unit', 'init', 'docs/plan.md']);
    const grown = s1('f6', zoneEmpty);
    const after = s1('f6', zoneEmpty);
    check(
      'a new registration names the driven zones again, then falls silent',
      grown.split('also drives').length === 3 &&
        grown.includes(' in ' + realB(zoneA) + ' ') &&
        grown.includes(' in ' + realB(zoneB) + ' ') &&
        !DRIVEN_LINE.test(after),
      JSON.stringify([grown, after]),
    );
    runHook('S0', { session_id: 'f6a', cwd: zoneA, model: 'm' }, home);
    const briefedOnly = s1('f6a', zoneA);
    rec(zoneB, 'f6a', ['unit', 'start', 'U1']);
    const withB = s1('f6a', zoneA);
    const quiet = s1('f6a', zoneA);
    check(
      'a session already briefed in A is told about B once, without the contract briefing',
      !DRIVEN_LINE.test(briefedOnly) &&
        DRIVEN_LINE.test(withB) &&
        !/an active contract governs/.test(withB) &&
        !DRIVEN_LINE.test(quiet),
      JSON.stringify([briefedOnly, withB, quiet]),
    );
  }

  // F9: a new contract in B is announced again though B's root is unchanged.
  {
    const { zoneB, home, rec } = linkPair('swap');
    const s1 = (cwd: string): string =>
      stringOf(
        contextOf(
          runHook('S1', { session_id: 'f9', cwd, prompt: 'go' }, home).out,
        ),
      );
    runHook('S0', { session_id: 'f9', cwd: zoneEmpty, model: 'm' }, home);
    rec(zoneB, 'f9', ['unit', 'init', 'docs/plan.md']);
    const firstLine = s1(zoneEmpty);
    finish(rec, zoneB, 'f9');
    rec(zoneB, 'f9', ['done', ...OK_DONE]);
    const pass = stopIn(home, 'f9', zoneEmpty);
    fs.writeFileSync(path.join(zoneB, 'next-boundary.md'), BOUNDARY);
    fs.writeFileSync(
      path.join(zoneB, '.amber', 'active.json'),
      JSON.stringify({ ...LINK_POINTER, boundary: 'next-boundary.md' }),
    );
    const init = rec(zoneB, 'f9', ['unit', 'init', 'docs/plan.md']);
    const renamed = s1(zoneEmpty);
    const quiet = s1(zoneEmpty);
    check(
      "B's next contract is announced again, then the unchanged set is silent",
      DRIVEN_LINE.test(firstLine) &&
        pass.out === null &&
        init.status === 0 &&
        renamed.includes(
          'also drives the run of next-boundary.md in ' + realB(zoneB) + ' ',
        ) &&
        !/also drives/.test(quiet) &&
        JSON.stringify(get(sessionState(home, 'f9'), 'driven_briefed')) ===
          JSON.stringify([realB(zoneB) + '=next-boundary.md']),
      JSON.stringify([firstLine, pass, init.stderr, renamed, quiet]),
    );
  }

  // Both open: the stop follows the zone the session drove last.
  {
    const { zoneA, zoneB, home, rec } = linkPair('newest');
    rec(zoneA, 'n', ['unit', 'init', 'docs/plan.md']);
    rec(zoneA, 'n', ['unit', 'start', 'U1']);
    rec(zoneB, 'n', ['unit', 'init', 'docs/plan.md']);
    rec(zoneB, 'n', ['unit', 'start', 'U1']);
    stopIn(home, 'n', zoneA);
    check(
      'driving A then B, a stop in A is sent back for B only',
      blocksOf(zoneB) === 1 && blocksOf(zoneA) === 0,
      JSON.stringify([progressOf(zoneA), progressOf(zoneB)]),
    );
    rec(zoneA, 'n', ['unit', 'start', 'U2']);
    stopIn(home, 'n', zoneB);
    check(
      'driving A again, a stop in B is sent back for A only',
      blocksOf(zoneA) === 1 && blocksOf(zoneB) === 1,
      JSON.stringify([progressOf(zoneA), progressOf(zoneB)]),
    );
    rec(zoneA, 'n', ['unit', 'hold', 'U2', '--reason', 'operator']);
    const held = stopIn(home, 'n', zoneB);
    check(
      'a plain hold in the newest zone passes that stop without sending it to the older zone',
      held.out === null && blocksOf(zoneB) === 1,
      JSON.stringify(held.out),
    );
  }

  // The hook cwd zone has no contract: B's units and B's signal still reach the session.
  {
    const { zoneB, home, rec } = linkPair('bare');
    rec(zoneB, 'b', ['unit', 'init', 'docs/plan.md']);
    rec(zoneB, 'b', ['unit', 'start', 'U1']);
    const back = stopIn(home, 'b', zoneEmpty);
    check(
      'a session standing in a zone without a contract is sent back for B',
      get(back.out, 'decision') === 'block' && blocksOf(zoneB) === 1,
      JSON.stringify(back),
    );
    rec(zoneB, 'b', ['unit', 'verified', 'U1', '--evidence', 'ok']);
    rec(zoneB, 'b', ['unit', 'start', 'U2']);
    rec(zoneB, 'b', ['unit', 'verified', 'U2', '--evidence', 'ok']);
    rec(zoneB, 'b', ['done', ...OK_DONE]);
    const pass = stopIn(home, 'b', zoneEmpty);
    check(
      "the stop in that zone takes B's signal and releases B",
      pass.out === null &&
        !signalExists(zoneB) &&
        !fs.existsSync(path.join(zoneB, '.amber', 'active.json')) &&
        get(passedRows(home)[0], 'contract') === 'test-boundary.md' &&
        get(passedRows(home)[0], 'cwd') === realB(zoneB),
      JSON.stringify([pass, ledger(home)]),
    );
  }

  // Stale and legacy signals in B.
  {
    const { zoneA, zoneB, home, rec } = linkPair('aged');
    rec(zoneA, 'o', ['unit', 'init', 'docs/plan.md']);
    rec(zoneB, 'o', ['unit', 'init', 'docs/plan.md']);
    finish(rec, zoneA, 'o');
    finish(rec, zoneB, 'o');
    rec(zoneB, 'o', ['done', ...OK_DONE]);
    const fresh = readSignal(zoneB);
    fs.writeFileSync(
      signalPath(zoneB),
      JSON.stringify({
        ...(typeof fresh === 'object' && fresh !== null ? fresh : {}),
        ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const stale = stopIn(home, 'o', zoneA);
    check(
      "the session's own signal older than an hour is dropped without a row",
      stale.out === null &&
        !signalExists(zoneB) &&
        ledger(home).every((r) => get(r, 'gate') === undefined) &&
        fs.existsSync(path.join(zoneB, '.amber', 'active.json')),
      JSON.stringify([stale, ledger(home)]),
    );
    plantSignal(zoneB, { summary: 'legacy signal' });
    const legacyBefore = signalText(zoneB);
    const stranger = stopIn(home, 'stranger', zoneB);
    check(
      'a signal naming no session is left alone by a session that does not drive B',
      stranger.out === null && signalText(zoneB) === legacyBefore,
      JSON.stringify(stranger),
    );
    const owner = stopIn(home, 'o', zoneA);
    check(
      'a signal naming no session is taken by a session that drives B',
      owner.out === null &&
        !signalExists(zoneB) &&
        passedRows(home).some(
          (r) =>
            get(r, 'summary') === 'legacy signal' &&
            get(r, 'cwd') === realB(zoneB),
        ),
      JSON.stringify([owner, ledger(home)]),
    );
  }

  // A registered zone whose worktree was removed.
  {
    const { zoneA, zoneB, home, rec } = linkPair('gone');
    rec(zoneA, 'g', ['unit', 'init', 'docs/plan.md']);
    rec(zoneA, 'g', ['unit', 'start', 'U1']);
    rec(zoneB, 'g', ['unit', 'init', 'docs/plan.md']);
    rec(zoneB, 'g', ['unit', 'start', 'U1']);
    const realGone = realB(zoneB);
    execFileSync('git', ['-C', zoneA, 'worktree', 'remove', '--force', zoneB]);
    const s0 = runHook(
      'S0',
      { session_id: 'g', cwd: zoneA, model: 'm', source: 'resume' },
      home,
    );
    const stop = stopIn(home, 'g', zoneA);
    check(
      'S0 and S2 pass over a removed worktree: no line for it, the stop goes to A',
      s0.exit === 0 &&
        !DRIVEN_LINE.test(stringOf(contextOf(s0.out))) &&
        has(at(sessionState(home, 'g'), 'runs'), realGone) &&
        stop.exit === 0 &&
        get(stop.out, 'decision') === 'block' &&
        blocksOf(zoneA) === 1 &&
        noFailures(home),
      JSON.stringify([s0, stop]),
    );
  }

  // Only the hook cwd zone registered: no extra line.
  {
    const { zoneA, home, rec } = linkPair('solo');
    rec(zoneA, 'solo', ['unit', 'init', 'docs/plan.md']);
    const s0 = contextOf(
      runHook('S0', { session_id: 'solo', cwd: zoneA, model: 'm' }, home).out,
    );
    check(
      'S0 adds no extra-zone line when the only registration is the cwd zone',
      !!s0 &&
        /this session drives the run/.test(stringOf(s0)) &&
        !DRIVEN_LINE.test(stringOf(s0)),
      stringOf(s0).slice(-400),
    );
    const s1new = contextOf(
      runHook('S1', { session_id: 'solo-new', cwd: zoneA, prompt: 'hi' }, home)
        .out,
    );
    register(zoneA, home, 'solo-new');
    check(
      'the first S1 briefing of an unregistered session has no extra-zone line',
      !!s1new && !DRIVEN_LINE.test(stringOf(s1new)),
      stringOf(s1new),
    );
  }
}

// ---- zone link: E1 judges each target by its own zone, bash-deny is the union of driven runs, mark hold goes to the run driven last ----
{
  // B's contract differs from A's: A writes plugin/** and docs/*.md and
  // denies git merge|push; B writes plugin/** and lib/** and denies make
  // deploy. A docs/ path is in A's scope only, a lib/ path in B's only.
  const B_BOUNDARY = [
    '# boundary - worktree B',
    '- B writes plugin [machine: write-scope plugin/**]',
    '- B writes lib [machine: write-scope lib/**]',
    '- no deploy from B [machine: bash-deny \\bmake\\s+deploy\\b]',
  ].join('\n');
  const linkE1 = (
    tag: string,
  ): LinkPair & { readonly realB: string; readonly realA: string } => {
    const pair = linkPair(tag);
    fs.writeFileSync(path.join(pair.zoneB, 'test-boundary.md'), B_BOUNDARY);
    return {
      ...pair,
      realA: fs.realpathSync(pair.zoneA),
      realB: fs.realpathSync(pair.zoneB),
    };
  };
  const e1In = (
    home: string,
    cwd: string,
    sessionId: string,
    tool: string,
    toolInput: unknown,
    agentId?: string,
  ): HookRun =>
    runHook(
      'E1',
      {
        session_id: sessionId,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: toolInput,
        ...(agentId ? { agent_id: agentId, agent_type: 'default' } : {}),
      },
      home,
    );
  const write = (
    home: string,
    cwd: string,
    sessionId: string,
    file: string,
    agentId?: string,
  ): HookRun =>
    e1In(home, cwd, sessionId, 'Write', { file_path: file }, agentId);
  const reasonOf = (run: HookRun): string =>
    run.out === null
      ? ''
      : stringAt(run.out, 'hookSpecificOutput', 'permissionDecisionReason');
  const passes = (run: HookRun): boolean => run.exit === 0 && run.out === null;
  const denied = (run: HookRun, re: RegExp): boolean =>
    run.exit === 0 && isDeny(run.out) && re.test(reasonOf(run));
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const noCrash = (home: string): boolean =>
    !fs.existsSync(path.join(home, 'state', 'sensor-failures.log'));

  // Hook cwd A (with a contract), session registered to B.
  {
    const { zoneA, zoneB, home, rec, realB } = linkE1('e1z');
    rec(zoneB, 'z', ['unit', 'init', 'docs/plan.md']);
    const bName = 'test-boundary\\.md \\(' + esc(realB) + '\\)';
    const outB = write(home, zoneA, 'z', path.join(zoneB, 'docs', 'n.md'));
    check(
      "a Write from hook cwd A to a B path outside B's write-scope is refused by B's contract, named with B's root",
      denied(
        outB,
        new RegExp(
          '^amber: blocked by contract ' +
            bName +
            ': write target docs/n\\.md is outside every write-scope \\(plugin/\\*\\*, lib/\\*\\*\\)$',
        ),
      ),
      reasonOf(outB),
    );
    check(
      "a Write from hook cwd A inside B's write-scope passes (outside A's)",
      passes(write(home, zoneA, 'z', path.join(zoneB, 'lib', 'x.cjs'))),
    );
    const ptrB = write(
      home,
      zoneA,
      'z',
      path.join(zoneB, '.amber', 'active.json'),
    );
    const docB = write(home, zoneA, 'z', path.join(zoneB, 'test-boundary.md'));
    const stateB = write(
      home,
      zoneA,
      'z',
      path.join(zoneB, '.amber', 'progress.json'),
    );
    check(
      "B's pointer and contract file are not editable from hook cwd A, and B's .amber/ is refused",
      denied(ptrB, /not editable.*remove .*active\.json/) &&
        reasonOf(ptrB).includes(path.join(realB, '.amber', 'active.json')) &&
        denied(docB, /not editable/) &&
        denied(
          stateB,
          new RegExp(
            'blocked by contract ' +
              bName +
              ': \\.amber/progress\\.json is the run',
          ),
        ),
      [reasonOf(ptrB), reasonOf(docB), reasonOf(stateB)].join(' | '),
    );
    const outA = write(home, zoneA, 'z', path.join(zoneA, 'secrets.txt'));
    check(
      "a Write in A is still judged by A's contract, named without a root",
      passes(write(home, zoneA, 'z', path.join(zoneA, 'docs', 'a.md'))) &&
        denied(
          outA,
          /^amber: blocked by contract test-boundary\.md: write target secrets\.txt/,
        ),
      reasonOf(outA),
    );
    // The same B paths from a session registered nowhere: the target's zone
    // judges, not the session.
    check(
      'the target zone judges whoever writes: an unregistered session meets B as well',
      denied(
        write(home, zoneA, 'nobody', path.join(zoneB, 'docs', 'n.md')),
        new RegExp(bName),
      ) &&
        passes(write(home, zoneA, 'nobody', path.join(zoneB, 'lib', 'x.cjs'))),
    );
    // apply_patch: each target is judged by its own zone in one call.
    const patchOf = (...files: string[]): unknown => ({
      command:
        '*** Begin Patch\n' +
        files.map((f) => '*** Add File: ' + f + '\n+x').join('\n') +
        '\n*** End Patch',
    });
    const mixedOk = e1In(
      home,
      zoneA,
      'z',
      'apply_patch',
      patchOf(
        path.join(zoneA, 'docs', 'ok.md'),
        path.join(zoneB, 'lib', 'ok.cjs'),
      ),
    );
    const mixedBad = e1In(
      home,
      zoneA,
      'z',
      'apply_patch',
      patchOf(
        path.join(zoneA, 'docs', 'ok.md'),
        path.join(zoneB, 'docs', 'bad.md'),
      ),
    );
    check(
      'an apply_patch spanning A and B passes when each target fits its own zone and names B when one does not',
      passes(mixedOk) &&
        denied(mixedBad, new RegExp(bName + ': write target docs/bad\\.md')),
      reasonOf(mixedBad),
    );
    // A third zone C (a repository with no contract) passes; a nested
    // repository inside A and a path outside any repository stay A's.
    const zoneC = makeZone('e1z-c', null, null);
    const nested = path.join(zoneA, 'nested');
    fs.mkdirSync(nested);
    execFileSync('git', ['-C', nested, 'init', '-q']);
    const loose = path.join(BASE, 'e1z-loose', 'deep', 'x.txt');
    check(
      'a target in another repository with no contract passes from hook cwd A under a contract',
      passes(write(home, zoneA, 'z', path.join(zoneC, 'x.txt'))) &&
        passes(
          write(home, zoneA, 'z', path.join(zoneC, 'new', 'dir', 'x.txt')),
        ),
    );
    check(
      "a nested repository inside A and a path outside any repository are still judged by A's contract",
      denied(
        write(home, zoneA, 'z', path.join(nested, 'x.txt')),
        /write target nested\/x\.txt is outside/,
      ) &&
        denied(
          write(home, zoneA, 'z', loose),
          /^amber: blocked by contract test-boundary\.md: write target \.\./,
        ),
    );

    // Bash and Monitor: the union of A's rows and the rows of B, which the
    // session drives.
    const bash = (sessionId: string, command: string, tool = 'Bash'): HookRun =>
      e1In(home, zoneA, sessionId, tool, { command });
    const deploy = bash('z', 'make deploy');
    check(
      "B's bash-deny row applies to a session in A that drives B, naming B's contract and root",
      denied(
        deploy,
        new RegExp(
          '^amber: blocked by contract ' + bName + ': bash-deny \\\\bmake',
        ),
      ),
      reasonOf(deploy),
    );
    const push = bash('z', 'git push origin x');
    check(
      "A's own bash-deny row still applies to that session, named as before",
      denied(
        push,
        /^amber: blocked by contract test-boundary\.md: bash-deny git/,
      ),
      reasonOf(push),
    );
    check(
      "a session registered nowhere meets only A's rows",
      passes(bash('nobody', 'make deploy')) &&
        denied(bash('nobody', 'git push origin x'), /bash-deny git/),
    );
    check(
      'Monitor follows Bash: B rows for the driving session, none for another',
      denied(bash('z', 'make deploy', 'Monitor'), new RegExp(bName)) &&
        passes(bash('nobody', 'make deploy', 'Monitor')),
    );
    // A registration whose run was released adds no rows.
    const ptr = fs.readFileSync(
      path.join(zoneB, '.amber', 'active.json'),
      'utf8',
    );
    fs.rmSync(path.join(zoneB, '.amber', 'active.json'));
    check(
      'a released B adds no bash-deny rows and its paths pass as a zone without a contract',
      passes(bash('z', 'make deploy')) &&
        passes(write(home, zoneA, 'z', path.join(zoneB, 'docs', 'n.md'))),
    );
    fs.writeFileSync(path.join(zoneB, '.amber', 'active.json'), ptr);

    // Subagents: the unit claimed in B bounds writes in B.
    const claim = e1In(
      home,
      zoneB,
      'z',
      'Bash',
      { command: 'node "' + RECORD_CLI + '" unit claim U1' },
      'agent-b',
    );
    check(
      "a subagent's claim made with hook cwd B lands in B's progress",
      passes(claim) &&
        get(progressOf(zoneB), 'units', 'U1', 'agent_id') === 'agent-b',
      JSON.stringify([claim, get(progressOf(zoneB), 'units', 'U1')]),
    );
    const inUnit = write(
      home,
      zoneA,
      'z',
      path.join(zoneB, 'plugin', 'x.cjs'),
      'agent-b',
    );
    const outUnit = write(
      home,
      zoneA,
      'z',
      path.join(zoneB, 'lib', 'x.cjs'),
      'agent-b',
    );
    const unclaimed = write(
      home,
      zoneA,
      'z',
      path.join(zoneB, 'plugin', 'x.cjs'),
      'agent-n',
    );
    check(
      "a subagent that claimed U1 in B writes inside U1's scope in B from hook cwd A, not outside it",
      passes(inUnit) &&
        denied(
          outUnit,
          /blocked by unit U1 \(claimed by subagent agent-b\): write target lib\/x\.cjs is outside its scope \(plugin\/\*\*\)/,
        ),
      reasonOf(inUnit) + ' | ' + reasonOf(outUnit),
    );
    check(
      'an unclaimed subagent writing in B is refused for not claiming a unit',
      denied(unclaimed, /subagent agent-n has not claimed a unit/),
      reasonOf(unclaimed),
    );
    check('no sensor failure across the A/B E1 calls', noCrash(home));
  }

  // Hook cwd A without a contract, session registered to B.
  {
    const { zoneA, zoneB, home, rec, realB } = linkE1('e1bare');
    fs.rmSync(path.join(zoneA, '.amber', 'active.json'));
    rec(zoneB, 'zb', ['unit', 'init', 'docs/plan.md']);
    const bName = 'test-boundary\\.md \\(' + esc(realB) + '\\)';
    const outB = write(home, zoneA, 'zb', path.join(zoneB, 'docs', 'n.md'));
    check(
      "with no contract in hook cwd A, B's targets are still judged by B's contract",
      denied(
        outB,
        new RegExp(
          '^amber: blocked by contract ' + bName + ': write target docs/n\\.md',
        ),
      ) &&
        passes(write(home, zoneA, 'zb', path.join(zoneB, 'lib', 'x.cjs'))) &&
        denied(
          write(home, zoneA, 'zb', path.join(zoneB, '.amber', 'active.json')),
          /not editable/,
        ),
      reasonOf(outB),
    );
    check(
      'with no contract and no phase in A, a target in A passes',
      passes(write(home, zoneA, 'zb', path.join(zoneA, 'secrets.txt'))),
    );
    const bash = (sessionId: string, command: string): HookRun =>
      e1In(home, zoneA, sessionId, 'Bash', { command });
    check(
      "with no contract in A, B's bash-deny row still applies to the session driving B, and not to another",
      denied(bash('zb', 'make deploy'), new RegExp(bName)) &&
        passes(bash('other', 'make deploy')) &&
        passes(bash('zb', 'git push origin x')),
    );
    runHook(
      'S3',
      {
        session_id: 'zb',
        cwd: zoneA,
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'amber:planning' },
      },
      home,
    );
    const gated = write(home, zoneA, 'zb', path.join(zoneA, 'src', 'x.cjs'));
    check(
      'with a phase open in A, the phase gate judges A targets and B keeps its own contract',
      denied(
        gated,
        /planning phase open since .*: write target src\/x\.cjs is not a planning artifact/,
      ) &&
        passes(write(home, zoneA, 'zb', path.join(zoneB, 'lib', 'x.cjs'))) &&
        denied(
          write(home, zoneA, 'zb', path.join(zoneB, 'docs', 'n.md')),
          new RegExp(bName),
        ),
      reasonOf(gated),
    );
    check('no sensor failure with a contract-less hook cwd', noCrash(home));
  }

  // amber:mark hold goes to the run the session drove last.
  {
    const { zoneA, zoneB, home, rec, realB } = linkE1('e1hold');
    rec(zoneA, 'h', ['unit', 'init', 'docs/plan.md']);
    rec(zoneA, 'h', ['unit', 'start', 'U1']);
    rec(zoneB, 'h', ['unit', 'init', 'docs/plan.md']);
    rec(zoneB, 'h', ['unit', 'start', 'U1']);
    const mark = (sessionId: string, args: string): HookRun =>
      runHook(
        'S3',
        {
          session_id: sessionId,
          cwd: zoneA,
          hook_event_name: 'PreToolUse',
          tool_name: 'Skill',
          tool_input: { skill: 'amber:mark', args },
        },
        home,
      );
    const holdRows = (): unknown[] =>
      ledger(home).filter((r) => get(r, 'trigger') === 'unit-hold');
    const aBefore = amberFiles(zoneA);
    const plain = mark('h', 'hold - U1 - some reason');
    check(
      "a mark hold from hook cwd A goes to B, the run the session drove last, and leaves A's progress untouched",
      plain.exit === 0 &&
        plain.out === null &&
        at(progressOf(zoneB), 'hold', 'unit') === 'U1' &&
        /some reason/.test(stringOf(at(progressOf(zoneB), 'hold', 'reason'))) &&
        at(progressOf(zoneA), 'hold') == null &&
        amberFiles(zoneA) === aBefore,
      JSON.stringify([
        at(progressOf(zoneB), 'hold'),
        at(progressOf(zoneA), 'hold'),
      ]),
    );
    check(
      "the hold's ledger row names B's contract and B as its cwd",
      holdRows().length === 1 &&
        at(holdRows(), 0, 'contract') === 'test-boundary.md' &&
        at(holdRows(), 0, 'cwd') === realB &&
        at(holdRows(), 0, 'unit') === 'U1',
      JSON.stringify(holdRows()),
    );
    mark('h', 'hold - U1 - external: job');
    check(
      'an external mark hold from hook cwd A lands in B with kind external',
      at(progressOf(zoneB), 'hold', 'kind') === 'external' &&
        /job/.test(stringOf(at(progressOf(zoneB), 'hold', 'reason'))) &&
        at(progressOf(zoneA), 'hold') == null &&
        at(holdRows(), 1, 'kind') === 'external',
      JSON.stringify(at(progressOf(zoneB), 'hold')),
    );
    mark('stranger', 'hold - U1 - stranger reason');
    check(
      "a session with no registration holds in the hook cwd's run, as before",
      /stranger reason/.test(
        stringOf(at(progressOf(zoneA), 'hold', 'reason')),
      ) && at(holdRows(), 2, 'cwd') === zoneA,
      JSON.stringify([at(progressOf(zoneA), 'hold'), at(holdRows(), 2)]),
    );
    // The recorder's mark hold (Codex, pi) stays with its directory's run.
    const recorderHold = (
      cwd: string,
      reason: string,
    ): SpawnSyncReturns<string> =>
      spawnSync('node', [RECORD_CLI, 'mark', 'hold', 'U1', reason], {
        cwd,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          AMBER_HOME: home,
          AMBER_SESSION_ID: '',
          CLAUDE_CODE_SESSION_ID: '',
          PI_SESSION_ID: '',
          CODEX_THREAD_ID: 'h',
        },
      });
    const recA = recorderHold(zoneA, 'recorder in A');
    check(
      "the recorder's mark hold (Codex, pi) goes to the run of the directory it runs in, not the run driven last",
      recA.status === 0 &&
        /recorder in A/.test(
          stringOf(at(progressOf(zoneA), 'hold', 'reason')),
        ) &&
        !/recorder in A/.test(
          stringOf(at(progressOf(zoneB), 'hold', 'reason')),
        ),
      recA.stderr,
    );
    // B released: the newest registration that still holds its run is A.
    const ptrB = path.join(zoneB, '.amber', 'active.json');
    const ptr = fs.readFileSync(ptrB, 'utf8');
    fs.rmSync(ptrB);
    mark('h', 'hold - U1 - after B released');
    check(
      'once B is released, a mark hold goes to the next run the session drives (A)',
      /after B released/.test(
        stringOf(at(progressOf(zoneA), 'hold', 'reason')),
      ) &&
        !/after B released/.test(
          stringOf(at(progressOf(zoneB), 'hold', 'reason')),
        ),
      JSON.stringify([
        at(progressOf(zoneA), 'hold'),
        at(progressOf(zoneB), 'hold'),
      ]),
    );
    fs.writeFileSync(ptrB, ptr);
  }

  // A registered zone whose worktree was removed: E1 and S3 pass over it.
  {
    const { zoneA, zoneB, home, rec } = linkE1('e1gone');
    rec(zoneA, 'gz', ['unit', 'init', 'docs/plan.md']);
    rec(zoneA, 'gz', ['unit', 'start', 'U1']);
    rec(zoneB, 'gz', ['unit', 'init', 'docs/plan.md']);
    execFileSync('git', ['-C', zoneA, 'worktree', 'remove', '--force', zoneB]);
    const bash = e1In(home, zoneA, 'gz', 'Bash', { command: 'make deploy' });
    const gone = write(home, zoneA, 'gz', path.join(zoneB, 'lib', 'x.cjs'));
    const hold = runHook(
      'S3',
      {
        session_id: 'gz',
        cwd: zoneA,
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'amber:mark', args: 'hold - U1 - after removal' },
      },
      home,
    );
    check(
      'a removed B worktree: E1 Bash and Write and the S3 hold run without error and fall back to A',
      passes(bash) &&
        denied(
          gone,
          /^amber: blocked by contract test-boundary\.md: write target \.\./,
        ) &&
        hold.exit === 0 &&
        /after removal/.test(
          stringOf(at(progressOf(zoneA), 'hold', 'reason')),
        ) &&
        noCrash(home),
      JSON.stringify([bash, gone, hold]),
    );
  }
}

// ---- worktree zone: a linked worktree outside the zone is its own zone, with or without a pointer ----
{
  const zone = makeZone('wtz', BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-09-15',
  });
  fs.mkdirSync(path.join(zone, 'plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(zone, '.gitignore'),
    '.amber/\n.claude/worktrees/\n',
  );
  execFileSync('git', ['-C', zone, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', zone, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', zone, 'add', '-A']);
  execFileSync('git', ['-C', zone, 'commit', '-q', '-m', 'init']);
  const side = path.join(BASE, 'wtz-side');
  execFileSync('git', [
    '-C',
    zone,
    'worktree',
    'add',
    '-q',
    '-b',
    'side',
    side,
  ]);
  const home = freshHome('wtz');
  const e1At = (cwd: string, file: string): unknown =>
    runHook(
      'E1',
      {
        session_id: 'wt',
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: file },
      },
      home,
    ).out;
  // Outside the zone directory, a linked worktree is a zone of its own even
  // before it has a pointer: the main contract neither restricts nor briefs
  // it, and a no-contract completion there lands in the worktree's own
  // .amber/ under the worktree's project name.
  check(
    'a linked worktree outside the zone without a pointer is its own zone (no contract applies)',
    e1At(side, path.join(side, 'plugin', 'x.cjs')) === null &&
      e1At(side, path.join(side, 'secrets.txt')) === null,
  );
  const s0Side = runHook(
    'S0',
    { session_id: 'wt0', cwd: side, model: 'm' },
    home,
  ).out;
  const ctxSide = contextOf(s0Side);
  check(
    'S0 in a sibling worktree without a pointer briefs no active contract, not the main contract',
    !!ctxSide &&
      /no active contract in this zone/.test(stringOf(ctxSide)) &&
      !/an active contract governs this zone/.test(stringOf(ctxSide)),
    ctxSide,
  );
  check(
    'S0 in a sibling worktree names the main checkout and its active contract',
    !!ctxSide &&
      /linked worktree of \S*\/wtz and a zone of its own/.test(
        stringOf(ctxSide),
      ) &&
      /main checkout has an active contract - test-boundary\.md/.test(
        stringOf(ctxSide),
      ),
    ctxSide,
  );
  const sideNoContract = done(
    side,
    home,
    ['--review', 'r', '--summary', 'sibling no-contract done'],
    { AMBER_SESSION_ID: 'wt0' },
  );
  check(
    'done in a sibling worktree without a pointer signals in that worktree',
    sideNoContract.status === 0 &&
      fs.existsSync(path.join(side, '.amber', 'done.json')) &&
      !fs.existsSync(path.join(zone, '.amber', 'done.json')),
    sideNoContract.stderr,
  );
  const sidePlain = runHook(
    'S2',
    {
      session_id: 'wt0',
      cwd: side,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'report',
    },
    home,
  ).out;
  const sideRow = ledger(home).find(
    (r) => get(r, 'summary') === 'sibling no-contract done',
  );
  check(
    'the sibling worktree completion is recorded under its own project name without a contract',
    sidePlain === null &&
      !!sideRow &&
      get(sideRow, 'project') === 'wtz-side' &&
      !has(sideRow, 'contract') &&
      !fs.existsSync(path.join(side, '.amber', 'done.json')) &&
      fs.existsSync(path.join(zone, '.amber', 'active.json')),
    JSON.stringify(sideRow),
  );
  fs.writeFileSync(
    path.join(side, 'side-boundary.md'),
    '# side\n- docs only [machine: write-scope docs/**]\n## Standing rules\n- side rule\n',
  );
  fs.mkdirSync(path.join(side, '.amber'), { recursive: true });
  fs.writeFileSync(
    path.join(side, '.amber', 'active.json'),
    JSON.stringify({
      v: 1,
      boundary: 'side-boundary.md',
      ratified_by: 'operator',
      ratified_at: '2026-09-15',
    }),
  );
  const sideDeny = e1At(side, path.join(side, 'plugin', 'x.cjs'));
  check(
    'a linked worktree with its own pointer is its own zone (its contract governs)',
    isDeny(sideDeny) &&
      /side-boundary\.md/.test(
        stringAt(sideDeny, 'hookSpecificOutput', 'permissionDecisionReason'),
      ) &&
      e1At(side, path.join(side, 'docs', 'a.md')) === null,
    JSON.stringify(sideDeny),
  );
  check(
    'the main zone is unaffected by the side zone',
    e1At(zone, path.join(zone, 'plugin', 'x.cjs')) === null &&
      isDeny(e1At(zone, path.join(zone, 'secrets.txt'))),
  );
  const s0 = runHook(
    'S0',
    { session_id: 'wt', cwd: side, model: 'm' },
    home,
  ).out;
  const ctx = contextOf(s0);
  check(
    'S0 in the side zone briefs the side contract',
    !!ctx &&
      /side-boundary\.md/.test(stringOf(ctx)) &&
      /side rule/.test(stringOf(ctx)),
  );
  register(side, home, 'wt');
  const sideDone = done(
    side,
    home,
    ['--review', 'r', '--goal', 'g', '--summary', 'side done'],
    { AMBER_SESSION_ID: 'wt' },
  );
  check(
    'done in the side zone signals the side contract',
    sideDone.status === 0 &&
      fs.existsSync(path.join(side, '.amber', 'done.json')) &&
      !fs.existsSync(path.join(zone, '.amber', 'done.json')),
    sideDone.stderr,
  );
  const sidePass = runHook(
    'S2',
    {
      session_id: 'wt',
      cwd: side,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'report',
    },
    home,
  ).out;
  check(
    'the side run completes and releases only its own pointer',
    sidePass === null &&
      !fs.existsSync(path.join(side, '.amber', 'active.json')) &&
      fs.existsSync(path.join(zone, '.amber', 'active.json')) &&
      ledger(home).some(
        (r) =>
          get(r, 'contract') === 'side-boundary.md' &&
          get(r, 'gate') === 'passed',
      ),
    JSON.stringify(sidePass),
  );
  fs.writeFileSync(
    path.join(side, '.amber', 'active.json'),
    JSON.stringify({
      v: 1,
      boundary: 'side-boundary.md',
      ratified_by: 'operator',
      ratified_at: '2026-09-15',
    }),
  );
  register(zone, home, 'mn');
  done(zone, home, OK_DONE, { AMBER_SESSION_ID: 'mn' });
  const mainPass = runHook(
    'S2',
    {
      session_id: 'mn',
      cwd: zone,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'report',
    },
    home,
  ).out;
  check(
    "a sibling worktree zone does not block the main run's completion",
    mainPass === null &&
      !fs.existsSync(path.join(zone, '.amber', 'active.json')) &&
      fs.existsSync(path.join(side, '.amber', 'active.json')) &&
      ledger(home).some(
        (r) =>
          get(r, 'contract') === 'test-boundary.md' &&
          get(r, 'gate') === 'passed',
      ),
    JSON.stringify(mainPass),
  );
}

// ---- post-hoc scope check: verified/done compare git-changed files with the write-scope ----
{
  const RECORD = path.join(PLUGIN, 'scripts', 'record.cjs');
  const SCOPE_BOUNDARY = [
    '# boundary - scope test contract',
    '',
    '## forbidden lines',
    '- writes stay inside plugin/ [machine: write-scope plugin/**]',
    '- docs are writable too [machine: write-scope docs/*.md]',
    '',
    '## goal test',
    '- all cases pass',
  ].join('\n');
  const SCOPE_PLAN = [
    '## Work units',
    '- [ ] U1 plugin part [unit: U1 scope=plugin/** oracle=true]',
    '- [ ] U2 docs part [unit: U2 scope=docs/*.md after=U1 oracle=true]',
  ].join('\n');
  const zone = makeZone('scope', SCOPE_BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-09-16',
  });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(zone, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), SCOPE_PLAN);
  fs.writeFileSync(path.join(zone, '.gitignore'), '.amber/\n');
  fs.writeFileSync(path.join(zone, 'top.txt'), 'x\n');
  fs.writeFileSync(path.join(zone, 'other.txt'), 'y\n');
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', zone, ...args], { encoding: 'utf8' }).trim();
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git(
    'commit',
    '-q',
    '-m',
    'init - adds the contract file, so this is the baseline',
  );
  const baseline = git('rev-parse', 'HEAD');
  // Dirty before the run begins: a modified tracked file and an untracked
  // file, both outside the write-scope - the run must not be charged for them.
  fs.appendFileSync(path.join(zone, 'top.txt'), 'pre-run edit\n');
  fs.writeFileSync(path.join(zone, 'preexist.txt'), 'pre\n');
  const home = freshHome('scope');
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = (): unknown =>
    parseJson(fs.readFileSync(progressFile, 'utf8'));
  const record = (args: readonly string[]): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD, ...args], {
      cwd: zone,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AMBER_HOME: home,
        AMBER_SESSION_ID: 'scope-shell',
      },
    });
  const rows = (trigger: string): unknown[] =>
    ledger(home).filter((r) => get(r, 'trigger') === trigger);
  const SCOPE_DONE = [
    '--review',
    'checked',
    '--goal',
    'met',
    '--summary',
    'scope run complete',
  ];
  const STRAY = ['--out-of-scope', 'stray.md=generated by the tool'];

  record(['unit', 'init', 'docs/plan.md']);
  check(
    'unit init snapshots the paths already dirty when the run begins',
    list(get(progress(), 'preexisting')).slice().sort().join() ===
      'preexist.txt,top.txt',
    JSON.stringify(get(progress(), 'preexisting')),
  );
  // The pointer was hand-written (no baseline), so init took the content
  // baseline itself: the HEAD and the blob hash of each pre-run path.
  check(
    'unit init under a hand-written pointer records its own content baseline',
    at(progress(), 'baseline', 'commit') === baseline &&
      at(progress(), 'baseline', 'manifest', 'top.txt') ===
        git('hash-object', 'top.txt') &&
      at(progress(), 'baseline', 'manifest', 'preexist.txt') ===
        git('hash-object', 'preexist.txt'),
    JSON.stringify(at(progress(), 'baseline')),
  );
  record(['unit', 'start', 'U1']);
  fs.writeFileSync(path.join(zone, 'plugin', 'new.cjs'), 'ok\n');
  const inScope = record([
    'unit',
    'verified',
    'U1',
    '--evidence',
    'in-scope file only',
  ]);
  check(
    'verified passes when every change is inside the write-scope (pre-run dirt excepted)',
    inScope.status === 0 &&
      get(progress(), 'units', 'U1', 'status') === 'verified',
    inScope.stderr,
  );
  check(
    'a clean verified row carries no out_of_scope field',
    rows('unit-verified').length === 1 &&
      !has(rows('unit-verified')[0], 'out_of_scope'),
  );
  const u1Verified = list(get(progress(), 'units', 'U1', 'history')).slice(
    -1,
  )[0];
  check(
    'verified records the paths the unit changed on its history entry and their count in the ledger row',
    JSON.stringify(get(u1Verified, 'files')) ===
      JSON.stringify(['plugin/new.cjs']) &&
      get(u1Verified, 'files_count') === 1 &&
      get(rows('unit-verified')[0], 'files_count') === 1 &&
      !has(rows('unit-verified')[0], 'files'),
    JSON.stringify(u1Verified) + JSON.stringify(rows('unit-verified')[0]),
  );

  record(['unit', 'start', 'U2']);
  fs.writeFileSync(path.join(zone, 'stray.md'), 'made through the shell\n');
  const refused = record(['unit', 'verified', 'U2', '--evidence', 'x']);
  check(
    'verified refuses an undeclared untracked file outside the write-scope',
    refused.status !== 0 &&
      /working-tree\s+stray\.md/.test(refused.stderr) &&
      /--out-of-scope/.test(refused.stderr) &&
      get(progress(), 'units', 'U2', 'status') === 'running',
    refused.stderr,
  );
  check(
    'a refused verified writes no ledger row and no history entry',
    rows('unit-verified').length === 1 &&
      get(progress(), 'units', 'U2', 'history', 'length') === 1,
  );
  const failedRun = record([
    'unit',
    'failed',
    'U2',
    '--evidence',
    'oracle red',
  ]);
  check(
    'failed is not gated by the scope check',
    failedRun.status === 0 &&
      get(progress(), 'units', 'U2', 'status') === 'failed',
    failedRun.stderr,
  );
  const declared = record([
    'unit',
    'verified',
    'U2',
    '--evidence',
    'x',
    ...STRAY,
  ]);
  const declRow = rows('unit-verified')[1];
  check(
    'verified passes with the file declared and records the declaration',
    declared.status === 0 &&
      get(progress(), 'units', 'U2', 'status') === 'verified' &&
      !!declRow &&
      get(declRow, 'out_of_scope_count') === 1 &&
      get(declRow, 'out_of_scope', 0, 'path') === 'stray.md' &&
      get(declRow, 'out_of_scope', 0, 'reason') === 'generated by the tool' &&
      get(
        list(get(progress(), 'units', 'U2', 'history')).slice(-1)[0],
        'out_of_scope',
        0,
        'path',
      ) === 'stray.md',
    (declared.stderr || '') + JSON.stringify(declRow),
  );
  const u2History = list(get(progress(), 'units', 'U2', 'history'));
  const u2Failed = u2History.find((h) => get(h, 'event') === 'failed');
  const u2Verified = u2History.slice(-1)[0];
  check(
    'a later unit is charged only with the paths changed since the earlier verified unit, and failed carries no files',
    JSON.stringify(get(u2Verified, 'files')) === JSON.stringify(['stray.md']) &&
      get(u2Verified, 'files_count') === 1 &&
      get(declRow, 'files_count') === 1 &&
      !!u2Failed &&
      !has(u2Failed, 'files') &&
      !has(u2Failed, 'files_count'),
    JSON.stringify(u2History),
  );

  // done: a tracked file outside the scope modified through the shell, then reverted
  runHook(
    'S0',
    { session_id: 's2-test', cwd: zone, model: 'scope-model' },
    home,
  );
  register(zone, home, 's2-test');
  fs.appendFileSync(path.join(zone, 'other.txt'), 'shell edit\n');
  const modRefused = done(zone, home, [...SCOPE_DONE, ...STRAY]);
  check(
    'done refuses an undeclared modified tracked file outside the write-scope',
    modRefused.status !== 0 &&
      /working-tree\s+other\.txt/.test(modRefused.stderr) &&
      !/stray\.md/.test(modRefused.stderr) &&
      !signalExists(zone),
    modRefused.stderr,
  );
  git('checkout', '--', 'other.txt');
  const reverted = done(zone, home, [...SCOPE_DONE, ...STRAY]);
  check(
    'done passes once the out-of-scope edit is reverted',
    reverted.status === 0 && signalExists(zone),
    reverted.stderr,
  );
  fs.unlinkSync(signalPath(zone));
  // a commit since the baseline that touches an out-of-scope file
  fs.appendFileSync(path.join(zone, 'other.txt'), 'committed edit\n');
  git('add', 'other.txt');
  git('commit', '-q', '-m', 'work');
  const commitRefused = done(zone, home, [...SCOPE_DONE, ...STRAY]);
  check(
    'done refuses an undeclared out-of-scope change committed since the contract commit',
    commitRefused.status !== 0 &&
      /committed\s+other\.txt/.test(commitRefused.stderr) &&
      commitRefused.stderr.includes('baseline ' + baseline.slice(0, 7)) &&
      !signalExists(zone),
    commitRefused.stderr,
  );
  // The contract file is frozen while active: an edit through the shell
  // refuses done and cannot be declared away. Restored, done passes with the
  // glob declaration covering stray.md.
  fs.appendFileSync(path.join(zone, 'test-boundary.md'), '\n<!-- note -->\n');
  const tampered = done(zone, home, [
    ...SCOPE_DONE,
    ...STRAY,
    '--out-of-scope',
    'other.txt=hotfix agreed in chat',
    '--out-of-scope',
    'test-boundary.md=note',
  ]);
  check(
    'done refuses a contract file modified since the run began, declared or not',
    tampered.status !== 0 &&
      /test-boundary\.md/.test(tampered.stderr) &&
      /frozen/.test(tampered.stderr) &&
      !signalExists(zone),
    tampered.stderr,
  );
  git('checkout', '--', 'test-boundary.md');
  const declaredDone = done(zone, home, [
    ...SCOPE_DONE,
    '--out-of-scope',
    '*.md=generated by the tool',
    '--out-of-scope',
    'other.txt=hotfix agreed in chat',
  ]);
  const signal = signalExists(zone)
    ? parseJson(fs.readFileSync(signalPath(zone), 'utf8'))
    : null;
  check(
    'done passes with every out-of-scope file declared once the contract file is restored',
    declaredDone.status === 0 &&
      !!signal &&
      get(signal, 'out_of_scope_count') === 2 &&
      list(get(signal, 'out_of_scope'))
        .map((o) => get(o, 'path'))
        .sort()
        .join() === 'other.txt,stray.md',
    (declaredDone.stderr || '') + JSON.stringify(signal),
  );
  const pass = runHook('S2', stopEvent(zone, 'report'), home).out;
  const doneRow = ledger(home).find(
    (r) => get(r, 'trigger') === 'done-declaration',
  );
  check(
    'S2 copies the declared out-of-scope files into the done-declaration row',
    pass === null &&
      !!doneRow &&
      get(doneRow, 'gate') === 'passed' &&
      get(doneRow, 'out_of_scope_count') === 2 &&
      list(get(doneRow, 'out_of_scope')).some(
        (o) =>
          get(o, 'path') === 'other.txt' &&
          /hotfix/.test(stringAt(o, 'reason')),
      ),
    JSON.stringify(doneRow),
  );

  // no git: fail closed
  const nogit = path.join(BASE, 'nogit');
  fs.mkdirSync(path.join(nogit, '.amber'), { recursive: true });
  fs.writeFileSync(path.join(nogit, 'test-boundary.md'), SCOPE_BOUNDARY);
  fs.writeFileSync(
    path.join(nogit, '.amber', 'active.json'),
    JSON.stringify({
      v: 1,
      boundary: 'test-boundary.md',
      ratified_by: 'operator',
      ratified_at: '2026-09-16',
    }),
  );
  fs.writeFileSync(
    path.join(nogit, '.amber', 'progress.json'),
    JSON.stringify({
      v: 1,
      contract: 'test-boundary.md',
      plan: 'plan.md',
      units: {},
    }),
  );
  const nogitDone = done(nogit, home, SCOPE_DONE);
  check(
    'done refuses when the zone is not a git repository',
    nogitDone.status !== 0 &&
      /not inside a git repository/.test(nogitDone.stderr) &&
      !fs.existsSync(path.join(nogit, '.amber', 'done.json')),
    nogitDone.stderr,
  );
  // no contract: the declaration flag is refused like --goal
  const plainDecl = done(zoneEmpty, home, [
    '--review',
    'r',
    '--summary',
    's',
    '--out-of-scope',
    'x=y',
  ]);
  check(
    'done refuses --out-of-scope without a contract',
    plainDecl.status !== 0 && /omit --out-of-scope/.test(plainDecl.stderr),
    plainDecl.stderr,
  );
}

// ---- scope check baseline when no commit added the contract file ----
{
  const RECORD = path.join(PLUGIN, 'scripts', 'record.cjs');
  const PLAN = [
    '## Work units',
    '- [ ] U1 code [unit: U1 scope=src/** oracle=true]',
  ].join('\n');
  const zone = makeZone(
    'uncommitted',
    [
      '# boundary - uncommitted contract',
      '- code [machine: write-scope src/**]',
      '- docs [machine: write-scope docs/*.md]',
    ].join('\n'),
    {
      v: 1,
      boundary: 'test-boundary.md',
      ratified_by: 'operator',
      ratified_at: '2026-10-19',
    },
  );
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(zone, 'src'), { recursive: true });
  fs.writeFileSync(path.join(zone, '.gitignore'), '.amber/\n');
  fs.writeFileSync(path.join(zone, 'README.md'), 'r\n');
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', zone, ...args], { encoding: 'utf8' }).trim();
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  // Only the README is committed: the contract file never was, so no commit
  // added it and the old baseline query finds nothing.
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init - the contract file stays uncommitted');
  const head = git('rev-parse', 'HEAD');
  const home = freshHome('uncommitted');
  const progress = (): unknown =>
    parseJson(
      fs.readFileSync(path.join(zone, '.amber', 'progress.json'), 'utf8'),
    );
  const record = (args: readonly string[]): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD, ...args], {
      cwd: zone,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AMBER_HOME: home,
        AMBER_SESSION_ID: 'uncommitted-shell',
      },
    });
  record(['unit', 'init', 'docs/plan.md']);
  check(
    'unit init records the HEAD as baseline_commit',
    get(progress(), 'baseline_commit') === head,
    JSON.stringify(get(progress(), 'baseline_commit')),
  );
  record(['unit', 'start', 'U1']);
  fs.writeFileSync(
    path.join(zone, 'outside.txt'),
    'committed past the scope\n',
  );
  git('add', 'outside.txt');
  git('commit', '-q', '-m', 'an out-of-scope file, committed');
  const refused = record([
    'unit',
    'verified',
    'U1',
    '--evidence',
    'oracle ran',
  ]);
  check(
    'verified refuses an out-of-scope commit although no commit added the contract file',
    refused.status !== 0 &&
      /committed\s+outside\.txt/.test(refused.stderr) &&
      get(progress(), 'units', 'U1', 'status') === 'running',
    refused.stderr,
  );
  check(
    'the refusal names the recorded baseline',
    refused.stderr.includes('(baseline ' + head.slice(0, 7) + ')'),
    refused.stderr,
  );
}

// ---- a tree without a commit records no baseline ----
{
  const RECORD = path.join(PLUGIN, 'scripts', 'record.cjs');
  const zone = makeZone('nocommit', BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-10-19',
  });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(zone, 'docs', 'plan.md'),
    '## Work units\n- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]\n',
  );
  const home = freshHome('nocommit');
  spawnSync('node', [RECORD, 'unit', 'init', 'docs/plan.md'], {
    cwd: zone,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, AMBER_HOME: home, AMBER_SESSION_ID: 'nocommit' },
  });
  check(
    'unit init in a tree without a commit stores no baseline_commit key',
    !has(
      parseJson(
        fs.readFileSync(path.join(zone, '.amber', 'progress.json'), 'utf8'),
      ),
      'baseline_commit',
    ),
  );
}

// ---- activate: the pointer and the content baseline written by one command ----
{
  const RECORD = path.join(PLUGIN, 'scripts', 'record.cjs');
  const zone = makeZone('activate', null, null);
  fs.writeFileSync(path.join(zone, '.gitignore'), '.amber/\n');
  fs.writeFileSync(
    path.join(zone, 'contract.md'),
    '- code [machine: write-scope src/**]\n',
  );
  fs.writeFileSync(path.join(zone, 'top.txt'), 'x\n');
  fs.writeFileSync(path.join(zone, 'gone.txt'), 'g\n');
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', zone, ...args], { encoding: 'utf8' }).trim();
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const head = git('rev-parse', 'HEAD');
  // Dirty before activation: a modified tracked file, an untracked file and
  // a deleted file.
  fs.appendFileSync(path.join(zone, 'top.txt'), 'pre-run edit\n');
  fs.writeFileSync(path.join(zone, 'untracked.txt'), 'new\n');
  fs.unlinkSync(path.join(zone, 'gone.txt'));
  const objectsBefore = git('count-objects', '-v');
  const home = freshHome('activate');
  const record = (
    args: readonly string[],
    cwd = zone,
  ): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AMBER_HOME: home,
        AMBER_SESSION_ID: 'activate-shell',
      },
    });
  const pointerFile = path.join(zone, '.amber', 'active.json');
  // Lenient reads: the reference build of the parity harness has no activate
  // and writes no pointer, and its run of this file must not abort here.
  const pointer = (): unknown =>
    fs.existsSync(pointerFile)
      ? parseJson(fs.readFileSync(pointerFile, 'utf8'))
      : null;
  const pointerText = (): string =>
    fs.existsSync(pointerFile) ? fs.readFileSync(pointerFile, 'utf8') : '';
  const sorted = (value: unknown): string =>
    Array.isArray(value) ? value.map(String).sort().join() : '';
  const activated = record([
    'activate',
    'contract.md',
    '--by',
    'operator',
    '--at',
    '2026-10-21',
  ]);
  check(
    'activate writes the pointer and exits 0',
    activated.status === 0 && fs.existsSync(pointerFile),
    activated.stderr,
  );
  check(
    'the pointer keeps the schema-v1 fields',
    at(pointer(), 'v') === 1 &&
      at(pointer(), 'boundary') === 'contract.md' &&
      at(pointer(), 'ratified_by') === 'operator' &&
      at(pointer(), 'ratified_at') === '2026-10-21',
    JSON.stringify(pointer()),
  );
  check(
    'baseline.commit is the HEAD at activation',
    at(pointer(), 'baseline', 'commit') === head,
    JSON.stringify(at(pointer(), 'baseline')),
  );
  check(
    'the manifest hashes the modified tracked file',
    at(pointer(), 'baseline', 'manifest', 'top.txt') ===
      git('hash-object', 'top.txt'),
    JSON.stringify(at(pointer(), 'baseline', 'manifest')),
  );
  check(
    'the manifest hashes the untracked file',
    at(pointer(), 'baseline', 'manifest', 'untracked.txt') ===
      git('hash-object', 'untracked.txt'),
  );
  check(
    'the manifest records a deleted file as null',
    // at() yields undefined for a missing key and null only for a null value
    at(pointer(), 'baseline', 'manifest', 'gone.txt') === null,
  );
  check(
    'contract_blob is the hash of the contract file',
    at(pointer(), 'baseline', 'contract_blob') ===
      git('hash-object', 'contract.md'),
  );
  check(
    'activate writes no object and leaves the working tree as it was',
    git('count-objects', '-v') === objectsBefore &&
      git('status', '--porcelain').includes(' M top.txt'),
    git('status', '--porcelain'),
  );
  const activateRows = ledger(home).filter(
    (r) => get(r, 'trigger') === 'activate',
  );
  check(
    'activate records one ledger row carrying the baseline commit',
    activateRows.length === 1 &&
      at(activateRows[0], 'baseline_commit') === head &&
      at(activateRows[0], 'pre_run_paths') === 3,
    JSON.stringify(activateRows),
  );
  const before = pointerText();
  const again = record(['activate', 'contract.md', '--by', 'operator']);
  check(
    'a second activate refuses and leaves the pointer unchanged',
    again.status !== 0 &&
      /already exists/.test(again.stderr) &&
      pointerText() === before,
    again.stderr,
  );
  if (fs.existsSync(pointerFile)) fs.unlinkSync(pointerFile);
  const missing = record(['activate', 'nope.md', '--by', 'operator']);
  check(
    'activate refuses a missing contract file',
    missing.status !== 0 &&
      /not found/.test(missing.stderr) &&
      !fs.existsSync(pointerFile),
    missing.stderr,
  );
  const noBy = record(['activate', 'contract.md']);
  check(
    'activate refuses without --by',
    noBy.status !== 0 &&
      /--by/.test(noBy.stderr) &&
      !fs.existsSync(pointerFile),
    noBy.stderr,
  );
  const nogit = path.join(BASE, 'activate-nogit');
  fs.mkdirSync(nogit, { recursive: true });
  fs.writeFileSync(path.join(nogit, 'contract.md'), 'c\n');
  const outside = record(
    ['activate', 'contract.md', '--by', 'operator'],
    nogit,
  );
  check(
    'activate refuses outside a git repository',
    outside.status !== 0 &&
      /git repository/.test(outside.stderr) &&
      !fs.existsSync(path.join(nogit, '.amber', 'active.json')),
    outside.stderr,
  );
  // unit init under an activated pointer: the pointer's baseline applies and
  // init records none of its own; the compatibility fields follow it.
  fs.writeFileSync(
    path.join(zone, 'plan.md'),
    '## Work units\n- [ ] U1 one [unit: U1 scope=src/** oracle=true]\n',
  );
  record(['activate', 'contract.md', '--by', 'operator', '--at', '2026-10-21']);
  record(['unit', 'init', 'plan.md']);
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = (): unknown =>
    fs.existsSync(progressFile)
      ? parseJson(fs.readFileSync(progressFile, 'utf8'))
      : null;
  check(
    'unit init under an activated pointer stores no baseline of its own',
    at(progress(), 'baseline') === undefined &&
      at(progress(), 'baseline_commit') === head,
    JSON.stringify(progress()),
  );
  check(
    "preexisting lists the pointer's pre-run paths (compatibility field)",
    sorted(at(progress(), 'preexisting')) ===
      'gone.txt,plan.md,top.txt,untracked.txt',
    JSON.stringify(at(progress(), 'preexisting')),
  );
}

// ---- content baseline: a pre-run edit is excused only while its content stays ----
{
  const RECORD = path.join(PLUGIN, 'scripts', 'record.cjs');
  const CONTRACT = '- code [machine: write-scope src/**]\n';
  const PLAN =
    '## Work units\n- [ ] U1 code [unit: U1 scope=src/** oracle=true]\n';
  const CONTENT_DONE = [
    '--review',
    'checked',
    '--goal',
    'met',
    '--summary',
    'content probe',
  ];
  interface Flow {
    readonly zone: string;
    readonly git: (...a: string[]) => string;
    readonly record: (a: readonly string[]) => SpawnSyncReturns<string>;
  }
  let n = 0;
  // A zone with one commit (.gitignore, top.txt, plan.md and, unless told
  // otherwise, the contract), dirty before the run begins: top.txt modified
  // and pre.txt untracked, both outside the write-scope.
  function flow(tag: string, commitContract = true): Flow {
    n += 1;
    const zone = makeZone('content-' + tag + '-' + String(n), null, null);
    fs.writeFileSync(path.join(zone, '.gitignore'), '.amber/\n');
    fs.writeFileSync(path.join(zone, 'top.txt'), 'x\n');
    fs.writeFileSync(path.join(zone, 'contract.md'), CONTRACT);
    fs.writeFileSync(path.join(zone, 'plan.md'), PLAN);
    fs.mkdirSync(path.join(zone, 'src'));
    const git = (...a: string[]): string =>
      execFileSync('git', ['-C', zone, ...a], { encoding: 'utf8' }).trim();
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('add', '.gitignore', 'top.txt', 'plan.md');
    if (commitContract) git('add', 'contract.md');
    git('commit', '-q', '-m', 'init');
    fs.appendFileSync(path.join(zone, 'top.txt'), 'pre-run edit\n');
    fs.writeFileSync(path.join(zone, 'pre.txt'), 'pre\n');
    const home = freshHome('content-' + tag + '-' + String(n));
    const record = (a: readonly string[]): SpawnSyncReturns<string> =>
      spawnSync('node', [RECORD, ...a], {
        cwd: zone,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          AMBER_HOME: home,
          AMBER_SESSION_ID: 'content-shell',
        },
      });
    return { zone, git, record };
  }
  // A run with a plan the old way: hand-written pointer, so unit init takes
  // the baseline itself; then U1 starts.
  function started(tag: string): Flow {
    const f = flow(tag);
    fs.mkdirSync(path.join(f.zone, '.amber'), { recursive: true });
    fs.writeFileSync(
      path.join(f.zone, '.amber', 'active.json'),
      JSON.stringify({
        v: 1,
        boundary: 'contract.md',
        ratified_by: 'operator',
        ratified_at: '2026-10-21',
      }),
    );
    f.record(['unit', 'init', 'plan.md']);
    f.record(['unit', 'start', 'U1']);
    return f;
  }
  const verify = (f: Flow): SpawnSyncReturns<string> =>
    f.record(['unit', 'verified', 'U1', '--evidence', 'oracle ran']);

  const a = started('a');
  fs.appendFileSync(
    path.join(a.zone, 'top.txt'),
    'shell edit during the run\n',
  );
  const aRefused = verify(a);
  check(
    'verified refuses a pre-run dirty file modified again during the run',
    aRefused.status !== 0 && /working-tree\s+top\.txt/.test(aRefused.stderr),
    aRefused.stderr,
  );
  check(
    'the refusal marks the file as modified before the run and warns against git checkout',
    /top\.txt\s+\(already modified before the run began\)/.test(
      aRefused.stderr,
    ) && /Do not `git checkout` these/.test(aRefused.stderr),
    aRefused.stderr,
  );
  const b = started('b');
  fs.writeFileSync(path.join(b.zone, 'src', 'new.txt'), 'ok\n');
  const bOk = verify(b);
  check(
    'verified passes while the pre-run files keep their content',
    bOk.status === 0,
    bOk.stderr,
  );
  const c = started('c');
  fs.appendFileSync(path.join(c.zone, 'pre.txt'), 'more\n');
  const cRefused = verify(c);
  check(
    'verified refuses a pre-run untracked file whose content changed',
    cRefused.status !== 0 &&
      /pre\.txt\s+\(already modified before the run began\)/.test(
        cRefused.stderr,
      ),
    cRefused.stderr,
  );
  const d = started('d');
  fs.unlinkSync(path.join(d.zone, 'pre.txt'));
  const dRefused = verify(d);
  check(
    'verified refuses when a pre-run untracked file was deleted during the run',
    dRefused.status !== 0 && /pre\.txt/.test(dRefused.stderr),
    dRefused.stderr,
  );
  const e = started('e');
  fs.writeFileSync(path.join(e.zone, 'stray.txt'), 'stray\n');
  const eRefused = verify(e);
  check(
    'a fresh out-of-scope file is refused without the pre-run warning',
    eRefused.status !== 0 &&
      /stray\.txt/.test(eRefused.stderr) &&
      !/before the run/.test(eRefused.stderr),
    eRefused.stderr,
  );
  // plan-less: activate records the pre-run dirt, so done needs no declaration
  const f = flow('planless');
  f.record(['activate', 'contract.md', '--by', 'operator']);
  const fOk = f.record(['done', ...CONTENT_DONE]);
  check(
    'plan-less done passes without declaring the files that were dirty at activation',
    fOk.status === 0 && fs.existsSync(path.join(f.zone, '.amber', 'done.json')),
    fOk.stderr,
  );
  // plan-less with the contract file never committed: the recorded commit is
  // the baseline, so a commit past the scope is still caught
  const g = flow('uncommitted', false);
  g.record(['activate', 'contract.md', '--by', 'operator']);
  fs.writeFileSync(path.join(g.zone, 'outside.txt'), 'o\n');
  g.git('add', 'outside.txt');
  g.git('commit', '-q', '-m', 'outside');
  const gRefused = g.record(['done', ...CONTENT_DONE]);
  check(
    'plan-less done refuses an out-of-scope commit after activation although no commit added the contract file',
    gRefused.status !== 0 && /committed\s+outside\.txt/.test(gRefused.stderr),
    gRefused.stderr,
  );
  // a baseline whose commit is not a hash refuses as malformed
  const h = flow('malformed');
  h.record(['activate', 'contract.md', '--by', 'operator']);
  const pointerFile = path.join(h.zone, '.amber', 'active.json');
  const recorded = fs.existsSync(pointerFile)
    ? parseJson(fs.readFileSync(pointerFile, 'utf8'))
    : null;
  fs.mkdirSync(path.dirname(pointerFile), { recursive: true });
  fs.writeFileSync(
    pointerFile,
    JSON.stringify({
      v: 1,
      boundary: 'contract.md',
      ratified_by: 'operator',
      ratified_at: '2026-10-21',
      baseline: {
        commit: 'not-a-sha',
        manifest: at(recorded, 'baseline', 'manifest'),
        contract_blob: at(recorded, 'baseline', 'contract_blob'),
        taken_at: 'x',
      },
    }),
  );
  const hRefused = h.record(['done', ...CONTENT_DONE]);
  check(
    'a baseline whose commit is not a git hash refuses as malformed',
    hRefused.status !== 0 &&
      /malformed/.test(hRefused.stderr) &&
      /commit/.test(hRefused.stderr),
    hRefused.stderr,
  );
  // the contract file edited through the shell after activation
  const i = flow('tamper');
  i.record(['activate', 'contract.md', '--by', 'operator']);
  fs.appendFileSync(path.join(i.zone, 'contract.md'), '\n<!-- note -->\n');
  const iRefused = i.record([
    'done',
    ...CONTENT_DONE,
    '--out-of-scope',
    'contract.md=note',
  ]);
  check(
    'done refuses a contract file edited after activation even when declared',
    iRefused.status !== 0 &&
      /contract\.md/.test(iRefused.stderr) &&
      /frozen/.test(iRefused.stderr),
    iRefused.stderr,
  );
  i.git('checkout', '--', 'contract.md');
  const iOk = i.record(['done', ...CONTENT_DONE]);
  check(
    'done passes once the contract file is restored',
    iOk.status === 0,
    iOk.stderr,
  );
  // The integrity check does not depend on the contract's rows: a contract
  // whose write-scope rows were removed through the shell still refuses.
  const j = flow('scope-rows');
  j.record(['activate', 'contract.md', '--by', 'operator']);
  fs.writeFileSync(
    path.join(j.zone, 'contract.md'),
    '- no machine rows left\n',
  );
  const jRefused = j.record(['done', ...CONTENT_DONE]);
  check(
    'done refuses a contract whose write-scope rows were removed after activation',
    jRefused.status !== 0 && /frozen/.test(jRefused.stderr),
    jRefused.stderr,
  );
  const k = started('scope-rows-unit');
  fs.writeFileSync(
    path.join(k.zone, 'contract.md'),
    '- no machine rows left\n',
  );
  const kRefused = verify(k);
  check(
    'verified refuses a contract whose write-scope rows were removed after the run began',
    kRefused.status !== 0 && /frozen/.test(kRefused.stderr),
    kRefused.stderr,
  );
  // A path named like an Object property is a change like any other.
  const l = started('proto');
  fs.writeFileSync(path.join(l.zone, 'constructor'), 'c\n');
  const lRefused = verify(l);
  check(
    'verified refuses a new out-of-scope file named constructor',
    lRefused.status !== 0 && /working-tree\s+constructor/.test(lRefused.stderr),
    lRefused.stderr,
  );
  // A baseline that is present but not the recorded shape refuses as
  // malformed instead of counting as none.
  const m = flow('manifest-null');
  m.record(['activate', 'contract.md', '--by', 'operator']);
  const mPointer = path.join(m.zone, '.amber', 'active.json');
  fs.mkdirSync(path.dirname(mPointer), { recursive: true });
  fs.writeFileSync(
    mPointer,
    JSON.stringify({
      v: 1,
      boundary: 'contract.md',
      ratified_by: 'operator',
      ratified_at: '2026-10-21',
      baseline: {
        commit: null,
        manifest: null,
        contract_blob: null,
        taken_at: 'x',
      },
    }),
  );
  const mRefused = m.record(['done', ...CONTENT_DONE]);
  check(
    'a baseline whose manifest is not an object refuses as malformed instead of counting as none',
    mRefused.status !== 0 && /malformed/.test(mRefused.stderr),
    mRefused.stderr,
  );
  // A pre-run edit committed as it was is reported as committed and still
  // marked as a pre-run file.
  const o = started('committed-pre-run');
  o.git('add', 'top.txt');
  o.git('commit', '-q', '-m', 'commit the pre-run edit');
  const oRefused = verify(o);
  check(
    'a pre-run edit committed unchanged is reported as committed and marked as pre-run',
    oRefused.status !== 0 &&
      /committed\s+top\.txt\s+\(already modified before the run began\)/.test(
        oRefused.stderr,
      ),
    oRefused.stderr,
  );
  // A baseline recorded before the first commit: every path committed since
  // counts, instead of falling back to the commit that added the contract.
  const nZone = makeZone('content-nocommit', null, null);
  fs.writeFileSync(path.join(nZone, '.gitignore'), '.amber/\n');
  fs.writeFileSync(path.join(nZone, 'contract.md'), CONTRACT);
  const nGit = (...a: string[]): string =>
    execFileSync('git', ['-C', nZone, ...a], { encoding: 'utf8' }).trim();
  nGit('config', 'user.email', 't@t');
  nGit('config', 'user.name', 't');
  const nHome = freshHome('content-nocommit');
  const nRecord = (a: readonly string[]): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD, ...a], {
      cwd: nZone,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AMBER_HOME: nHome,
        AMBER_SESSION_ID: 'content-shell',
      },
    });
  nRecord(['activate', 'contract.md', '--by', 'operator']);
  fs.writeFileSync(path.join(nZone, 'outside.txt'), 'o\n');
  nGit('add', 'outside.txt');
  nGit('commit', '-q', '-m', 'first commit, past the scope');
  const nRefused = nRecord(['done', ...CONTENT_DONE]);
  check(
    'a baseline recorded before the first commit counts every path committed since',
    nRefused.status !== 0 && /committed\s+outside\.txt/.test(nRefused.stderr),
    nRefused.stderr,
  );
}

// ---- CLAUDE_CODE_SESSION_ID attribution: the Claude Code tool shell carries the hooks' session id ----
{
  const PLAN = [
    '## Work units',
    '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]',
    '- [ ] U2 two [unit: U2 scope=docs/*.md oracle=true]',
  ].join('\n');
  const zone = makeZone('ccattr', BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-09-17',
  });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const home = freshHome('ccattr');
  // Only CLAUDE_CODE_SESSION_ID is set; the other ids are blanked whatever the
  // runner's own environment carries.
  const cc = (
    args: readonly string[],
    extraEnv?: NodeJS.ProcessEnv,
  ): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD_CLI, ...args], {
      cwd: zone,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AMBER_HOME: home,
        AMBER_SESSION_ID: '',
        CODEX_THREAD_ID: '',
        CLAUDE_CODE_SESSION_ID: 'cc-sess',
        PI_SESSION_ID: '',
        ...extraEnv,
      },
    });
  const lastRow = (): unknown => ledger(home).slice(-1)[0] || {};
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'state', 'session-cc-sess.json'),
    JSON.stringify({ model: 'm-cc' }),
  );
  const init = cc(['unit', 'init', 'docs/plan.md']);
  check(
    'a unit init row takes CLAUDE_CODE_SESSION_ID',
    init.status === 0 &&
      get(lastRow(), 'trigger') === 'unit-init' &&
      get(lastRow(), 'session_id') === 'cc-sess',
    (init.stderr || '') + JSON.stringify(lastRow()),
  );
  const start = cc(['unit', 'start', 'U1']);
  check(
    'a unit start row takes CLAUDE_CODE_SESSION_ID and the model of that session state',
    start.status === 0 &&
      get(lastRow(), 'trigger') === 'unit-start' &&
      get(lastRow(), 'session_id') === 'cc-sess' &&
      get(lastRow(), 'model') === 'm-cc',
    (start.stderr || '') + JSON.stringify(lastRow()),
  );
  const env = cc(['unit', 'start', 'U2'], { AMBER_SESSION_ID: 'env-id' });
  check(
    'AMBER_SESSION_ID wins over CLAUDE_CODE_SESSION_ID',
    env.status === 0 && get(lastRow(), 'session_id') === 'env-id',
    (env.stderr || '') + JSON.stringify(lastRow()),
  );
}

// ---- S1: typed init sensor ----
{
  const home = freshHome('s1init');
  runHook(
    'S0',
    { session_id: 's1-init', cwd: zoneEmpty, model: 'claude-fable-5' },
    home,
  );
  const typed = (prompt: string): HookRun =>
    runHook('S1', { session_id: 's1-init', cwd: zoneEmpty, prompt }, home);
  typed('/amber:init some args');
  let recs = ledger(home);
  check(
    'S1 records a typed /amber:init as a bare skill-invocation row',
    recs.length === 1 &&
      get(recs, 0, 'trigger') === 'skill-invocation' &&
      get(recs, 0, 'summary') === 'amber:init (typed)' &&
      get(recs, 0, 'model') === 'claude-fable-5',
    JSON.stringify(recs),
  );
  typed('$amber:init');
  recs = ledger(home);
  check(
    'S1 records the $ form of a typed init the same way',
    recs.length === 2 &&
      get(recs, 1, 'trigger') === 'skill-invocation' &&
      get(recs, 1, 'summary') === 'amber:init (typed)',
    JSON.stringify(recs),
  );
  typed('/amber:status');
  typed('/amber:initx');
  typed('please /amber:init later');
  check(
    'S1 records neither a typed status nor a near-miss init',
    ledger(home).length === 2,
    JSON.stringify(ledger(home)),
  );
  const res = typed('/amber:planning x');
  recs = ledger(home);
  check(
    'S1 still records a typed planning as a planning-invocation row',
    res.exit === 0 &&
      res.out === null &&
      recs.length === 3 &&
      get(recs, 2, 'trigger') === 'planning-invocation' &&
      get(recs, 2, 'summary') === '/amber:planning x',
    JSON.stringify(recs),
  );
}

// ---- S1: typed audit sensor ----
{
  const home = freshHome('s1audit');
  runHook(
    'S0',
    { session_id: 's1-audit', cwd: zoneEmpty, model: 'claude-fable-5' },
    home,
  );
  const typed = (prompt: string): HookRun =>
    runHook('S1', { session_id: 's1-audit', cwd: zoneEmpty, prompt }, home);
  typed('/amber:audit exclude=amber');
  let recs = ledger(home);
  check(
    'S1 records a typed /amber:audit as a bare skill-invocation row without its arguments',
    recs.length === 1 &&
      get(recs, 0, 'trigger') === 'skill-invocation' &&
      get(recs, 0, 'summary') === 'amber:audit (typed)' &&
      get(recs, 0, 'model') === 'claude-fable-5',
    JSON.stringify(recs),
  );
  typed('$amber:audit');
  recs = ledger(home);
  check(
    'S1 records the $ form of a typed audit the same way',
    recs.length === 2 &&
      get(recs, 1, 'trigger') === 'skill-invocation' &&
      get(recs, 1, 'summary') === 'amber:audit (typed)',
    JSON.stringify(recs),
  );
  typed('/amber:status');
  typed('/amber:auditx');
  typed('please /amber:audit later');
  check(
    'S1 records neither a typed status nor a near-miss audit',
    ledger(home).length === 2,
    JSON.stringify(ledger(home)),
  );
  const res = typed('/amber:planning x');
  recs = ledger(home);
  check(
    'S1 still records a typed planning as a planning-invocation row next to the audit sensor',
    res.exit === 0 &&
      res.out === null &&
      recs.length === 3 &&
      get(recs, 2, 'trigger') === 'planning-invocation' &&
      get(recs, 2, 'summary') === '/amber:planning x',
    JSON.stringify(recs),
  );
}

// ---- external hold: a reason starting with external: stands until the unit's next transition ----
{
  const PLAN = [
    '## Work units',
    '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]',
    '- [ ] U2 two [unit: U2 scope=docs/*.md oracle=true]',
  ].join('\n');
  const zone = makeZone('exthold', BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-09-17',
  });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const home = freshHome('exthold');
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = (): unknown =>
    parseJson(fs.readFileSync(progressFile, 'utf8'));
  const record = (args: readonly string[]): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD_CLI, ...args], {
      cwd: zone,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, AMBER_HOME: home, AMBER_SESSION_ID: 'ext-shell' },
    });
  const holds = (): unknown[] =>
    ledger(home).filter((r) => get(r, 'trigger') === 'unit-hold');
  const stop = (): unknown =>
    runHook(
      'S2',
      {
        session_id: 'drv-ext',
        cwd: zone,
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'waiting',
      },
      home,
    ).out;
  const { holdKind } = loadModule<typeof import('../src/hooks/progress.cjs')>(
    'hooks/progress.cjs',
    ['holdKind'],
  );
  check(
    'holdKind classifies external: case-insensitively with leading whitespace',
    holdKind('external: sweep') === 'external' &&
      holdKind('  EXTERNAL: x') === 'external' &&
      holdKind('externally slow') === null &&
      holdKind('waiting on the operator') === null &&
      holdKind('') === null,
  );
  record(['unit', 'init', 'docs/plan.md']);
  record(['unit', 'start', 'U1']);
  runHook('S0', { session_id: 'drv-ext', cwd: zone, model: 'm' }, home);
  register(zone, home, 'drv-ext');
  const s3 = runHook(
    'S3',
    {
      session_id: 'drv-ext',
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_input: {
        skill: 'amber:mark',
        args: 'hold - U1 - external: waiting on the sweep',
      },
    },
    home,
  ).out;
  check(
    'mark hold with an external: reason stores kind external in progress.json',
    s3 === null &&
      !!get(progress(), 'hold') &&
      get(progress(), 'hold', 'kind') === 'external' &&
      get(progress(), 'hold', 'unit') === 'U1' &&
      /waiting on the sweep/.test(stringAt(progress(), 'hold', 'reason')),
    JSON.stringify(get(progress(), 'hold')),
  );
  check(
    'the mark path puts kind external on the unit-hold ledger row',
    holds().length === 1 &&
      get(holds(), 0, 'kind') === 'external' &&
      get(holds(), 0, 'unit') === 'U1',
    JSON.stringify(holds()),
  );
  const first = stop();
  const second = stop();
  check(
    'an external hold lets every stop of the driving session through and persists',
    first === null &&
      second === null &&
      !!get(progress(), 'hold') &&
      get(progress(), 'hold', 'kind') === 'external' &&
      get(progress(), 'units', 'U1', 'reentries') === 0,
    JSON.stringify([first, second, get(progress(), 'hold')]),
  );
  const brief = runHook(
    'S0',
    { session_id: 'brief-ext', cwd: zone, model: 'm' },
    home,
  ).out;
  const bctx = contextOf(brief);
  check(
    'the S0 briefing names the external hold with its unit, timestamp, and text',
    !!bctx &&
      /external hold on U1 since \S+: external: waiting on the sweep/.test(
        stringOf(bctx),
      ) &&
      /hold: U1 - external since \S+ - external: waiting on the sweep/.test(
        stringOf(bctx),
      ),
    String(bctx).slice(-700),
  );
  const ver = record([
    'unit',
    'verified',
    'U1',
    '--evidence',
    'sweep finished',
  ]);
  check(
    'verified on the held unit releases the external hold',
    ver.status === 0 && get(progress(), 'hold') === null,
    (ver.stderr || '') + JSON.stringify(get(progress(), 'hold')),
  );
  const blocked = stop();
  check(
    'a plain stop with open units is blocked again once the external hold is gone',
    !!(blocked && get(blocked, 'decision') === 'block') &&
      /U2/.test(stringAt(blocked, 'reason')),
    JSON.stringify(blocked),
  );
  const shell = record([
    'unit',
    'hold',
    'U2',
    '--reason',
    'external: long test',
  ]);
  check(
    'record.cjs unit hold with an external: reason yields kind external in progress and ledger',
    shell.status === 0 &&
      get(progress(), 'hold', 'kind') === 'external' &&
      get(progress(), 'hold', 'unit') === 'U2' &&
      holds().length === 2 &&
      get(holds(), 1, 'kind') === 'external',
    (shell.stderr || '') + JSON.stringify(holds()),
  );
  const third = stop();
  check(
    'the shell-recorded external hold passes a stop and persists too',
    third === null &&
      !!get(progress(), 'hold') &&
      get(progress(), 'hold', 'kind') === 'external',
    JSON.stringify(get(progress(), 'hold')),
  );
  const plain = record([
    'unit',
    'hold',
    'U2',
    '--reason',
    'waiting on operator',
  ]);
  check(
    'a plain hold recorded after an external one replaces it (no kind)',
    plain.status === 0 &&
      !!get(progress(), 'hold') &&
      !has(get(progress(), 'hold'), 'kind') &&
      /operator/.test(stringAt(progress(), 'hold', 'reason')) &&
      holds().length === 3 &&
      !has(holds()[2], 'kind'),
    JSON.stringify(get(progress(), 'hold')),
  );
  const once = stop();
  const again = stop();
  check(
    'a plain hold passes exactly one stop',
    once === null && !!(again && get(again, 'decision') === 'block'),
    JSON.stringify([once, again]),
  );
  record(['unit', 'hold', 'U2', '--reason', 'External: mixed case']);
  const startHeld = record(['unit', 'start', 'U2']);
  check(
    'start on the held unit releases the external hold too',
    startHeld.status === 0 && get(progress(), 'hold') === null,
    (startHeld.stderr || '') + JSON.stringify(get(progress(), 'hold')),
  );
  record(['unit', 'hold', 'U2', '--reason', 'external: other unit moves']);
  record(['unit', 'failed', 'U1', '--evidence', 'reopened']);
  check(
    'a transition on another unit leaves the external hold standing',
    !!get(progress(), 'hold') && get(progress(), 'hold', 'kind') === 'external',
    JSON.stringify(get(progress(), 'hold')),
  );
  const failHeld = record([
    'unit',
    'failed',
    'U2',
    '--evidence',
    'the job failed',
  ]);
  check(
    'failed on the held unit releases the external hold too',
    failHeld.status === 0 && get(progress(), 'hold') === null,
    JSON.stringify(get(progress(), 'hold')),
  );
}

// ---- waiting-signal briefing: S0/S1 tell a non-driving session that a completion signal waits ----
{
  const PLAN = [
    '## Work units',
    '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]',
  ].join('\n');
  const zone = makeZone('waitsig', BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-09-17',
  });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const home = freshHome('waitsig');
  spawnSync('node', [RECORD_CLI, 'unit', 'init', 'docs/plan.md'], {
    cwd: zone,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, AMBER_HOME: home, AMBER_SESSION_ID: 'wait-shell' },
  });
  // The answer's additionalContext, null without a hookSpecificOutput.
  const ctxOf = (event: string, id: string): unknown => {
    const out = runHook(
      event,
      { session_id: id, cwd: zone, model: 'm', prompt: 'hello' },
      home,
    ).out;
    return out && get(out, 'hookSpecificOutput')
      ? get(out, 'hookSpecificOutput', 'additionalContext')
      : null;
  };
  for (const id of ['drv', 'talk']) {
    runHook('S0', { session_id: id, cwd: zone, model: 'm' }, home);
  }
  register(zone, home, 'drv');
  check(
    'no waiting line before a signal exists',
    !/completion signal is waiting/.test(stringOf(ctxOf('S0', 'talk'))),
  );
  plantSignal(zone, { summary: 'left by the driver' });
  const s0talk = ctxOf('S0', 'talk');
  check(
    'S0 tells a non-driving session that a completion signal is waiting',
    !!s0talk &&
      /completion signal is waiting/.test(stringOf(s0talk)) &&
      /take the run over/.test(stringOf(s0talk)),
    stringOf(s0talk).slice(-400),
  );
  const s1talk = ctxOf('S1', 'talk');
  check(
    'S1 delivers the waiting line to an already briefed non-driving session',
    !!s1talk &&
      /completion signal is waiting/.test(stringOf(s1talk)) &&
      !/an active contract governs/.test(stringOf(s1talk)),
    stringOf(s1talk),
  );
  const s1new = ctxOf('S1', 'talk2');
  check(
    'S1 briefing for an unbriefed non-driving session carries the waiting line with the briefing',
    !!s1new &&
      /completion signal is waiting/.test(stringOf(s1new)) &&
      /an active contract governs/.test(stringOf(s1new)),
    stringOf(s1new).slice(-400),
  );
  const s0drv = ctxOf('S0', 'drv');
  check(
    'S0 for the driving session carries no waiting line',
    !!s0drv &&
      !/completion signal is waiting/.test(stringOf(s0drv)) &&
      /this session drives the run/.test(stringOf(s0drv)),
    stringOf(s0drv).slice(-400),
  );
  check(
    'the briefing never consumes the signal or records a row',
    signalExists(zone) &&
      ledger(home).every((r) => get(r, 'trigger') !== 'done-declaration'),
  );
  fs.unlinkSync(signalPath(zone));
  check(
    'the waiting line disappears with the signal',
    ctxOf('S1', 'talk') === null,
  );
}

// ---- hook crash breadcrumb: malformed input fails open and is logged ----
{
  const home = freshHome('crash');
  const res = spawnSync('node', [HOOK, 'S1'], {
    input: '{not json',
    env: { ...process.env, AMBER_HOME: home },
    encoding: 'utf8',
    timeout: 10000,
  });
  const log = path.join(home, 'state', 'sensor-failures.log');
  check(
    'a hook crash exits 0 with no output',
    res.status === 0 && (res.stdout || '').trim() === '',
    JSON.stringify([res.status, res.stdout]),
  );
  check(
    'a hook crash leaves a breadcrumb naming the event',
    fs.existsSync(log) &&
      /hook-crash event=S1/.test(fs.readFileSync(log, 'utf8')),
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'no log',
  );
}

// ---- phase: planning and set open a session phase; skip, the pointer and the release close it ----
{
  const home = freshHome('phase');
  const zone = makeZone('phase', null, null);
  const zoneReal = fs.realpathSync(zone);
  fs.mkdirSync(path.join(zone, 'docs'));
  fs.writeFileSync(path.join(zone, 'notes.txt'), 'before planning\n');
  const s0 = (id: string, source?: string, cwd = zone): unknown =>
    contextOf(
      runHook(
        'S0',
        {
          session_id: id,
          cwd,
          model: 'm',
          ...(source === undefined ? {} : { source }),
        },
        home,
      ).out,
    );
  const s3 = (id: string, skill: string, args?: string, cwd = zone): HookRun =>
    runHook(
      'S3',
      {
        session_id: id,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: { skill, ...(args === undefined ? {} : { args }) },
      },
      home,
    );
  const phaseOf = (id: string): unknown => get(sessionState(home, id), 'phase');

  s0('ph-1', 'startup');
  s3('ph-1', 'amber:planning', 'phase gate');
  let ph = phaseOf('ph-1');
  check(
    'planning record opens a planning phase in the zone with a status snapshot',
    get(ph, 'state') === 'planning' &&
      get(ph, 'zone') === zoneReal &&
      /^\d{4}-\d{2}-\d{2}T/.test(stringAt(ph, 'since')) &&
      joined(get(ph, 'snapshot')) === 'notes.txt',
    JSON.stringify(ph),
  );
  check(
    'planning record leaves one ledger row, the invocation itself',
    ledger(home).length === 1 &&
      get(ledger(home), 0, 'trigger') === 'skill-invocation',
    JSON.stringify(ledger(home)),
  );
  const since = stringAt(ph, 'since');
  fs.writeFileSync(path.join(zone, 'shell.txt'), 'written by a shell\n');
  fs.writeFileSync(path.join(zone, 'docs', 'x-contract.md'), '# draft\n');
  s3('ph-1', 'set');
  ph = phaseOf('ph-1');
  check(
    "set record advances the phase and keeps planning's start and snapshot",
    get(ph, 'state') === 'set' &&
      get(ph, 'since') === since &&
      joined(get(ph, 'snapshot')) === 'notes.txt',
    JSON.stringify(ph),
  );
  const compact = stringOf(s0('ph-1', 'compact'));
  check(
    'S0 on compact carries the open phase and briefs it in one line',
    get(phaseOf('ph-1'), 'state') === 'set' &&
      /^amber: no active contract in this zone\./.test(compact) &&
      /amber: set phase since \S+ is still open in this zone: file writes outside planning artifacts/.test(
        compact,
      ) &&
      /stay blocked until a skip record \(amber:mark\) or an approved contract closes it\./.test(
        compact,
      ),
    compact.slice(0, 700),
  );
  const elsewhere = stringOf(s0('ph-1', 'resume', zoneEmpty));
  check(
    'S0 in another zone carries the phase but briefs no phase line there',
    get(phaseOf('ph-1'), 'zone') === zoneReal && !/phase since/.test(elsewhere),
    elsewhere.slice(0, 300),
  );
  check(
    'S0 without a phase briefs no phase line',
    !/phase since/.test(stringOf(s0('ph-0', 'resume'))),
  );
  s3(
    'ph-1',
    'amber:mark',
    'skip - opening verdict - no contract: a doc touch-up',
  );
  const recs = ledger(home);
  const exit = recs[recs.length - 1];
  check(
    'skip record closes the phase and keeps the rest of the session state',
    !has(sessionState(home, 'ph-1'), 'phase') &&
      get(sessionState(home, 'ph-1'), 'model') === 'm',
    JSON.stringify(sessionState(home, 'ph-1')),
  );
  check(
    'skip leaves a phase-exit row after the skip row naming what changed outside planning artifacts',
    recs.length === 4 &&
      get(recs, 2, 'trigger') === 'skip' &&
      get(exit, 'trigger') === 'phase-exit' &&
      get(exit, 'phase') === 'set' &&
      get(exit, 'since') === since &&
      get(exit, 'exit') === 'skip' &&
      joined(get(exit, 'changed')) === 'shell.txt' &&
      get(exit, 'changed_count') === 1 &&
      get(exit, 'summary') ===
        'set phase exit (skip): 1 path(s) changed outside planning artifacts' &&
      get(exit, 'model') === 'm',
    JSON.stringify(recs),
  );
  s3('ph-1', 'amber:mark', 'skip - declined opening - operator says go');
  check(
    'a skip without an open phase records no phase-exit row',
    ledger(home).length === 5 && get(ledger(home), 4, 'trigger') === 'skip',
    JSON.stringify(ledger(home).slice(4)),
  );
  s3('ph-2', 'planning');
  s3('ph-1', 'amber:mark', 'skip - opening verdict - no contract: again');
  check(
    "one session's skip leaves another session's phase open",
    get(phaseOf('ph-2'), 'state') === 'planning' && ledger(home).length === 7,
  );
  s3(
    'ph-2',
    'amber:mark',
    'skip - opening verdict - no contract: x',
    zoneEmpty,
  );
  check(
    'a skip recorded in another zone leaves the phase of this zone open',
    get(phaseOf('ph-2'), 'state') === 'planning',
  );
  runHook(
    'S1',
    { session_id: 'ph-3', cwd: zone, prompt: '/amber:planning typed call' },
    home,
  );
  check(
    'typed /amber:planning opens the phase as the Skill record does',
    get(phaseOf('ph-3'), 'state') === 'planning' &&
      get(phaseOf('ph-3'), 'zone') === zoneReal,
    JSON.stringify(phaseOf('ph-3')),
  );
  fs.writeFileSync(
    path.join(home, 'state', 'session-ph-bad.json'),
    JSON.stringify({ model: 'm', phase: { state: 'planning', zone: 7 } }),
  );
  s3('ph-bad', 'amber:mark', 'skip - opening verdict - no contract: y');
  check(
    'a malformed phase field is read as no phase',
    get(ledger(home), ledger(home).length - 1, 'trigger') === 'skip' &&
      !/phase since/.test(stringOf(s0('ph-bad', 'resume'))),
  );

  // S2: a phase still open when the contract is released ends with the run.
  const released = makeZone('phase-release', BOUNDARY, {
    v: 1,
    boundary: 'test-boundary.md',
    ratified_by: 'operator',
    ratified_at: '2026-10-21',
  });
  runHook('S0', { session_id: 'ph-r', cwd: released, model: 'm' }, home);
  register(released, home, 'ph-r');
  s3('ph-r', 'set', undefined, released);
  check(
    'set record under a contract opens the phase in that zone',
    get(phaseOf('ph-r'), 'state') === 'set' &&
      get(phaseOf('ph-r'), 'zone') === fs.realpathSync(released),
    JSON.stringify(phaseOf('ph-r')),
  );
  fs.writeFileSync(
    path.join(released, '.amber', 'progress.json'),
    JSON.stringify({
      v: 1,
      contract: 'test-boundary.md',
      plan: 'plan.md',
      units: {},
    }),
  );
  const ok = done(released, home, OK_DONE, { AMBER_SESSION_ID: 'ph-r' });
  const before = ledger(home).length;
  const pass = runHook(
    'S2',
    {
      session_id: 'ph-r',
      cwd: released,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'completion report body',
    },
    home,
  ).out;
  const tail = ledger(home).slice(before);
  check(
    'a passed completion releases the contract and closes the phase with a release row',
    ok.status === 0 &&
      pass === null &&
      !fs.existsSync(path.join(released, '.amber', 'active.json')) &&
      !has(sessionState(home, 'ph-r'), 'phase') &&
      tail.length === 2 &&
      get(tail, 0, 'gate') === 'passed' &&
      get(tail, 1, 'trigger') === 'phase-exit' &&
      get(tail, 1, 'exit') === 'release' &&
      get(tail, 1, 'phase') === 'set' &&
      joined(get(tail, 1, 'changed')) === '' &&
      get(tail, 1, 'cwd') === fs.realpathSync(released),
    ok.stderr + JSON.stringify(tail),
  );

  // The audit reads a ledger with phase-exit rows as it reads any other.
  const transcripts = path.join(home, 'no-transcripts');
  fs.mkdirSync(transcripts, { recursive: true });
  const audit = spawnSync(
    'node',
    [path.join(PLUGIN, 'scripts', 'audit.cjs'), 'summary'],
    {
      env: { ...process.env, AMBER_HOME: home, AMBER_TRANSCRIPTS: transcripts },
      encoding: 'utf8',
      timeout: 20000,
    },
  );
  check(
    'audit summary counts phase-exit rows and reports as before',
    audit.status === 0 &&
      /by_trigger: .*phase-exit=2/.test(audit.stdout) &&
      /skips: /.test(audit.stdout),
    audit.stdout + audit.stderr,
  );
}

// ---- E1 phase gate: an open phase locks file-tool writes to planning artifacts until a skip or the pointer ----
{
  const home = freshHome('phase-e1');
  const zone = makeZone('phase-e1', null, null);
  for (const dir of ['src', 'docs/missions', 'contracts']) {
    fs.mkdirSync(path.join(zone, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(zone, '.gitignore'), '.amber/\n');
  const call = (
    id: string,
    tool: string,
    toolInput: unknown,
    extra: Readonly<Record<string, unknown>> = {},
    cwd = zone,
  ): unknown =>
    runHook(
      'E1',
      {
        session_id: id,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: toolInput,
        ...extra,
      },
      home,
    ).out;
  const write = (
    id: string,
    rel: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): unknown => call(id, 'Write', { file_path: path.join(zone, rel) }, extra);
  // The reason of a refusal, or the answer's text when there is none, so a
  // gate that lets a call through fails the check instead of the suite.
  const reasonOf = (out: unknown): string =>
    isDeny(out)
      ? stringAt(out, 'hookSpecificOutput', 'permissionDecisionReason')
      : JSON.stringify(out);
  const s3 = (id: string, skill: string, args?: string, cwd = zone): HookRun =>
    runHook(
      'S3',
      {
        session_id: id,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: { skill, ...(args === undefined ? {} : { args }) },
      },
      home,
    );
  const wrapped = (body: string): string =>
    '*** Begin Patch\n' + body + '\n*** End Patch';

  runHook('S0', { session_id: 'g1', cwd: zone, model: 'm' }, home);
  check(
    'E1 without a phase lets a source write through',
    write('g1', 'src/a.ts') === null,
  );
  s3('g1', 'amber:planning', 'gate');
  const denied = write('g1', 'src/a.ts');
  check(
    'E1 refuses a source write while the planning phase is open',
    isDeny(denied),
    JSON.stringify(denied),
  );
  check(
    'the refusal names the phase, its start, the target, the artifact patterns and both ways out',
    /^amber: planning phase open since \d{4}-\d{2}-\d{2}T\S+: write target src\/a\.ts is not a planning artifact \(\*\*\/\*-contract\.md, \*\*\/\*-plan\.md, \*\*\/\*-check\.sh, \*\*\/\*-review\*\.md, \*\*\/missions\/\*\.md\)\./.test(
      reasonOf(denied),
    ) &&
      /amber:mark skill \(`skip - opening verdict - no contract: <reason>`; on Codex and pi `node \S+record\.cjs mark skip 'opening verdict - no contract: <reason>'`\)/.test(
        reasonOf(denied),
      ) &&
      /or finish set and wait for the operator's approval - the pointer it creates releases this gate\.$/.test(
        reasonOf(denied),
      ),
    reasonOf(denied),
  );
  const artifacts: [string, string][] = [
    ['Write', 'docs/2026-10-21-x-contract.md'],
    ['Edit', 'docs/x-plan.md'],
    ['Write', 'contracts/x-check.sh'],
    ['Write', 'docs/x-review.md'],
    ['Write', 'docs/x-review-r2.md'],
    ['Write', 'docs/missions/x.md'],
    ['Write', 'x-contract.md'],
  ];
  check(
    'E1 lets planning artifacts through anywhere in the zone',
    artifacts.every(
      ([tool, rel]) =>
        call('g1', tool, { file_path: path.join(zone, rel) }) === null,
    ),
    JSON.stringify(
      artifacts.map(([tool, rel]) =>
        call('g1', tool, { file_path: path.join(zone, rel) }),
      ),
    ),
  );
  const others = [
    'src/x-contract.ts',
    'README.md',
    'contracts/x-check.py',
    'docs/notes.md',
    'missions.md',
    'docs/missions/sub/x.md',
  ];
  check(
    "E1 refuses writes to the zone's other paths whatever their name",
    others.every((rel) => isDeny(write('g1', rel))),
    JSON.stringify(others.map((rel) => write('g1', rel))),
  );
  const stateDeny = write('g1', '.amber/active.json');
  check(
    'E1 refuses a .amber/ write during the phase with the state reason',
    isDeny(stateDeny) &&
      /^amber: planning phase open since \S+: \.amber\/active\.json is the run's state under \.amber\/, written only by `node \S+record\.cjs` and the hooks\. To close the cycle: record the no-contract verdict with the amber:mark skill .* releases this gate\.$/.test(
        reasonOf(stateDeny),
      ),
    reasonOf(stateDeny),
  );
  check(
    'E1 refuses a draft contract kept under .amber/ (the state check precedes the artifact patterns)',
    isDeny(write('g1', '.amber/drafts/x-contract.md')) &&
      /run's state under \.amber\//.test(
        reasonOf(write('g1', '.amber/drafts/x-contract.md')),
      ),
  );
  check(
    'E1 lets a write outside the zone through',
    call('g1', 'Write', { file_path: path.join(BASE, 'phase-outside.txt') }) ===
      null &&
      call('g1', 'Write', { file_path: '../phase-outside-2.txt' }) === null,
  );
  check(
    'E1 lets Bash and Monitor through during the phase',
    call('g1', 'Bash', { command: 'echo hi > src/a.ts' }) === null &&
      call('g1', 'Monitor', { command: 'echo hi > src/a.ts' }) === null,
  );
  check(
    'E1 applies the phase to the session that opened it only',
    write('g2', 'src/a.ts') === null,
  );
  check(
    "a subagent follows its session's phase",
    isDeny(
      write('g1', 'src/a.ts', {
        agent_id: 'sub-1',
        agent_type: 'general-purpose',
      }),
    ),
  );
  check(
    'NotebookEdit is gated by its notebook path',
    isDeny(
      call('g1', 'NotebookEdit', {
        notebook_path: path.join(zone, 'nb.ipynb'),
      }),
    ) &&
      call('g1', 'NotebookEdit', {
        notebook_path: path.join(zone, 'docs', 'nb-plan.md'),
      }) === null,
  );
  const mixed = call('g1', 'apply_patch', {
    command: wrapped(
      '*** Add File: docs/y-contract.md\n+x\n*** Add File: src/b.ts\n+y',
    ),
  });
  check(
    'apply_patch with an artifact and a source file is refused for the source file',
    isDeny(mixed) && /write target src\/b\.ts/.test(reasonOf(mixed)),
    reasonOf(mixed),
  );
  check(
    'apply_patch touching artifacts only passes',
    call('g1', 'apply_patch', {
      command: wrapped('*** Add File: docs/y-contract.md\n+x'),
    }) === null,
  );
  const malformed = call('g1', 'apply_patch', { command: 'not a patch' });
  check(
    'a malformed apply_patch fails closed during the phase with its own reason',
    isDeny(malformed) &&
      /^amber: cannot inspect apply_patch while the planning phase is open: .*Correct the patch and retry\.$/.test(
        reasonOf(malformed),
      ),
    reasonOf(malformed),
  );
  s3('g3', 'planning', undefined, zoneEmpty);
  check(
    'a phase opened in another zone does not gate this one',
    write('g3', 'src/a.ts') === null,
  );
  s3('g1', 'set');
  const setDenied = write('g1', 'src/a.ts');
  check(
    'the set phase gates the same way and says so',
    isDeny(setDenied) &&
      /^amber: set phase open since/.test(reasonOf(setDenied)),
    reasonOf(setDenied),
  );
  s3('g1', 'amber:mark', 'skip - opening verdict - no contract: ok');
  check(
    'after the skip record the source write passes',
    write('g1', 'src/a.ts') === null,
  );

  // The pointer is the approval: the next tool call closes the phase.
  s3('g1', 'amber:planning', 'again');
  fs.writeFileSync(path.join(zone, 'shell-during.txt'), 'by a shell\n');
  fs.writeFileSync(path.join(zone, 'docs', 'phase-contract.md'), BOUNDARY);
  fs.mkdirSync(path.join(zone, '.amber'), { recursive: true });
  fs.writeFileSync(
    path.join(zone, '.amber', 'active.json'),
    JSON.stringify({
      v: 1,
      boundary: 'docs/phase-contract.md',
      ratified_by: 'operator',
      ratified_at: '2026-10-21',
    }),
  );
  const before = ledger(home).length;
  const underContract = write('g1', 'plugin/x.cjs');
  const rows = ledger(home).slice(before);
  check(
    'the first tool call that finds the pointer closes the phase as an approval and records what changed meanwhile',
    underContract === null &&
      !has(sessionState(home, 'g1'), 'phase') &&
      rows.length === 1 &&
      get(rows, 0, 'trigger') === 'phase-exit' &&
      get(rows, 0, 'exit') === 'approval' &&
      get(rows, 0, 'phase') === 'planning' &&
      joined(get(rows, 0, 'changed')) === 'shell-during.txt',
    JSON.stringify([underContract, rows]),
  );
  const srcUnder = write('g1', 'src/a.ts');
  check(
    'under the contract the write-scope rules speak, not the phase',
    isDeny(srcUnder) &&
      /outside every write-scope/.test(reasonOf(srcUnder)) &&
      !/phase open since/.test(reasonOf(srcUnder)),
    reasonOf(srcUnder),
  );
  check(
    'later calls under the contract record no further exit row',
    ledger(home).length === before + 1,
  );
  s3('g1', 'set', undefined, zone);
  const bashUnder = call('g1', 'Bash', { command: 'git status' });
  check(
    'a phase opened under the contract is closed by the next call of any tool',
    bashUnder === null &&
      !has(sessionState(home, 'g1'), 'phase') &&
      get(ledger(home), ledger(home).length - 1, 'exit') === 'approval',
  );
}

// ---- phase-exit row limits: the row survives many and long changed paths ----
{
  const home = freshHome('phase-cap');
  const s3 = (
    id: string,
    zone: string,
    skill: string,
    args?: string,
  ): HookRun =>
    runHook(
      'S3',
      {
        session_id: id,
        cwd: zone,
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: { skill, ...(args === undefined ? {} : { args }) },
      },
      home,
    );
  const rawRows = (): string[] =>
    fs
      .readFileSync(path.join(home, 'runs.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
  const many = makeZone('phase-many', null, null);
  runHook('S0', { session_id: 'cap-1', cwd: many, model: 'm' }, home);
  s3('cap-1', many, 'amber:planning');
  for (let i = 1; i <= 51; i += 1) {
    fs.writeFileSync(path.join(many, 'c' + String(i).padStart(2, '0')), 'x');
  }
  s3('cap-1', many, 'amber:mark', 'skip - opening verdict - no contract: many');
  let rows = ledger(home);
  let exit = rows[rows.length - 1];
  check(
    'an exit row lists at most 50 changed paths, sorted, and counts them all',
    get(exit, 'trigger') === 'phase-exit' &&
      list(get(exit, 'changed')).length === 50 &&
      get(exit, 'changed', 0) === 'c01' &&
      get(exit, 'changed', 49) === 'c50' &&
      get(exit, 'changed_count') === 51 &&
      /51 path\(s\) changed/.test(stringAt(exit, 'summary')),
    JSON.stringify(exit),
  );
  const long = makeZone('phase-long', null, null);
  runHook('S0', { session_id: 'cap-2', cwd: long, model: 'm' }, home);
  s3('cap-2', long, 'amber:planning');
  for (let i = 1; i <= 50; i += 1) {
    fs.writeFileSync(
      path.join(long, 'd' + String(i).padStart(2, '0') + '-' + 'x'.repeat(86)),
      'x',
    );
  }
  const before = rawRows().length;
  s3('cap-2', long, 'amber:mark', 'skip - opening verdict - no contract: long');
  rows = ledger(home);
  exit = rows[rows.length - 1];
  const line = rawRows()[rawRows().length - 1] ?? '';
  check(
    'an exit row with fifty 90-byte paths still fits the ledger line and keeps the count',
    rawRows().length === before + 2 &&
      get(exit, 'trigger') === 'phase-exit' &&
      Buffer.byteLength(line) <= 4096 &&
      list(get(exit, 'changed')).length > 0 &&
      list(get(exit, 'changed')).length < 50 &&
      get(exit, 'changed_count') === 50 &&
      !has(sessionState(home, 'cap-2'), 'phase'),
    JSON.stringify([rawRows().length - before, Buffer.byteLength(line), exit]),
  );
}

// ---- phase gate and worktrees: a sibling worktree is outside, a unit worktree inside ----
{
  const home = freshHome('phase-wt');
  const zone = makeZone('phase-wt', null, null);
  execFileSync('git', [
    '-C',
    zone,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  ]);
  const sibling = path.join(BASE, 'phase-wt-sibling');
  execFileSync('git', [
    '-C',
    zone,
    'worktree',
    'add',
    '-q',
    '--detach',
    sibling,
  ]);
  const unit = path.join(zone, '.claude', 'worktrees', 'u1');
  execFileSync('git', ['-C', zone, 'worktree', 'add', '-q', '--detach', unit]);
  runHook('S0', { session_id: 'wt-1', cwd: zone, model: 'm' }, home);
  runHook(
    'S3',
    {
      session_id: 'wt-1',
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_input: { skill: 'amber:planning' },
    },
    home,
  );
  const write = (target: string): unknown =>
    runHook(
      'E1',
      {
        session_id: 'wt-1',
        cwd: zone,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: target },
      },
      home,
    ).out;
  check(
    'a write into a sibling worktree (a zone of its own) passes the phase gate',
    write(path.join(sibling, 'src', 'a.ts')) === null &&
      write(path.join(sibling, 'README.md')) === null,
  );
  const inUnit = write(path.join(unit, 'src', 'a.ts'));
  check(
    'a write into a unit worktree inside the zone is judged by its zone-relative path',
    isDeny(inUnit) &&
      /write target src\/a\.ts is not a planning artifact/.test(
        stringAt(inUnit, 'hookSpecificOutput', 'permissionDecisionReason'),
      ) &&
      write(path.join(unit, 'docs', 'u-plan.md')) === null,
    JSON.stringify(inUnit),
  );
  check(
    'the zone itself stays gated',
    isDeny(write(path.join(zone, 'src', 'a.ts'))),
  );
}

// ---- nested repositories follow the enclosing zone ----
// Zone Z (a contract) holds an independent repository dist/ and a linked
// worktree of it, dist-wt/; zone W, a linked worktree of Z outside it with
// its own pointer, holds dist/ as another linked worktree of Z's dist; zone
// F has no pointer and holds its own dist/.
const NESTED_BOUNDARY = [
  '# boundary - nested repositories',
  '- dist sources [machine: write-scope dist/src/**]',
  '- dist worktree sources [machine: write-scope dist-wt/src/**]',
  '- docs [machine: write-scope docs/*.md]',
  '- no push [machine: bash-deny git\\s+push\\b]',
].join('\n');
const NESTED_POINTER = {
  v: 1,
  boundary: 'test-boundary.md',
  ratified_by: 'operator',
  ratified_at: '2026-11-03',
};
interface NestedSet {
  readonly z: string;
  readonly zDist: string;
  readonly zDistWt: string;
  readonly w: string;
  readonly wDist: string;
  readonly f: string;
  readonly fDist: string;
  readonly home: string;
  readonly rec: (
    cwd: string,
    args: readonly string[],
  ) => SpawnSyncReturns<string>;
}
function gitIn(dir: string, args: readonly string[]): void {
  execFileSync('git', ['-C', dir, ...args]);
}
function commitAll(dir: string): void {
  gitIn(dir, ['config', 'user.email', 't@t']);
  gitIn(dir, ['config', 'user.name', 't']);
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
}
function nestedSet(tag: string): NestedSet {
  const z = fs.realpathSync(makeZone(tag + '-z', NESTED_BOUNDARY, null));
  fs.mkdirSync(path.join(z, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(z, 'docs', 'plan.md'), LINK_PLAN);
  fs.writeFileSync(path.join(z, '.gitignore'), '.amber/\ndist/\ndist-wt/\n');
  commitAll(z);
  const zDist = path.join(z, 'dist');
  fs.mkdirSync(zDist);
  gitIn(zDist, ['init', '-q']);
  commitAll(zDist);
  const zDistWt = path.join(z, 'dist-wt');
  gitIn(zDist, ['worktree', 'add', '-q', '-b', tag + '-dwt', zDistWt]);
  const w = path.join(fs.realpathSync(BASE), tag + '-w');
  gitIn(z, ['worktree', 'add', '-q', '-b', tag + '-w', w]);
  const wDist = path.join(w, 'dist');
  gitIn(zDist, ['worktree', 'add', '-q', '-b', tag + '-wd', wDist]);
  for (const zone of [z, w]) {
    fs.mkdirSync(path.join(zone, '.amber'), { recursive: true });
    fs.writeFileSync(
      path.join(zone, '.amber', 'active.json'),
      JSON.stringify(NESTED_POINTER),
    );
  }
  const f = fs.realpathSync(makeZone(tag + '-f', NESTED_BOUNDARY, null));
  const fDist = path.join(f, 'dist');
  fs.mkdirSync(fDist);
  gitIn(fDist, ['init', '-q']);
  const home = freshHome(tag);
  const rec = (
    cwd: string,
    args: readonly string[],
  ): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD_CLI, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AMBER_HOME: home,
        AMBER_SESSION_ID: 'nested-s',
      },
    });
  return { z, zDist, zDistWt, w, wDist, f, fDist, home, rec };
}
const reasonOf = (out: unknown): string =>
  stringAt(out, 'hookSpecificOutput', 'permissionDecisionReason');
{
  const zoneLib = loadModule<typeof import('../src/lib/zone.cjs')>(
    'lib/zone.cjs',
    ['zoneRoot', 'nestedTree', 'linkedWorktreeMain'],
  );
  const n = nestedSet('nest');
  fs.mkdirSync(path.join(n.zDist, 'sub'));
  check(
    'a nested repository and its linked worktrees resolve to the enclosing zone with a pointer',
    zoneLib.zoneRoot(n.zDist) === n.z &&
      zoneLib.zoneRoot(path.join(n.zDist, 'sub')) === n.z &&
      zoneLib.zoneRoot(n.zDistWt) === n.z &&
      zoneLib.zoneRoot(n.wDist) === n.w,
    [n.zDist, n.zDistWt, n.wDist].map((d) => zoneLib.zoneRoot(d)),
  );
  check(
    'a nested repository under a zone without a pointer stays a zone of its own',
    zoneLib.zoneRoot(n.fDist) === n.fDist && zoneLib.zoneRoot(n.f) === n.f,
    [zoneLib.zoneRoot(n.fDist), zoneLib.zoneRoot(n.f)],
  );
  check(
    'nestedTree names the nested toplevel and nothing else',
    zoneLib.nestedTree(n.zDistWt, n.z) === n.zDistWt &&
      zoneLib.nestedTree(n.wDist, n.w) === n.wDist &&
      zoneLib.nestedTree(n.z, n.z) === null &&
      zoneLib.nestedTree(path.join(n.z, 'docs'), n.z) === null &&
      zoneLib.nestedTree(n.w, n.w) === null,
  );
  check(
    'a linked worktree an enclosing zone binds is not briefed as a zone of its own',
    zoneLib.linkedWorktreeMain(n.wDist) === null &&
      zoneLib.linkedWorktreeMain(n.zDistWt) === null &&
      zoneLib.linkedWorktreeMain(n.w) === n.z,
  );

  const outside = e1(
    n.zDist,
    'Write',
    { file_path: path.join(n.zDist, 'other.txt') },
    n.home,
  );
  check(
    'from inside dist/ a write outside the scope is refused by its zone-root path',
    isDeny(outside) &&
      /write target dist\/other\.txt is outside every write-scope/.test(
        reasonOf(outside),
      ),
    JSON.stringify(outside),
  );
  check(
    'from inside dist/ a write inside the scope passes',
    e1(
      n.zDist,
      'Write',
      { file_path: path.join(n.zDist, 'src', 'a.ts') },
      n.home,
    ) === null,
  );
  const wtOut = e1(
    n.zDistWt,
    'Write',
    { file_path: path.join(n.zDistWt, 'other.txt') },
    n.home,
  );
  check(
    'from inside a linked worktree of dist/ the zone judges dist-wt/ paths',
    isDeny(wtOut) &&
      /write target dist-wt\/other\.txt is outside/.test(reasonOf(wtOut)) &&
      e1(
        n.zDistWt,
        'Write',
        { file_path: path.join(n.zDistWt, 'src', 'a.ts') },
        n.home,
      ) === null,
    JSON.stringify(wtOut),
  );
  const wOut = e1(
    n.wDist,
    'Write',
    { file_path: path.join(n.wDist, 'other.txt') },
    n.home,
  );
  check(
    'from inside the sibling zone dist/ the sibling zone contract judges',
    isDeny(wOut) &&
      /write target dist\/other\.txt is outside/.test(reasonOf(wOut)) &&
      e1(
        n.wDist,
        'Write',
        { file_path: path.join(n.wDist, 'src', 'a.ts') },
        n.home,
      ) === null,
    JSON.stringify(wOut),
  );
  check(
    'the enclosing zone bash-deny applies from inside dist/ and its worktrees',
    isDeny(e1(n.zDist, 'Bash', { command: 'git push origin x' }, n.home)) &&
      isDeny(e1(n.zDistWt, 'Bash', { command: 'git push' }, n.home)) &&
      isDeny(e1(n.wDist, 'Bash', { command: 'git push' }, n.home)) &&
      e1(n.zDist, 'Bash', { command: 'git status' }, n.home) === null,
  );
  check(
    'a nested repository under a zone without a pointer is not governed',
    e1(
      n.fDist,
      'Write',
      { file_path: path.join(n.fDist, 'other.txt') },
      n.home,
    ) === null && e1(n.fDist, 'Bash', { command: 'git push' }, n.home) === null,
  );

  const before = amberFiles(n.z);
  const initNested = n.rec(n.zDist, ['unit', 'init', 'docs/plan.md']);
  const doneNested = n.rec(n.zDistWt, [
    'done',
    '--review',
    'r',
    '--goal',
    'g',
    '--summary',
    's',
  ]);
  const activateNested = n.rec(n.wDist, [
    'activate',
    'test-boundary.md',
    '--by',
    'operator',
  ]);
  check(
    'the recorder refuses unit, done and activate from inside a nested repository and names the zone root',
    initNested.status === 1 &&
      doneNested.status === 1 &&
      activateNested.status === 1 &&
      initNested.stderr.includes('refused') &&
      initNested.stderr.includes(JSON.stringify(n.z)) &&
      activateNested.stderr.includes(JSON.stringify(n.w)) &&
      amberFiles(n.z) === before &&
      !signalExists(n.z),
    [initNested.stderr, doneNested.stderr, activateNested.stderr],
  );
  check(
    'the same unit command from the zone root still runs',
    n.rec(n.z, ['unit', 'init', 'docs/plan.md']).status === 0,
  );
}
{
  const n = nestedSet('nest-stop');
  const signal = done(n.z, n.home, [
    '--review',
    'r',
    '--goal',
    'g',
    '--summary',
    's',
  ]);
  const stop = runHook('S2', stopEvent(n.zDist, 'Done: nested stop.'), n.home);
  check(
    'a stop from inside dist/ consumes the enclosing zone signal and releases its contract',
    signal.status === 0 &&
      stop.exit === 0 &&
      !signalExists(n.z) &&
      !fs.existsSync(path.join(n.z, '.amber', 'active.json')) &&
      fs.existsSync(path.join(n.w, '.amber', 'active.json')),
    [signal.stderr, JSON.stringify(stop.out)],
  );
}
{
  const n = nestedSet('nest-unit');
  const unit = path.join(n.z, '.claude', 'worktrees', 'u1');
  gitIn(n.z, ['worktree', 'add', '-q', '-b', 'nest-unit-u1', unit]);
  const out = e1(
    unit,
    'Write',
    { file_path: path.join(unit, 'other.txt') },
    n.home,
  );
  check(
    'a unit worktree inside the zone keeps mapping to the zone-relative path',
    isDeny(out) &&
      /write target other\.txt is outside/.test(reasonOf(out)) &&
      e1(
        unit,
        'Write',
        { file_path: path.join(unit, 'docs', 'x.md') },
        n.home,
      ) === null,
    JSON.stringify(out),
  );
}
