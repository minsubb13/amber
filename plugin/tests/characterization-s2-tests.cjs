#!/usr/bin/env node
// Characterization tests for the modules ported in stage 2 (patch-paths,
// progress, scope-check, audit-codex): branches the other suites do not take,
// pinned to what the code returns or throws today. They call the exported
// functions directly, so a ported module that returns or throws anything else
// fails this suite, which the parity run counts as a difference. They assert
// current behavior, not a specification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');

const { patchPaths } = require('../hooks/patch-paths.cjs');
const progress = require('../hooks/progress.cjs');
const scopeCheck = require('../hooks/scope-check.cjs');
const { codexEvents, commandEvents } = require('../scripts/audit-codex.cjs');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-characterization-s2-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function dir() {
  return fs.mkdtempSync(path.join(BASE, 'case-'));
}

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function repo(files) {
  const root = dir();
  git(root, ['init', '-q']);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture']);
  return root;
}

function patch(lines) {
  return ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
}

// ---- patch-paths ----

test('apply_patch refuses a file path containing NUL', () => {
  assert.throws(() => patchPaths(patch(['*** Add File: a\0b', '+x'])),
    { message: 'file paths must be nonempty and contain no NUL' });
});

test('apply_patch refuses an @@ marker that closes an empty hunk', () => {
  assert.throws(() => patchPaths(patch(['*** Update File: a', '@@', '@@', ' x'])),
    { message: 'empty update hunk at line 4' });
});

test('apply_patch refuses a hunk line after End of File without a new @@', () => {
  assert.throws(() => patchPaths(patch(['*** Update File: a', '@@', ' x', '*** End of File', ' y'])),
    { message: 'expected an @@ context marker at line 6' });
});

// ---- progress: globs and plan rows ----

test('a **/ glob segment matches zero or more directories', () => {
  const re = progress.globToRegExp('docs/**/x.md');
  assert.equal(re.source, '^docs\\/(?:.*\\/)?x\\.md$');
  assert.equal(re.test('docs/x.md'), true);
  assert.equal(re.test('docs/a/b/x.md'), true);
  assert.equal(re.test('docs/ax.md'), false);
});

test('a unit row without oracle= and with a bare token parses', () => {
  const units = progress.parsePlanUnits('- [ ] U1 first [unit: U1 scope=a/**,b bare after=]\n');
  assert.deepEqual(units, [{ id: 'U1', title: 'first', scope: ['a/**', 'b'], after: [], oracle: '' }]);
});

test('plan rows refuse an id mismatch, a missing scope and an unknown dependency', () => {
  assert.throws(() => progress.parsePlanUnits('- [ ] U1 t [unit: U2 scope=a]'),
    { message: 'unit row id mismatch: - [ ] U1 t [unit: U2 scope=a]' });
  assert.throws(() => progress.parsePlanUnits('- [ ] U1 t [unit: U1 after=U2]'),
    { message: 'unit U1 has no scope=' });
  assert.throws(() => progress.parsePlanUnits('- [ ] U1 t [unit: U1 scope=a after=U9]'),
    { message: 'unit U1 depends on unknown U9' });
});

test('unit init refuses a plan without unit rows', () => {
  const root = dir();
  fs.writeFileSync(path.join(root, 'plan.md'), '# plan\n');
  assert.throws(() => progress.initProgress(root, 'plan.md', 'c.md', false, []),
    { message: 'no [unit: ...] rows found in plan.md' });
});

test('unit init without a contract file or a preexisting array stores null and []', () => {
  const root = dir();
  fs.writeFileSync(path.join(root, 'plan.md'), '- [ ] U1 t [unit: U1 scope=a]\n');
  const p = progress.initProgress(root, 'plan.md', '', false, 'not-an-array');
  assert.equal(p.contract, null);
  assert.deepEqual(p.preexisting, []);
  assert.deepEqual(Object.keys(p), ['v', 'contract', 'plan', 'created_at', 'current', 'hold', 'blocks',
    'session_ids', 'preexisting', 'units', 'updated_at']);
  const saved = fs.readFileSync(progress.progressPath(root), 'utf8');
  assert.equal(saved, JSON.stringify(p, null, 1) + '\n');
});

test('loadProgress checks only that units is an object', () => {
  const root = dir();
  const file = progress.progressPath(root);
  assert.equal(progress.loadProgress(root), null);
  fs.mkdirSync(path.dirname(file));
  const cases = ['{not json', 'null', '{"units": 5}', '{"units": null}', '{"units": [], "extra": 1}'];
  const results = cases.map((text) => {
    fs.writeFileSync(file, text);
    return progress.loadProgress(root);
  });
  let parseError;
  try { JSON.parse('{not json'); } catch (err) { parseError = err.message; }
  assert.deepEqual(results, [
    { broken: true, error: parseError, file },
    { broken: true, error: 'no units object', file },
    { broken: true, error: 'no units object', file },
    { units: null },
    { units: [], extra: 1 },
  ]);
});

