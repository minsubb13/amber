#!/usr/bin/env node
// Characterization tests for scripts/record.cjs and scripts/audit.cjs
// (stage 4): the branches the other suites do not take, pinned to what the
// commands print and how they exit today. Each test builds a small zone,
// ledger or transcript in a temporary directory and starts the command with
// its own AMBER_HOME (or HOME) and AMBER_TRANSCRIPTS, so the real records
// are never read or written. They assert current behavior, not a
// specification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');

const PLUGIN = path.resolve(__dirname, '..');
const RECORD = path.join(PLUGIN, 'scripts', 'record.cjs');
const AUDIT = path.join(PLUGIN, 'scripts', 'audit.cjs');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-characterization-s4-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const BOUNDARY = '# Characterization fixture\n- code [machine: write-scope plugin/**]\n';
const PERIOD = ['--period-end', '2026-12-31T00:00:00.000Z'];

function dir() {
  return fs.mkdtempSync(path.join(BASE, 'case-'));
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function zone({ pointer = { v: 1, boundary: 'boundary.md', ratified_by: 'u', ratified_at: 'd' } } = {}) {
  const base = dir();
  const root = path.join(base, 'zone');
  fs.mkdirSync(path.join(root, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.amber/\n');
  fs.writeFileSync(path.join(root, 'boundary.md'), BOUNDARY);
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture']);
  fs.mkdirSync(path.join(root, '.amber'));
  if (pointer) {
    fs.writeFileSync(path.join(root, '.amber', 'active.json'),
      typeof pointer === 'string' ? pointer : JSON.stringify(pointer));
  }
  return { base, root, home: path.join(base, 'amber-home') };
}

function record(z, args) {
  return spawnSync(process.execPath, [RECORD, ...args], {
    cwd: z.root, env: { ...process.env, AMBER_HOME: z.home, AMBER_SESSION_ID: 's4' },
    encoding: 'utf8', timeout: 10000,
  });
}

function refusal(r) {
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  return r.stderr;
}

// ---- record.cjs ----

test('record refuses an unknown unit command, a missing plan, a missing or malformed unit id', () => {
  const z = zone();
  const usage = record(z, ['--help']).stdout;
  assert.equal(refusal(record(z, ['unit', 'bogus'])), 'amber: invalid unit command\n' + usage);
  assert.equal(refusal(record(z, ['unit'])), 'amber: invalid unit command\n' + usage);
  assert.equal(refusal(record(z, ['unit', 'init', '--force'])), 'amber: unit init needs the plan path\n' + usage);
  assert.equal(refusal(record(z, ['unit', 'start'])), 'amber: unit start needs a unit id like U1\n' + usage);
  assert.equal(refusal(record(z, ['unit', 'start', 'X1'])), 'amber: unit start needs a unit id like U1\n' + usage);
});

test('record refuses unit commands under a broken pointer, without or with a broken progress file', () => {
  const broken = zone({ pointer: '{broken' });
  assert.match(refusal(record(broken, ['unit', 'start', 'U1'])), /^amber: active contract pointer is broken: /);
  const z = zone();
  assert.equal(refusal(record(z, ['unit', 'start', 'U1'])),
    'amber: no progress.json in ' + z.root + '; run `unit init <plan>` first\n');
  fs.writeFileSync(path.join(z.root, '.amber', 'progress.json'), '{"units": 3}');
  assert.equal(refusal(record(z, ['unit', 'start', 'U1'])), 'amber: progress.json is broken: no units object\n');
  assert.equal(refusal(record(z, ['done', '--review', 'r', '--goal', 'g', '--summary', 's'])),
    'amber: progress.json is broken: no units object\n');
  fs.writeFileSync(path.join(z.root, '.amber', 'progress.json'), '{"units": {}}');
  assert.equal(refusal(record(z, ['unit', 'claim', 'U9'])), 'amber: unknown unit U9\n');
});

test('record done without arguments asks for the review and the summary', () => {
  const z = zone({ pointer: null });
  const usage = record(z, ['--help']).stdout;
  assert.equal(refusal(record(z, ['done'])), 'amber: done needs --review and --summary\n' + usage);
});

// ---- audit.cjs ----

function audit(args, { home, transcripts, env } = {}) {
  const r = spawnSync(process.execPath, [AUDIT, ...args], {
    env: env || { ...process.env, AMBER_HOME: home, AMBER_TRANSCRIPTS: transcripts },
    encoding: 'utf8', timeout: 20000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function ledger(home, rows) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'runs.jsonl'),
    rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

test('summary counts rows with missing fields and reads HOME/.amber without AMBER_HOME', () => {
  const base = dir();
  ledger(path.join(base, '.amber'), [
    '{malformed',
    { ts: '2026-01-01T00:00:01.000Z', project: 'p', trigger: 'skill-invocation', session_id: 's1' },
    { project: 'p', trigger: 'skip', summary: 'something else', model: 'm', plugin_version: 'v' },
    { ts: '2026-01-01T00:00:02.000Z', project: 'p', trigger: 'skip', model: 'm', plugin_version: 'v' },
    { ts: '2027-01-01T00:00:00.000Z', project: 'p', trigger: 'skip' },
  ]);
  const env = { ...process.env, HOME: base };
  delete env.AMBER_HOME;
  const r = audit(['summary', ...PERIOD], { env });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, [
    'period_end=2026-12-31T00:00:00.000Z',
    'excluded_projects=none',
    'ledger_rows=4 malformed=1 field_rows=3',
    'by_project: p=3',
    'by_trigger: skill-invocation=1 skip=2',
    'by_model: m=2 unknown=1',
    'model_unknown_by_trigger: skill-invocation=1',
    'by_plugin_version: unknown=1 v=2',
    'skill_invocations: =1',
    'skips: other=2',
    'done: with_contract=0 without_contract=0 with_review=0 with_goal=0',
    'gate: ',
    'completions_distinct_contracts=0',
    'completions: ',
    'unit_events: ',
    'unit_rows_attributed: session=0 shell=0',
    'out_of_scope_declarations=0',
    'sessions_distinct=2',
  ].join('\n') + '\n');
});

test('dead counts rows without summaries and names a sensor-failure file', () => {
  const home = path.join(dir(), 'home');
  ledger(home, [{ ts: '2026-01-01T00:00:01.000Z', trigger: 'skill-invocation' }]);
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'state', 'sensor-failures.log'), 'x\n');
  const r = audit(['dead', ...PERIOD], { home });
  assert.equal(r.status, 0, r.err);
  const lines = r.out.split('\n');
  assert.ok(lines.includes('amber:planning (Skill tool) | 0 | DEAD (0 in field)'));
  assert.ok(lines.includes('sensor failure breadcrumb (state/sensor-failures.log) | file present | live'));
});

test('dead without a skills directory lists no skill rows', () => {
  const base = dir();
  const copy = path.join(base, 'plugin-copy');
  fs.cpSync(PLUGIN, copy, { recursive: true, filter: (src) => !['tests', 'skills'].includes(path.basename(src)) });
  const home = path.join(base, 'home');
  ledger(home, []);
  const r = spawnSync(process.execPath, [path.join(copy, 'scripts', 'audit.cjs'), 'dead', ...PERIOD], {
    env: { ...process.env, AMBER_HOME: home }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  // Only the per-skill rows depend on the directory; the research-route row is always listed.
  assert.equal(r.stdout.split('\n').filter((l) => /^amber:[a-z]+ \(Skill tool/.test(l)).length, 0);
  assert.ok(r.stdout.includes('amber:set research route (args mention research) | 0 | DEAD (0 in field)'));
});

test('sessions skips rows without a session, orders ties stably, and fills missing fields', () => {
  const base = dir();
  const home = path.join(base, 'home');
  const transcripts = path.join(base, 'transcripts');
  fs.mkdirSync(transcripts);
  ledger(home, [
    { ts: '2026-01-01T00:00:05.000Z', session_id: 'a', project: 'p1', trigger: 'x' },
    { ts: '2026-01-01T00:00:01.000Z', session_id: 'a', trigger: 'x' },
    { session_id: 'b', project: 'p2', trigger: 'x' },
    { ts: '2026-01-01T00:00:05.000Z', session_id: 'c', trigger: 'x' },
    { ts: '2026-01-01T00:00:06.000Z', trigger: 'x' },
    { ts: '2026-01-01T00:00:07.000Z', session_id: 'shell', trigger: 'x' },
  ]);
  const r = audit(['sessions', ...PERIOD], { home, transcripts });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, [
    'session=a project=p1 first=2026-01-01T00:00:01.000Z last=2026-01-01T00:00:05.000Z rows=2 completions=0 transcript=no',
    'session=c project=unknown first=2026-01-01T00:00:05.000Z last=2026-01-01T00:00:05.000Z rows=1 completions=0 transcript=no',
    'session=b project=p2 first= last= rows=1 completions=0 transcript=no',
  ].join('\n') + '\n');
});

function claudeTranscript(transcripts, id, lines) {
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, id + '.jsonl'),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}

const ASSISTANT = {
  type: 'assistant', timestamp: '2026-01-01T00:00:10.000Z', message: { content: [
    { type: 'tool_use', name: 'Skill' },
    { type: 'tool_use', name: 'Skill', input: { skill: 'other:x' } },
    { type: 'tool_use', name: 'Skill', input: { skill: 'amber:mark', args: 'weird' } },
    { type: 'tool_use', name: 'Skill', input: { skill: 'amber:mark', args: 'finding - f' } },
    { type: 'tool_use', name: 'Skill', input: { skill: 'amber:planning' } },
    { type: 'tool_use', name: 'Bash' },
    { type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'node record.cjs unit claim U1' } },
    { type: 'tool_use', name: 'Bash', id: 't2', input: { command: 'node "x/record.cjs" done --review r' } },
    { type: 'text' },
    { type: 'text', text: 'AMBER_SKIP x' },
  ] },
};

test('session reads every Claude transcript shape and matches rows by trigger and time', () => {
  const base = dir();
  const home = path.join(base, 'home');
  const transcripts = path.join(base, 'transcripts');
  claudeTranscript(transcripts, 'sess1234', [
    'not json',
    { type: 'user', isSidechain: true },
    { type: 'assistant', cwd: '/z', message: { content: 'plain' } },
    ASSISTANT,
    { type: 'user', timestamp: '2026-01-01T00:00:11.000Z', message: { content: [
      { type: 'text', text: 'hi' },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'amber: completion signal written for request' }] },
      { type: 'tool_result', tool_use_id: 'zz', content: 'x' },
    ] } },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-01-01T00:00:12.000Z' },
  ]);
  ledger(home, [
    { ts: '2026-01-01T00:00:12.000Z', session_id: 'sess1234', trigger: 'done-declaration', summary: 'd' },
    { ts: '2026-01-01T00:00:10.000Z', session_id: 'sess1234', trigger: 'skill-invocation', summary: 'amber:planning x' },
    { ts: '2026-01-01T00:00:10.000Z', session_id: 'sess1234', trigger: 'skill-invocation' },
    { ts: '2026-01-01T00:20:00.000Z', session_id: 'sess1234', trigger: 'finding', summary: 'late\nrow' },
    { ts: '2026-01-01T00:00:13.000Z', session_id: 'shell', cwd: '/z', trigger: 'unit-start' },
    { ts: '2026-01-01T00:00:13.000Z', trigger: 'skip' },
  ]);
  const r = audit(['session', 'sess1234', ...PERIOD], { home, transcripts });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.replaceAll(transcripts, '<T>'), [
    'session sess1234 transcript=<T>/sess1234.jsonl lines=7 user_msgs=1 assistant_msgs=1',
    'ledger rows for session (<= period_end): 4 [done-declaration=1 finding=1 skill-invocation=2]',
    'transcript events -> ledger:',
    // Equal gaps and lines: the earlier event takes the row first, so the
    // named planning call loses its only candidate to the malformed mark.
    '  L4 2026-01-01T00:00:10 mark malformed -> skill-invocation: matched (row 00:00:10, +0s)',
    '  L4 2026-01-01T00:00:10 mark finding -> finding: MISSING (nearest same-trigger row 2026-01-01T00:20:00)',
    '  L4 2026-01-01T00:00:10 skill amber:planning -> skill-invocation: MISSING (nearest same-trigger row 2026-01-01T00:00:10)',
    '  L4 2026-01-01T00:00:10 cmd unit claim -> -: n/a (no row by design)',
    '  L4 2026-01-01T00:00:10 cmd done -> done-declaration: matched (row 00:00:12, +2s)',
    '  L4 2026-01-01T00:00:10 marker AMBER_SKIP -> skip: MISSING',
    'ledger rows with no transcript event: 2',
    '  row 2026-01-01T00:00:10 skill-invocation ',
    '  row 2026-01-01T00:20:00 finding late row',
    'stop hook summaries: 1 [stop=1]',
    'loop send-backs (re-entry directives injected as user lines): 0',
    'summary: events=6 matched=2 matched_unattributed=0 refused=0 mentions=0 missing=3 orphan_rows=2',
  ].join('\n') + '\n');
});

