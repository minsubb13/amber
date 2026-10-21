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
// The completion signal: `record.cjs done` run in the zone, as the model does.
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
    env: { ...process.env, AMBER_HOME: home, ...extraEnv },
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
// Session binding: E1 registers the session that runs a unit
// command itself. Tests drive record.cjs directly, so they register through
// the same observation the live session gets.
function register(
  zone: string,
  home: string,
  sessionId: string,
  command?: string,
): unknown {
  return runHook(
    'E1',
    {
      session_id: sessionId,
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: command || 'node ' + RECORD_CLI + ' unit start U1',
      },
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

// ---- S0 regression ----
{
  const home = freshHome('s0');
  const out = runHook(
    'S0',
    { session_id: 'abc', cwd: zoneEmpty, model: 'claude-fable-5' },
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
    'S0 contract-less briefing names the done command without --goal',
    !!armCtx &&
      / done --review /.test(stringOf(armCtx)) &&
      !/--goal/.test(stringOf(armCtx)) &&
      /semantic review/.test(stringOf(armCtx)),
  );
  check(
    'S0 contract-less briefing forbids the signal for incomplete reports',
    !!armCtx &&
      /Never run the command for incomplete/.test(stringOf(armCtx)) &&
      /governed work unit itself complete/.test(stringOf(armCtx)) &&
      !/AMBER_/.test(stringOf(armCtx)),
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
    joined(get(progress(), 'session_ids')) === 's2-test',
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
  const quiet = runHook(
    'S2',
    stopEvent(zoneContract, 'plain turn without progress', false),
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
  const record = (args: readonly string[]): SpawnSyncReturns<string> =>
    spawnSync('node', [RECORD_CLI, ...args], {
      cwd: zone,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, AMBER_HOME: home, AMBER_SESSION_ID: 'bind-shell' },
    });
  record(['unit', 'init', 'docs/plan.md']);
  record(['unit', 'start', 'U1']);
  check(
    'progress.json starts with an empty session list',
    get(progress(), 'session_ids', 'length') === 0,
  );
  for (const id of ['drv', 'talk']) {
    runHook('S0', { session_id: id, cwd: zone, model: 'm' }, home);
  }

  const reg = register(zone, home, 'drv');
  check(
    'E1 registers the session that runs a unit command itself',
    reg === null &&
      get(sessionState(home, 'drv'), 'run') === 'test-boundary.md' &&
      joined(get(progress(), 'session_ids')) === 'drv',
    JSON.stringify(sessionState(home, 'drv')) +
      ' ' +
      JSON.stringify(get(progress(), 'session_ids')),
  );
  register(
    zone,
    home,
    'drv2',
    'node ' + RECORD_CLI + ' done --review "r" --goal "g" --summary "s"',
  );
  check(
    'E1 registers on the done command too',
    get(sessionState(home, 'drv2'), 'run') === 'test-boundary.md' &&
      list(get(progress(), 'session_ids')).includes('drv2'),
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
    !get(sessionState(home, 'sub'), 'run') &&
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
  check(
    'an ordinary command does not register',
    !get(sessionState(home, 'talk'), 'run'),
  );
  // The regexes anchor to the command position: the same words inside prose
  // (a commit message, a grep argument, a document heredoc, a node -e probe)
  // register nothing, while the command behind a loop keyword, an env
  // prefix, a quoted path or a shell variable still does.
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
    register(zone, home, id, command);
    check(label, !get(sessionState(home, id), 'run'));
  });
  const commands: [string, string][] = [
    [
      'a for loop running the unit command registers',
      'for u in U1 U2; do node ' + RECORD_CLI + ' unit start $u; done',
    ],
    [
      'an env prefix before node registers',
      'env GIT_OPTIONAL_LOCKS=0 node ' + RECORD_CLI + ' unit start U1',
    ],
    [
      'a quoted record.cjs path registers',
      'node "' + RECORD_CLI + '" unit start U1',
    ],
    [
      'a plugin-root variable path registers',
      'AMBER_HOME=/tmp/h node "$amber_plugin_root/scripts/record.cjs" unit start U1',
    ],
  ];
  commands.forEach(([label, command], i) => {
    const id = 'cmd' + String(i);
    register(zone, home, id, command);
    check(label, get(sessionState(home, id), 'run') === 'test-boundary.md');
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
    get(sessionState(home, 'drv4'), 'run') === 'test-boundary.md' &&
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
      /1 session\(s\) drive/.test(stringOf(octx)) &&
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

// ---- shell attribution: unit rows carry the session E1 registered, not "shell"/"unknown" ----
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
  // No environment session id: the registration-lookup path. The runner may
  // itself run inside a Claude Code or pi session, whose CLAUDE_CODE_SESSION_ID
  // or PI_SESSION_ID would otherwise be inherited and win - blank them explicitly.
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
  const lastRow = (h?: string): unknown => ledger(h || home).slice(-1)[0] || {};
  runHook('S0', { session_id: 'sa', cwd: zone, model: 'model-a' }, home);
  runHook('S0', { session_id: 'sb', cwd: zone, model: 'model-b' }, home);
  register(zone, home, 'sa', 'node ' + RECORD_CLI + ' unit init docs/plan.md');
  const init = bare(['unit', 'init', 'docs/plan.md']);
  check(
    'a shell unit init is attributed to the session E1 registered (no progress.json yet)',
    init.status === 0 &&
      get(lastRow(), 'trigger') === 'unit-init' &&
      get(lastRow(), 'session_id') === 'sa' &&
      get(lastRow(), 'model') === 'model-a',
    (init.stderr || '') + JSON.stringify(lastRow()),
  );
  register(zone, home, 'sb');
  const start = bare(['unit', 'start', 'U1']);
  check(
    'the most recently registered driver takes the row and the progress history',
    start.status === 0 &&
      get(lastRow(), 'session_id') === 'sb' &&
      get(lastRow(), 'model') === 'model-b' &&
      get(
        list(get(progress(), 'units', 'U1', 'history')).slice(-1)[0],
        'by',
      ) === 'sb',
    (start.stderr || '') + JSON.stringify(lastRow()),
  );
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(home, 'state', 'session-sb.json'), old, old);
  register(zone, home, 'sa');
  const hold = bare(['unit', 'hold', 'U1', '--reason', 'waiting']);
  check(
    'an idempotent re-registration touches the state file, so the issuing session wins',
    hold.status === 0 &&
      get(lastRow(), 'trigger') === 'unit-hold' &&
      get(lastRow(), 'session_id') === 'sa' &&
      get(lastRow(), 'model') === 'model-a',
    (hold.stderr || '') + JSON.stringify(lastRow()),
  );
  const env = bare(['unit', 'start', 'U2'], { AMBER_SESSION_ID: 'env-id' });
  check(
    'an explicit environment session id still wins',
    env.status === 0 && get(lastRow(), 'session_id') === 'env-id',
    (env.stderr || '') + JSON.stringify(lastRow()),
  );
  const none = freshHome('attr-none');
  const bareNone = bare(['unit', 'failed', 'U2', '--evidence', 'x'], {
    AMBER_HOME: none,
  });
  check(
    'without any registration the row still says shell/unknown (negative control)',
    bareNone.status === 0 &&
      get(lastRow(none), 'session_id') === 'shell' &&
      get(lastRow(none), 'model') === 'unknown',
    (bareNone.stderr || '') + JSON.stringify(lastRow(none)),
  );
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
  const sideNoContract = done(side, home, [
    '--review',
    'r',
    '--summary',
    'sibling no-contract done',
  ]);
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
  const sideDone = done(side, home, [
    '--review',
    'r',
    '--goal',
    'g',
    '--summary',
    'side done',
  ]);
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
  done(zone, home, OK_DONE);
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