// ---- progress: transitions ----

function fresh() {
  return {
    v: 1, contract: 'c.md', plan: 'plan.md', created_at: 'x', current: null, hold: null, blocks: 0,
    session_ids: [], preexisting: [],
    units: {
      U1: { title: 'one', scope: ['a'], after: [], oracle: 'true', status: 'pending', agent_id: null,
        reentries: 0, history: [] },
      U2: { title: 'two', scope: ['b'], after: ['U1'], oracle: '', status: 'pending', agent_id: null,
        reentries: 0, history: [] },
    },
  };
}

function strip(history) {
  return history.map(({ ts, ...rest }) => {
    assert.match(ts, ISO);
    return rest;
  });
}

test('a hold without a unit or a reason records null and an empty reason', () => {
  const p = progress.applyEvent(fresh(), 'hold', null, {});
  assert.deepEqual(Object.keys(p.hold), ['unit', 'reason', 'by', 'ts']);
  assert.equal(p.hold.unit, null);
  assert.equal(p.hold.reason, '');
  assert.equal(p.hold.by, 'shell');
  assert.match(p.hold.ts, ISO);
  assert.deepEqual(p.units.U1.history, []);
});

test('start after the re-entry limit resets the count', () => {
  const p = fresh();
  p.units.U1.status = 'limit';
  p.units.U1.reentries = 10;
  progress.applyEvent(p, 'start', 'U1', { by: 'm' });
  assert.equal(p.units.U1.reentries, 0);
  assert.equal(p.units.U1.status, 'running');
  assert.equal(p.current, 'U1');
});

test('claim refuses a missing agent id and a unit that is not open', () => {
  assert.throws(() => progress.applyEvent(fresh(), 'claim', 'U1', {}),
    { message: 'claim requires an agent id' });
  const p = fresh();
  p.units.U1.status = 'verified';
  assert.throws(() => progress.applyEvent(p, 'claim', 'U1', { agent_id: 'a1' }),
    { message: 'unit U1 is verified, not open' });
});

test('verified and failed without evidence record an empty note', () => {
  const p = fresh();
  progress.applyEvent(p, 'failed', 'U1', {});
  progress.applyEvent(p, 'verified', 'U1', {});
  assert.deepEqual(strip(p.units.U1.history), [
    { event: 'failed', by: 'shell', note: '' },
    { event: 'verified', by: 'shell', note: '' },
  ]);
});

test('an unknown unit or event is refused', () => {
  assert.throws(() => progress.applyEvent(fresh(), 'start', 'U9', {}),
    { message: 'unknown unit U9 (known: U1, U2)' });
  assert.throws(() => progress.applyEvent(fresh(), 'bogus', 'U1', {}),
    { message: 'unknown unit event bogus' });
});

test('unit history keeps the last 50 entries', () => {
  const p = fresh();
  for (let i = 0; i < 53; i += 1) progress.applyEvent(p, 'hold', 'U1', { reason: 'r' + i });
  assert.equal(p.units.U1.history.length, 50);
  assert.equal(p.units.U1.history[0].note, 'r3');
  assert.equal(p.units.U1.history[49].note, 'r52');
});

test('a unit without an after field counts as having its dependencies met', () => {
  const p = fresh();
  delete p.units.U2.after;
  p.units.U1.status = 'verified';
  assert.deepEqual(progress.readyUnits(p), ['U2']);
  assert.equal(progress.focusUnit(p), 'U2');
});

test('the summary falls back for a missing plan, oracle, hold unit and session list', () => {
  const p = fresh();
  p.plan = '';
  p.units.U1.status = 'verified';
  p.hold = { unit: null, reason: 'waiting', by: 'shell', ts: '2026-01-01T00:00:00.000Z' };
  p.session_ids = 'not-an-array';
  assert.equal(progress.summary(p), [
    'amber progress (progress.json): 1 of 2 unit(s) open - verified: U1; running: none; failed: none; limit: none.',
    'next: U2 two [scope: b; re-entries: 0/10]',
    'hold: - - waiting',
    'driving sessions: none registered yet',
  ].join('\n'));
});

// ---- scope-check ----

test('a rename reports only the new path', () => {
  const root = repo({ 'a.txt': 'a\n' });
  git(root, ['mv', 'a.txt', 'b.txt']);
  assert.deepEqual(scopeCheck.snapshot(root), ['b.txt']);
});