test('check-session reports a lost opening verdict; a ledger row without ts stops session', () => {
  const base = dir();
  const home = path.join(base, 'home');
  const transcripts = path.join(base, 'transcripts');
  claudeTranscript(transcripts, 'sessabcd', [ASSISTANT]);
  ledger(home, [{ session_id: 'sessabcd', trigger: 'done-declaration' }]);
  const check = audit(['check-session', 'sessabcd', ...PERIOD], { home, transcripts });
  assert.deepEqual([check.status, check.out],
    [0, 'check-session sessabcd: opening-verdict texts in transcript=1 (lines 1), skip rows in ledger=0 -> LOSS DETECTED\n']);
  const session = audit(['session', 'sessabcd', ...PERIOD], { home, transcripts });
  assert.deepEqual([session.status, session.out, session.err],
    [1, '', "error: Cannot read properties of undefined (reading 'slice')\n"]);
});

test('check-summary compares a pre-exclusion block line by line, extra and missing lines included', () => {
  const base = dir();
  const home = path.join(base, 'home');
  ledger(home, [{ ts: '2026-01-01T00:00:01.000Z', project: 'p', trigger: 'skip', summary: 'opening verdict - x' }]);
  const report = path.join(base, 'report.md');
  fs.writeFileSync(report, '# r\n```\nperiod_end=2026-12-31T00:00:00.000Z\nledger_rows=1 malformed=0 field_rows=1\n```\n');
  const short = audit(['check-summary', report], { home });
  assert.equal(short.status, 1);
  assert.equal(short.out, 'check-summary: 15 line(s) differ\n');
  assert.ok(short.err.startsWith('DIFF line 3\n  report: \n  now:    by_project: p=1\n'));
  fs.writeFileSync(report, '# r\n```\nperiod_end=2026-12-31T00:00:00.000Z\n' +
    audit(['summary', ...PERIOD], { home }).out.split('\n').slice(2).join('\n') + 'extra=1\n```\n');
  const long = audit(['check-summary', report], { home });
  assert.equal(long.status, 1);
  assert.equal(long.out, 'check-summary: 1 line(s) differ\n');
  assert.equal(long.err, 'DIFF line 18\n  report: extra=1\n  now:    \n');
});