test('without a contract path or declarations every outside change is undeclared', () => {
  const root = repo({ 'a.txt': 'a\n' });
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'n\n');
  const result = scopeCheck.check({ cwd: root, writeScopes: ['docs/**'] });
  assert.deepEqual(result, {
    baseline: null,
    changed: [{ path: 'a.txt', kind: 'working-tree' }, { path: 'new.txt', kind: 'working-tree' }],
    outside: [{ path: 'a.txt', kind: 'working-tree' }, { path: 'new.txt', kind: 'working-tree' }],
    declared: [],
    undeclared: [{ path: 'a.txt', kind: 'working-tree' }, { path: 'new.txt', kind: 'working-tree' }],
  });
});

test('git missing from PATH refuses with the spawn error', () => {
  const root = dir();
  const saved = process.env.PATH;
  process.env.PATH = path.join(root, 'no-bin');
  try {
    assert.throws(() => scopeCheck.check({ cwd: root, writeScopes: [] }), {
      message: root + ' is not inside a git repository, so changed files cannot be compared ' +
        'with the write-scope (Amber runs live in git): spawnSync git ENOENT',
    });
  } finally {
    process.env.PATH = saved;
  }
});

test('--out-of-scope without = takes the whole value as the path', () => {
  assert.deepEqual(scopeCheck.parseDeclarations(['--out-of-scope', 'docs/a.md', 'x']),
    [{ path: 'docs/a.md x', reason: '' }]);
  assert.throws(() => scopeCheck.parseDeclarations(['--out-of-scope', '=why']),
    { message: '--out-of-scope needs <path>=<reason>' });
  assert.throws(() => scopeCheck.parseDeclarations(['--out-of-scope', '--evidence', 'e']),
    { message: '--out-of-scope needs <path>=<reason>' });
});

// ---- audit-codex: commandEvents ----

const META = { ln: 7, ts: 't' };

test('mark hold, unit claim, start and hold map to their ledger expectations', () => {
  assert.deepEqual(commandEvents('node record.cjs mark hold - U1 - r', 'amber: recorded mark hold\n', META),
    [{ ln: 7, ts: 't', kind: 'mark hold', expect: 'unit-hold', result: 'accepted' }]);
  assert.deepEqual(commandEvents('node record.cjs unit claim U1', 'amber: unit U1 claimed by subagent a1\n', META),
    [{ ln: 7, ts: 't', kind: 'cmd unit claim', expect: null, result: 'accepted' }]);
  assert.deepEqual(commandEvents('node record.cjs unit start U1', 'amber: unit U1 -> running\n', META),
    [{ ln: 7, ts: 't', kind: 'cmd unit start', expect: 'unit-start', result: 'accepted' }]);
  assert.deepEqual(commandEvents('node record.cjs unit hold U1 --reason r', 'amber: unit U1 -> hold\n', META),
    [{ ln: 7, ts: 't', kind: 'cmd unit hold', expect: 'unit-hold', result: 'accepted' }]);
});

test('one output with both a refusal and a success of a repeated command is unobserved', () => {
  const command = 'node record.cjs unit start U1; node record.cjs unit start U1';
  const output = 'amber: unit U1 -> running\namber: unknown unit U1 refused\n';
  assert.deepEqual(commandEvents(command, output, META), [
    { ln: 7, ts: 't', kind: 'cmd unit start', expect: 'unit-start', result: 'unobserved' },
    { ln: 7, ts: 't', kind: 'cmd unit start', expect: 'unit-start', result: 'unobserved' },
  ]);
});

// ---- audit-codex: codexEvents ----

function transcript(rows) {
  const file = path.join(dir(), 'rollout.jsonl');
  fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return file;
}

test('a transcript with no recognized row is refused', () => {
  const file = transcript([{ type: 'event_msg' }, { type: 'other', payload: {} }]);
  assert.throws(() => codexEvents(file), { message: 'unsupported Codex transcript shape: ' + file });
});

test('rows without payloads, ids, timestamps or cwd fall back', () => {
  const file = transcript([
    { type: 'session_meta', payload: {} },
    { type: 'turn_context' },
    { type: 'turn_context', payload: { cwd: '/zone' } },
    { type: 'event_msg', payload: { type: 'item_completed',
      item: { type: 'CommandExecution', command: 'node record.cjs done', formatted_output: 'amber: completion signal written for c.md\n' } } },
    { type: 'event_msg', payload: { type: 'item_completed',
      item: { type: 'CommandExecution', command: ['bash', '-lc', 'node record.cjs unit init plan.md'], stdout: 'amber: progress.json initialized with 1 unit(s): U1\n' } } },
    { type: 'event_msg', timestamp: 'T3', payload: { type: 'item_completed',
      item: { id: 'x3', type: 'CommandExecution', command: 'node record.cjs mark skip - a - b' } } },
    { type: 'event_msg', payload: { type: 'item_completed',
      item: { id: 'x4', type: 'CommandExecution', command: 'node record.cjs mark finding - f - d', stderr: 'amber: recorded mark finding\n' } } },
  ]);
  assert.deepEqual(codexEvents(file), {
    events: [
      { ln: 4, ts: '', kind: 'cmd done', expect: 'done-declaration', result: 'accepted' },
      { ln: 5, ts: '', kind: 'cmd unit init', expect: 'unit-init', result: 'accepted' },
      { ln: 6, ts: 'T3', kind: 'mark skip', expect: 'skip', result: 'unobserved' },
      { ln: 7, ts: '', kind: 'mark finding', expect: 'finding', result: 'accepted' },
    ],
    users: 0, assistants: 0, lines: 8, cwd: '/zone', stops: [], reentries: [], host: 'codex',
    stopsKnown: false, malformed: 0,
  });
});

test('messages and function calls cover typed planning, markers, and fallback commands', () => {
  const file = transcript([
    { type: 'response_item', timestamp: 'T1', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '$amber:planning port it' }, { type: 'image' }] } },
    { type: 'response_item', timestamp: 'T2', payload: { type: 'message', role: 'assistant',
      content: 'done\nAMBER_DONE\nAMBER_GOAL met\nAMBER_SKIP x' } },
    { type: 'response_item', payload: { type: 'function_call', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{not json' } },
    { type: 'response_item', timestamp: 'T5', payload: { type: 'function_call', name: 'shell', call_id: 'c2',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'node record.cjs unit verified U1 --evidence e'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2',
      output: [{ type: 'output_text', text: 'amber: unit U1 -> verified' }] } },
    'not json',
  ]);
  assert.deepEqual(codexEvents(file), {
    events: [
      { ln: 1, ts: 'T1', kind: 'typed amber:planning', expect: 'planning-invocation', name: 'amber:planning', typed: true },
      { ln: 2, ts: 'T2', kind: 'marker AMBER_DONE', expect: 'done-declaration' },
      { ln: 2, ts: 'T2', kind: 'marker AMBER_GOAL', expect: null },
      { ln: 2, ts: 'T2', kind: 'marker AMBER_SKIP', expect: 'skip' },
      { ln: 5, ts: 'T5', kind: 'cmd unit verified', expect: 'unit-verified', result: 'accepted' },
    ],
    users: 1, assistants: 1, lines: 8, cwd: null, stops: [], reentries: [], host: 'codex',
    stopsKnown: false, malformed: 1,
  });
});

test('null rows, null content blocks and null arguments fail with the engine TypeError', () => {
  const nullRead = (key) => {
    try { return null[key]; } catch (err) { return err; }
  };
  const meta = { type: 'session_meta', payload: { cwd: '/zone' } };
  const cases = [
    [[meta, 'null'], 'payload'],
    [[meta, { type: 'response_item', payload: { type: 'message', role: 'user', content: [null] } }], 'text'],
    [[meta, { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c', arguments: 'null' } }], 'cmd'],
  ];
  for (const [rows, key] of cases) {
    const expected = nullRead(key);
    assert.throws(() => codexEvents(transcript(rows)), (err) =>
      err instanceof TypeError && err.message === expected.message);
  }
  assert.deepEqual(commandEvents('node record.cjs done', [null, 'x'].slice(1), META),
    [{ ln: 7, ts: 't', kind: 'cmd done', expect: 'done-declaration', result: 'mention' }]);
  assert.throws(() => commandEvents('node record.cjs done', [null], META),
    (err) => err instanceof TypeError && err.message === nullRead('text').message);
});

test('non-string fields are converted the way the original converts them', () => {
  const file = transcript([
    { type: 'session_meta', timestamp: 5, payload: { cwd: 7 } },
    { type: 'response_item', payload: { type: 'function_call', name: ['shell'], call_id: 1,
      arguments: [JSON.stringify({ cmd: [['node record.cjs unit start U1']] })] } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 1, output: 3 } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'e',
      command: 'node record.cjs unit failed U1', stdout: 'amber: unit U1 -> ', stderr: ['failed', 2] } } },
  ]);
  assert.deepEqual(codexEvents(file), {
    events: [
      { ln: 2, ts: '', kind: 'cmd unit start', expect: 'unit-start', result: 'mention' },
      { ln: 4, ts: '', kind: 'cmd unit failed', expect: 'unit-failed', result: 'accepted' },
    ],
    users: 0, assistants: 0, lines: 5, cwd: 7, stops: [], reentries: [], host: 'codex',
    stopsKnown: false, malformed: 0,
  });
});