test('session handles events without a timestamp and results without content', () => {
  const base = dir();
  const home = path.join(base, 'home');
  const transcripts = path.join(base, 'transcripts');
  claudeTranscript(transcripts, 'sessxyz1', [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Skill', input: { skill: 'amber:mark', args: 'hold - U1 - r' } },
      { type: 'tool_use', name: 'Bash', id: 't9', input: { command: 'node record.cjs done --review r' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9' }] } },
  ]);
  ledger(home, [{ ts: '2026-01-01T00:00:01.000Z', session_id: 'sessxyz1', trigger: 'unit-hold', summary: 'U1 - r' }]);
  const r = audit(['session', 'sessxyz1', ...PERIOD], { home, transcripts });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.replaceAll(transcripts, '<T>'), [
    'session sessxyz1 transcript=<T>/sessxyz1.jsonl lines=3 user_msgs=1 assistant_msgs=1',
    'ledger rows for session (<= period_end): 1 [unit-hold=1]',
    'transcript events -> ledger:',
    '  L1  mark hold -> unit-hold: MISSING (nearest same-trigger row 2026-01-01T00:00:01)',
    '  L1  cmd done -> done-declaration: not an invocation (command text only mentions record.cjs)',
    'ledger rows with no transcript event: 1',
    '  row 2026-01-01T00:00:01 unit-hold U1 - r',
    'stop hook summaries: 0 []',
    'loop send-backs (re-entry directives injected as user lines): 0',
    'summary: events=2 matched=0 matched_unattributed=0 refused=0 mentions=1 missing=1 orphan_rows=1',
  ].join('\n') + '\n');
});

test('session keeps typed and model-invoked skill rows apart for Codex rollouts', () => {
  const base = dir();
  const home = path.join(base, 'home');
  const transcripts = path.join(base, 'transcripts');
  const id = '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(transcripts, 'rollout-2026-01-01T00-00-00-' + id + '.jsonl'), [
    { type: 'session_meta', timestamp: '2026-01-01T00:00:00.000Z', payload: { cwd: '/z' } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:01.000Z', payload: { type: 'message', role: 'user', content: '$amber:init now' } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:02.000Z', payload: { type: 'function_call', name: 'shell', call_id: 'c1',
      arguments: JSON.stringify({ command: 'node record.cjs invoke init' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'amber: recorded invoke init\n' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  ledger(home, [
    { ts: '2026-01-01T00:00:02.000Z', session_id: id, trigger: 'skill-invocation', summary: 'amber:init' },
    { ts: '2026-01-01T00:00:01.000Z', session_id: id, trigger: 'skill-invocation', summary: 'amber:init (typed)' },
  ]);
  const r = audit(['session', '0199aaaa', ...PERIOD], { home, transcripts });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.replaceAll(transcripts, '<T>'), [
    'session 0199aaaa transcript=<T>/rollout-2026-01-01T00-00-00-' + id + '.jsonl lines=5 user_msgs=1 assistant_msgs=0',
    'ledger rows for session (<= period_end): 2 [skill-invocation=2]',
    'transcript events -> ledger:',
    '  L2 2026-01-01T00:00:01 typed amber:init -> skill-invocation: matched (row 00:00:01, +0s)',
    '  L3 2026-01-01T00:00:02 skill amber:init -> skill-invocation: matched (row 00:00:02, +0s)',
    'ledger rows with no transcript event: 0',
    'stop hook summaries: unknown (Codex rollout does not expose stop_hook_summary; final messages are not hook evidence)',
    'loop send-backs (re-entry directives injected as user lines): 0',
    'summary: events=2 matched=2 matched_unattributed=0 refused=0 mentions=0 missing=0 orphan_rows=0',
  ].join('\n') + '\n');
});

test('check-summary compares a block that holds only its first line', () => {
  const base = dir();
  const home = path.join(base, 'home');
  ledger(home, []);
  const report = path.join(base, 'report.md');
  fs.writeFileSync(report, '```\nperiod_end=2026-12-31T00:00:00.000Z\n```\n');
  const r = audit(['check-summary', report], { home });
  assert.deepEqual([r.status, r.out], [1, 'check-summary: 16 line(s) differ\n']);
});
