// Characterization tests for hooks/amber-hook.cjs (stage 3): the branches the
// other suites do not take, pinned to what the hook does today. Most start
// the hook as a process with a crafted input and assert its output, the
// ledger rows and the state files; the five functions scripts/record.cjs
// imports are also called directly. They assert current behavior, not a
// specification. Every hook process gets its own AMBER_HOME or HOME, so the
// real ~/.amber is never touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { get, list, parseJson, text } from './support/json.mjs';
import { loadModule, PLUGIN } from './support/plugin.mjs';

const HOOK = path.join(PLUGIN, 'hooks', 'amber-hook.cjs');
const BASE = fs.mkdtempSync(
  path.join(os.tmpdir(), 'amber-characterization-s3-'),
);
const DIRECT_HOME = path.join(BASE, 'direct-home');
// The hook module reads AMBER_HOME when it loads.
process.env['AMBER_HOME'] = DIRECT_HOME;
const amberHook = loadModule<typeof import('../src/hooks/amber-hook.cjs')>(
  'hooks/amber-hook.cjs',
  ['driverOfRun', 'recordUnitEvent'],
);
after(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

const BOUNDARY =
  '# Characterization fixture\n' +
  '- code [machine: write-scope plugin/**]\n' +
  '- no push [machine: bash-deny git\\s+push\\b]\n';
const POINTER = {
  v: 1,
  boundary: 'boundary.md',
  ratified_by: 'fixture-user',
  ratified_at: '2026-10-12',
};

interface Fixture {
  readonly base: string;
  readonly root: string;
  readonly home: string;
}

function git(cwd: string, args: readonly string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function commitAll(root: string): void {
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
}

function fixture({
  repo = true,
  contract = true,
  pointer = POINTER,
}: { repo?: boolean; contract?: boolean; pointer?: unknown } = {}): Fixture {
  const base = fs.mkdtempSync(path.join(BASE, 'case-'));
  const root = path.join(base, 'zone');
  const home = path.join(base, 'amber-home');
  fs.mkdirSync(path.join(root, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.amber/\n');
  fs.writeFileSync(path.join(root, 'boundary.md'), BOUNDARY);
  if (repo) {
    git(root, ['init', '-q']);
    commitAll(root);
  }
  if (contract) {
    fs.mkdirSync(path.join(root, '.amber'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.amber', 'active.json'),
      typeof pointer === 'string' ? pointer : JSON.stringify(pointer),
    );
  }
  return { base, root, home };
}

interface HookOptions {
  readonly home?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly script?: string;
}

function hook(
  event: string,
  input: unknown,
  { home, cwd, env, script = HOOK }: HookOptions = {},
): unknown {
  assert.ok(home || env, 'every hook process needs its own AMBER_HOME or HOME');
  const r = spawnSync(process.execPath, [script, event], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    cwd,
    env: env || { ...process.env, AMBER_HOME: home },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.stdout.trim() ? parseJson(r.stdout) : null;
}

function rows(home: string): unknown[] {
  const file = path.join(home, 'runs.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => parseJson(l));
}

function readJson(file: string): unknown {
  return parseJson(fs.readFileSync(file, 'utf8'));
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

function writeState(home: string, sessionId: string, state: unknown): void {
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'state', 'session-' + sessionId + '.json'),
    JSON.stringify(state),
  );
}

function writeProgress(f: Fixture, value: unknown): void {
  fs.writeFileSync(
    path.join(f.root, '.amber', 'progress.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

function unit(fields: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    title: 't',
    scope: ['plugin/**'],
    after: [],
    oracle: '',
    status: 'pending',
    agent_id: null,
    reentries: 0,
    history: [],
    ...fields,
  };
}

function progressFile(
  units: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    v: 1,
    contract: 'boundary.md',
    plan: 'plan.md',
    created_at: 'x',
    current: null,
    hold: null,
    blocks: 0,
    session_ids: [],
    preexisting: [],
    units,
    ...extra,
  };
}

// Every caller applies a string method or assert.match to the context, which
// throw for anything but a string.
function context(output: unknown): string {
  assert.ok(output, 'expected additionalContext');
  return text(get(output, 'hookSpecificOutput', 'additionalContext'));
}

function denyReason(output: unknown): unknown {
  assert.ok(output, 'expected a deny decision');
  assert.equal(get(output, 'hookSpecificOutput', 'permissionDecision'), 'deny');
  return get(output, 'hookSpecificOutput', 'permissionDecisionReason');
}

// ---- where the hook keeps its state ----

test('without AMBER_HOME the hook keeps its ledger under HOME/.amber', () => {
  const f = fixture({ contract: false });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: f.base };
  delete env['AMBER_HOME'];
  assert.equal(
    hook(
      'S1',
      { session_id: 's', cwd: f.root, prompt: '/amber:planning x' },
      { env },
    ),
    null,
  );
  const ledger = rows(path.join(f.base, '.amber'));
  assert.equal(ledger.length, 1);
  assert.equal(get(ledger, 0, 'trigger'), 'planning-invocation');
});

test('a missing or unusable session id becomes unknown', () => {
  const f = fixture({ contract: false });
  hook('S0', { cwd: f.root }, { home: f.home });
  const state = readJson(path.join(f.home, 'state', 'session-unknown.json'));
  assert.deepEqual(keysOf(state), ['model', 'started_at']);
  assert.equal(get(state, 'model'), null);
  fs.rmSync(path.join(f.home, 'state', 'session-unknown.json'));
  hook(
    'S0',
    { session_id: '!!/..', cwd: f.root, model: 'm' },
    { home: f.home },
  );
  assert.equal(
    get(readJson(path.join(f.home, 'state', 'session-unknown.json')), 'model'),
    'm',
  );
});

test('a manifest without a version, or no manifest, reports plugin_version unknown', () => {
  const f = fixture({ contract: false });
  const copy = path.join(f.base, 'plugin-copy');
  fs.cpSync(PLUGIN, copy, {
    recursive: true,
    filter: (src) => path.basename(src) !== 'tests',
  });
  const manifest = path.join(copy, '.claude-plugin', 'plugin.json');
  const m = readJson(manifest);
  // delete m.version: a TypeError on null or undefined, nothing on a primitive.
  if (m === null || m === undefined) {
    throw new TypeError(
      `Cannot convert undefined or null to object (deleting 'version')`,
    );
  }
  if (typeof m === 'object') Reflect.deleteProperty(m, 'version');
  fs.writeFileSync(manifest, JSON.stringify(m));
  const script = path.join(copy, 'hooks', 'amber-hook.cjs');
  hook(
    'S1',
    { session_id: 's', cwd: f.root, prompt: '/amber:planning a' },
    { home: f.home, script },
  );
  fs.rmSync(manifest);
  hook(
    'S1',
    { session_id: 's', cwd: f.root, prompt: '/amber:planning b' },
    { home: f.home, script },
  );
  assert.deepEqual(
    rows(f.home).map((r) => get(r, 'plugin_version')),
    ['unknown', 'unknown'],
  );
});

// ---- zones ----

test('a repository with a separate git dir is its own zone', () => {
  const base = fs.mkdtempSync(path.join(BASE, 'case-'));
  const root = path.join(base, 'sepzone');
  const home = path.join(base, 'amber-home');
  git(base, [
    'init',
    '-q',
    '--separate-git-dir=' + path.join(base, 'gitdir'),
    root,
  ]);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  commitAll(root);
  hook(
    'S1',
    { session_id: 's', cwd: root, prompt: '/amber:planning x' },
    { home },
  );
  assert.equal(get(rows(home), 0, 'project'), 'sepzone');
  assert.match(
    context(hook('S0', { session_id: 's', cwd: root }, { home })),
    /^amber: no active contract in this zone\./,
  );
});

test('without a cwd outside git the zone is the process directory', () => {
  const base = fs.mkdtempSync(path.join(BASE, 'case-'));
  const dir = path.join(base, 'plainzone');
  const home = path.join(base, 'amber-home');
  fs.mkdirSync(dir);
  hook('S1', { prompt: '/amber:planning x' }, { home, cwd: dir });
  const [row] = rows(home);
  assert.equal(get(row, 'session_id'), 'unknown');
  assert.equal(get(row, 'cwd'), '');
  assert.equal(get(row, 'project'), 'plainzone');
});

test('a linked worktree outside the zone names the main checkout state', () => {
  const f = fixture();
  const wt = path.join(f.base, 'sibling');
  git(f.root, ['worktree', 'add', '-q', wt, '-b', 'sibling']);
  const active = context(
    hook('S0', { session_id: 's', cwd: wt }, { home: f.home }),
  );
  assert.ok(
    active.includes(
      'amber: this directory is a linked worktree of ' +
        f.root +
        ' and a zone of its own; the main checkout has an active contract - boundary.md, which does not apply here.',
    ),
  );
  fs.writeFileSync(path.join(f.root, '.amber', 'active.json'), '{broken');
  const broken = context(
    hook('S0', { session_id: 's', cwd: wt }, { home: f.home }),
  );
  assert.ok(
    broken.includes(
      'the main checkout has a broken contract pointer, which does not apply here.',
    ),
  );
  fs.rmSync(path.join(f.root, '.amber', 'active.json'));
  const none = context(
    hook('S0', { session_id: 's', cwd: wt }, { home: f.home }),
  );
  assert.ok(
    none.includes(
      'the main checkout has no active contract, which does not apply here.',
    ),
  );
});

// ---- the contract pointer ----

test('a pointer without a boundary is broken; without ratification fields it briefs unknown', () => {
  const f = fixture({ pointer: { v: 1 } });
  assert.equal(
    denyReason(
      hook(
        'E1',
        {
          session_id: 's',
          cwd: f.root,
          tool_name: 'Write',
          tool_input: { file_path: path.join(f.root, 'plugin', 'a.cjs') },
        },
        { home: f.home },
      ),
    ),
    'amber: active contract pointer ' +
      path.join(f.root, '.amber', 'active.json') +
      ' is broken (boundary path escapes the zone root). Fix it, or remove the file to release the contract.',
  );
  fs.writeFileSync(
    path.join(f.root, '.amber', 'active.json'),
    JSON.stringify({ v: 1, boundary: 'boundary.md' }),
  );
  assert.match(
    context(hook('S0', { session_id: 's', cwd: f.root }, { home: f.home })),
    /^amber: an active contract governs this zone - boundary\.md \(approved by unknown, unknown\)\./,
  );
});

test('S1 briefs a broken pointer once, keyed as broken', () => {
  const f = fixture({ pointer: '{broken' });
  const first = context(
    hook(
      'S1',
      { session_id: 's', cwd: f.root, prompt: 'hi' },
      { home: f.home },
    ),
  );
  assert.match(first, /^amber: the active contract pointer .* is broken \(/);
  assert.equal(
    get(readJson(path.join(f.home, 'state', 'session-s.json')), 'briefed'),
    'broken',
  );
  assert.equal(
    hook(
      'S1',
      { session_id: 's', cwd: f.root, prompt: 'hi' },
      { home: f.home },
    ),
    null,
  );
});

// ---- E1 ----

test('E1 in a zone that is not a git repository still applies the write-scope', () => {
  const f = fixture({ repo: false });
  const write = (file: string): unknown =>
    hook(
      'E1',
      {
        session_id: 's',
        cwd: f.root,
        tool_name: 'Write',
        tool_input: { file_path: path.join(f.root, file) },
      },
      { home: f.home },
    );
  assert.equal(write('plugin/a.cjs'), null);
  assert.equal(
    denyReason(write('other/a.cjs')),
    'amber: blocked by contract boundary.md: write target other/a.cjs is outside every write-scope (plugin/**)',
  );
});

test('E1 without tool_input, a Bash call without a command, and a Write without a path pass', () => {
  const f = fixture();
  assert.equal(
    hook(
      'E1',
      { session_id: 's', cwd: f.root, tool_name: 'Bash' },
      { home: f.home },
    ),
    null,
  );
  assert.equal(
    hook(
      'E1',
      { session_id: 's', cwd: f.root, tool_name: 'Bash', tool_input: {} },
      { home: f.home },
    ),
    null,
  );
  assert.equal(
    hook(
      'E1',
      { session_id: 's', cwd: f.root, tool_name: 'Write', tool_input: {} },
      { home: f.home },
    ),
    null,
  );
});

test('E1 takes a NotebookEdit target from notebook_path', () => {
  const f = fixture();
  assert.equal(
    denyReason(
      hook(
        'E1',
        {
          session_id: 's',
          cwd: f.root,
          tool_name: 'NotebookEdit',
          tool_input: { notebook_path: path.join(f.root, 'nb', 'a.ipynb') },
        },
        { home: f.home },
      ),
    ),
    'amber: blocked by contract boundary.md: write target nb/a.ipynb is outside every write-scope (plugin/**)',
  );
});

test('E1 without a cwd resolves the zone and relative targets from the process directory', () => {
  const f = fixture();
  const write = (file: string): unknown =>
    hook(
      'E1',
      { session_id: 's', tool_name: 'Write', tool_input: { file_path: file } },
      { home: f.home, cwd: f.root },
    );
  assert.equal(write('plugin/a.cjs'), null);
  assert.equal(
    denyReason(write('other/a.cjs')),
    'amber: blocked by contract boundary.md: write target other/a.cjs is outside every write-scope (plugin/**)',
  );
});

test('a unit command without a session id registers the session unknown', () => {
  const f = fixture();
  writeProgress(
    f,
    progressFile({ U1: unit() }, { session_ids: 'not-an-array' }),
  );
  assert.equal(
    hook(
      'E1',
      {
        cwd: f.root,
        tool_name: 'Bash',
        tool_input: { command: 'node /x/scripts/record.cjs unit start U1' },
      },
      { home: f.home },
    ),
    null,
  );
  assert.equal(
    get(readJson(path.join(f.home, 'state', 'session-unknown.json')), 'run'),
    'boundary.md',
  );
  assert.deepEqual(
    get(readJson(path.join(f.root, '.amber', 'progress.json')), 'session_ids'),
    ['unknown'],
  );
});

// ---- the completion signal (S2) ----

function done(f: Fixture, signal: unknown): void {
  fs.writeFileSync(
    path.join(f.root, '.amber', 'done.json'),
    typeof signal === 'string' ? signal : JSON.stringify(signal),
  );
}

test('S2 drops a corrupt, review-less or undated completion signal', () => {
  const f = fixture();
  writeState(f.home, 's', { run: 'boundary.md' });
  const signals: unknown[] = [
    '{corrupt',
    { summary: 's', review: 5, ts: new Date().toISOString() },
    { summary: 's', review: 'r', target: 'boundary.md' },
  ];
  for (const signal of signals) {
    done(f, signal);
    assert.equal(
      hook('S2', { session_id: 's', cwd: f.root }, { home: f.home }),
      null,
    );
    assert.equal(
      fs.existsSync(path.join(f.root, '.amber', 'done.json')),
      false,
    );
  }
  assert.deepEqual(rows(f.home), []);
});

test('S2 passes a completion in a zone that is not a git repository', () => {
  const f = fixture({ repo: false });
  writeState(f.home, 's', { run: 'boundary.md', briefed: 'boundary.md' });
  done(f, {
    v: 1,
    ts: new Date().toISOString(),
    target: 'boundary.md',
    summary: 'sum',
    review: 'rev',
    out_of_scope: [{ path: 'x', reason: 'y' }],
  });
  assert.equal(
    hook('S2', { session_id: 's', cwd: f.root }, { home: f.home }),
    null,
  );
  const [row] = rows(f.home);
  assert.deepEqual(
    [
      get(row, 'trigger'),
      get(row, 'contract'),
      get(row, 'goal'),
      get(row, 'gate'),
      get(row, 'review_target'),
      get(row, 'review'),
      get(row, 'out_of_scope'),
      get(row, 'out_of_scope_count'),
    ],
    [
      'done-declaration',
      'boundary.md',
      '',
      'passed',
      'boundary.md',
      'rev',
      [{ path: 'x', reason: 'y' }],
      1,
    ],
  );
  assert.equal(
    fs.existsSync(path.join(f.root, '.amber', 'active.json')),
    false,
  );
  assert.deepEqual(readJson(path.join(f.home, 'state', 'session-s.json')), {
    run: 'boundary.md',
  });
});

test('a gate file without attempts counts as none', () => {
  const f = fixture();
  writeState(f.home, 's', { run: 'boundary.md' });
  fs.writeFileSync(path.join(f.home, 'state', 'gate-s.json'), '{}');
  done(f, {
    v: 1,
    ts: new Date().toISOString(),
    target: 'other.md',
    summary: 's',
    review: 'r',
  });
  const out = hook('S2', { session_id: 's', cwd: f.root }, { home: f.home });
  assert.equal(get(out, 'decision'), 'block');
  assert.ok(
    text(get(out, 'reason')).startsWith(
      'amber gate (attempt 1/3): the completion signal names other.md but the ' +
        'active contract is boundary.md.',
    ),
  );
  assert.deepEqual(readJson(path.join(f.home, 'state', 'gate-s.json')), {
    attempts: 1,
  });
});

// ---- the loop body (S2 without a signal) ----

test('a stop with no open units, or no focus unit, is let through', () => {
  const f = fixture();
  writeState(f.home, 's', { run: 'boundary.md' });
  writeProgress(f, progressFile({ U1: unit({ status: 'verified' }) }));
  assert.equal(
    hook('S2', { session_id: 's', cwd: f.root }, { home: f.home }),
    null,
  );
  writeProgress(f, progressFile({ '': unit() }));
  assert.equal(
    hook('S2', { session_id: 's', cwd: f.root }, { home: f.home }),
    null,
  );
  assert.equal(
    get(
      readJson(path.join(f.root, '.amber', 'progress.json')),
      'units',
      '',
      'reentries',
    ),
    0,
  );
});

test('the re-entry limit without a session id is recorded by stop', () => {
  const f = fixture();
  writeState(f.home, 'unknown', { run: 'boundary.md' });
  writeProgress(f, progressFile({ U1: unit({ reentries: 10 }) }));
  assert.equal(hook('S2', { cwd: f.root }, { home: f.home }), null);
  const u = get(
    readJson(path.join(f.root, '.amber', 'progress.json')),
    'units',
    'U1',
  );
  assert.equal(get(u, 'status'), 'limit');
  assert.deepEqual(
    list(get(u, 'history')).map((h) => [
      get(h, 'event'),
      get(h, 'by'),
      get(h, 'note'),
    ]),
    [['limit', 'stop', 'reentry limit 10 reached']],
  );
  const [row] = rows(f.home);
  assert.deepEqual(
    [
      get(row, 'trigger'),
      get(row, 'session_id'),
      get(row, 'unit'),
      get(row, 'reentries'),
    ],
    ['unit-limit', 'unknown', 'U1', 10],
  );
});

// ---- briefings ----

test('S0 names a broken progress file and an external hold without a unit', () => {
  const f = fixture();
  writeProgress(f, '{broken');
  assert.ok(
    context(
      hook('S0', { session_id: 's', cwd: f.root }, { home: f.home }),
    ).includes(
      'amber: ' + path.join(f.root, '.amber', 'progress.json') + ' is broken (',
    ),
  );
  writeProgress(
    f,
    progressFile(
      { U1: unit() },
      {
        hold: {
          unit: null,
          reason: 'external: ci',
          by: 'b',
          ts: 'T',
          kind: 'external',
        },
      },
    ),
  );
  assert.ok(
    context(
      hook('S0', { session_id: 's', cwd: f.root }, { home: f.home }),
    ).includes('external hold on - since T: external: ci - every stop passes'),
  );
});

test('the S0 sweep leaves alone what it cannot remove', () => {
  const f = fixture({ contract: false });
  const dir = path.join(f.home, 'state', 'session-old');
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
  fs.utimesSync(dir, old, old);
  hook('S0', { session_id: 's', cwd: f.root }, { home: f.home });
  assert.equal(fs.existsSync(dir), true);
});

// ---- S1 and S3 ----

test('S1 without a prompt and S3 without tool_input record nothing', () => {
  const f = fixture({ contract: false });
  assert.equal(
    hook('S1', { session_id: 's', cwd: f.root }, { home: f.home }),
    null,
  );
  assert.equal(
    hook(
      'S3',
      { session_id: 's', cwd: f.root, tool_name: 'Skill' },
      { home: f.home },
    ),
    null,
  );
  assert.deepEqual(rows(f.home), []);
});

function mark(
  f: Fixture,
  args: string,
  extra: Readonly<Record<string, unknown>> = {},
): unknown {
  return hook(
    'S3',
    {
      session_id: 's',
      cwd: f.root,
      tool_name: 'Skill',
      tool_input: { skill: 'amber:mark', args },
      ...extra,
    },
    { home: f.home },
  );
}

test('a hold without a unit, or naming an unknown one, holds the run without a unit', () => {
  const f = fixture();
  writeProgress(f, progressFile({ U1: unit() }));
  mark(f, 'hold - waiting for ci');
  let p = readJson(path.join(f.root, '.amber', 'progress.json'));
  assert.deepEqual(
    [get(p, 'hold', 'unit'), get(p, 'hold', 'reason'), get(p, 'hold', 'by')],
    [null, 'waiting for ci', 's'],
  );
  mark(f, 'hold - U9 - external: build', { session_id: undefined });
  p = readJson(path.join(f.root, '.amber', 'progress.json'));
  assert.deepEqual(
    [
      get(p, 'hold', 'unit'),
      get(p, 'hold', 'reason'),
      get(p, 'hold', 'by'),
      get(p, 'hold', 'kind'),
    ],
    [null, 'external: build', 'model', 'external'],
  );
  assert.deepEqual(
    rows(f.home).map((r) => [
      get(r, 'trigger'),
      get(r, 'unit'),
      get(r, 'reason'),
      get(r, 'kind'),
      get(r, 'contract'),
    ]),
    [
      ['unit-hold', null, 'waiting for ci', undefined, 'boundary.md'],
      ['unit-hold', 'U9', 'external: build', 'external', 'boundary.md'],
    ],
  );
});

test('a hold still leaves its ledger row when progress.json has null units', () => {
  const f = fixture();
  writeProgress(f, '{"units": null}');
  mark(f, 'hold - U1 - r');
  assert.equal(
    fs.readFileSync(path.join(f.root, '.amber', 'progress.json'), 'utf8'),
    '{"units": null}',
  );
  assert.deepEqual(
    rows(f.home).map((r) => [
      get(r, 'trigger'),
      get(r, 'unit'),
      get(r, 'reason'),
    ]),
    [['unit-hold', 'U1', 'r']],
  );
});

// ---- mark argument preparation (record-args prepareMarkText) ----

test('mark accepts a unicode dash as the kind separator', () => {
  const f = fixture({ contract: false });
  mark(f, 'finding — x — y');
  assert.deepEqual(
    rows(f.home).map((r) => [get(r, 'trigger'), get(r, 'summary')]),
    [['finding', 'x — y']],
  );
});

test('mark hold folds a lowercase unit id', () => {
  const f = fixture();
  writeProgress(f, progressFile({ U1: unit() }));
  mark(f, 'hold – u1 – r');
  const p = readJson(path.join(f.root, '.amber', 'progress.json'));
  assert.deepEqual(
    [get(p, 'hold', 'unit'), get(p, 'hold', 'reason')],
    ['U1', 'r'],
  );
  assert.deepEqual(
    rows(f.home).map((r) => [
      get(r, 'trigger'),
      get(r, 'unit'),
      get(r, 'reason'),
      get(r, 'summary'),
    ]),
    [['unit-hold', 'U1', 'r', 'u1 – r']],
  );
});

test('a canonical mark leaves the ledger row unchanged', () => {
  const f = fixture();
  writeProgress(f, progressFile({ U1: unit() }));
  mark(f, 'hold - U1 - r');
  mark(f, 'skip - opening verdict - no contract: x');
  // Whole rows, with the volatile values pinned to their sources: the
  // timestamp to the ISO form, the rest to the fixture, the machine and the
  // manifest.
  const version = get(
    parseJson(
      fs.readFileSync(
        path.join(PLUGIN, '.claude-plugin', 'plugin.json'),
        'utf8',
      ),
    ),
    'version',
  );
  const common = {
    v: 1,
    ts: '<iso>',
    session_id: 's',
    cwd: f.root,
    project: path.basename(f.root),
    host: os.hostname(),
    model: 'unknown',
    plugin_version: version,
  };
  const pinned = rows(f.home).map((r) => {
    assert.match(
      text(get(r, 'ts')),
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
    );
    const row: Record<string, unknown> = {};
    const keys = typeof r === 'object' && r !== null ? Object.keys(r) : [];
    for (const k of keys) row[k] = k === 'ts' ? '<iso>' : get(r, k);
    return row;
  });
  assert.deepEqual(pinned, [
    {
      ...common,
      trigger: 'unit-hold',
      summary: 'U1 - r',
      unit: 'U1',
      reason: 'r',
      contract: 'boundary.md',
    },
    {
      ...common,
      trigger: 'skip',
      summary: 'opening verdict - no contract: x',
    },
  ]);
});

test('a unit range in a hold is not read as a separator', () => {
  const f = fixture();
  writeProgress(f, progressFile({ U1: unit() }));
  mark(f, 'hold - U1\u2013U3 blocked');
  const p = readJson(path.join(f.root, '.amber', 'progress.json'));
  assert.deepEqual(
    [get(p, 'hold', 'unit'), get(p, 'hold', 'reason')],
    [null, 'U1\u2013U3 blocked'],
  );
  assert.deepEqual(
    rows(f.home).map((r) => [get(r, 'unit'), get(r, 'summary')]),
    [[null, 'U1\u2013U3 blocked']],
  );
});

test('a bare-number hold stays unitless as before', () => {
  const f = fixture();
  writeProgress(f, progressFile({ U1: unit() }));
  mark(f, 'hold - 1 - r');
  const p = readJson(path.join(f.root, '.amber', 'progress.json'));
  assert.equal(get(p, 'hold', 'unit'), null);
  assert.deepEqual(
    rows(f.home).map((r) => [
      get(r, 'trigger'),
      get(r, 'unit'),
      get(r, 'summary'),
    ]),
    [['unit-hold', null, '1 - r']],
  );
});

// ---- crashes ----

test('a crash that cannot be recorded stays silent', () => {
  const f = fixture({ contract: false });
  const file = path.join(f.base, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  assert.equal(hook('S0', 'not json', { home: file }), null);
});

// ---- the functions record.cjs imports ----

test('driverOfRun picks the newest registered session and skips what it cannot read', () => {
  const state = path.join(DIRECT_HOME, 'state');
  fs.mkdirSync(state, { recursive: true });
  assert.equal(amberHook.driverOfRun(null), null);
  fs.writeFileSync(path.join(state, 'loop-x.json'), '{}');
  fs.writeFileSync(path.join(state, 'session-bad.json'), '{bad');
  fs.writeFileSync(
    path.join(state, 'session-a.json'),
    JSON.stringify({ run: 'b.md' }),
  );
  fs.writeFileSync(
    path.join(state, 'session-other.json'),
    JSON.stringify({ run: 'c.md', model: 'm' }),
  );
  const best = amberHook.driverOfRun('b.md');
  assert.deepEqual(
    [get(best, 'sessionId'), get(best, 'model'), typeof get(best, 'mtime')],
    ['a', null, 'number'],
  );
});

test('recordUnitEvent without fields writes a bare unit row', () => {
  const f = fixture({ contract: false });
  amberHook.recordUnitEvent('s', f.root, 'start', 'U1 started');
  const [row] = rows(DIRECT_HOME).filter(
    (r) => get(r, 'summary') === 'U1 started',
  );
  assert.deepEqual(
    [
      get(row, 'trigger'),
      get(row, 'session_id'),
      get(row, 'cwd'),
      get(row, 'model'),
    ],
    ['unit-start', 's', f.root, 'unknown'],
  );
  assert.deepEqual(keysOf(row), [
    'v',
    'ts',
    'session_id',
    'cwd',
    'project',
    'host',
    'model',
    'plugin_version',
    'trigger',
    'summary',
  ]);
});

// ---- inputs that are not hook objects ----

function crashLines(home: string): string[] {
  const file = path.join(home, 'state', 'sensor-failures.log');
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replace(/^\S+ /, ''))
    : [];
}

test('a JSON null input fails each handler at the first field it reads', () => {
  const f = fixture();
  for (const event of ['S0', 'S1', 'S2', 'S3', 'E1']) {
    assert.equal(hook(event, 'null', { home: f.home }), null);
  }
  assert.deepEqual(crashLines(f.home), [
    "hook-crash event=S0 Cannot read properties of null (reading 'cwd')",
    "hook-crash event=S1 Cannot read properties of null (reading 'session_id')",
    "hook-crash event=S2 Cannot read properties of null (reading 'session_id')",
    "hook-crash event=S3 Cannot read properties of null (reading 'tool_input')",
    "hook-crash event=E1 Cannot read properties of null (reading 'cwd')",
  ]);
});

test('a non-object input reads as an empty one; an unknown event does nothing', () => {
  const base = fs.mkdtempSync(path.join(BASE, 'case-'));
  const dir = path.join(base, 'plainzone');
  const home = path.join(base, 'amber-home');
  fs.mkdirSync(dir);
  for (const raw of ['5', '"x"', '[1]']) {
    assert.match(
      context(hook('S0', raw, { home, cwd: dir })),
      /^amber: no active contract in this zone\./,
    );
  }
  assert.equal(hook('XX', '{}', { home, cwd: dir }), null);
  assert.equal(hook('XX', 'not json', { home, cwd: dir }), null);
  assert.deepEqual(
    crashLines(home).map((l) => l.split(' ').slice(0, 2).join(' ')),
    ['hook-crash event=XX'],
  );
});

test('an empty standing-rules section briefs as none listed', () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.root, 'boundary.md'),
    BOUNDARY + '\n## Standing rules\n\n## Budget\n- none\n',
  );
  const brief = context(
    hook('S0', { session_id: 's', cwd: f.root }, { home: f.home }),
  );
  assert.ok(brief.includes('Standing rules:\n(none listed)\n'));
});

// ---- handoff: the verified-so-far block and the completion-conditions excerpt ----

function verifiedEntry(fields: Readonly<Record<string, unknown>>): unknown {
  return { ts: 't', event: 'verified', by: 's', note: 'ok', ...fields };
}

test('the S0 and first S1 briefings list the verified units with files and evidence under the summary', () => {
  const f = fixture();
  const files = Array.from(
    { length: 14 },
    (_, i) => 'f' + String(i + 1).padStart(2, '0'),
  );
  writeProgress(
    f,
    progressFile(
      {
        U1: unit({
          title: 'one',
          status: 'verified',
          history: [
            { ts: 't', event: 'start', by: 's' },
            verifiedEntry({
              note: 'E' + 'x'.repeat(199),
              files,
              files_count: 14,
            }),
          ],
        }),
        U2: unit({ title: 'two', status: 'running', after: ['U1'] }),
      },
      { current: 'U2' },
    ),
  );
  const block =
    'verified so far:\n- U1 one - files: ' +
    files.slice(0, 12).join(', ') +
    ' (+2 more) - evidence: E' +
    'x'.repeat(159) +
    '...\n';
  const s0 = context(
    hook(
      'S0',
      { session_id: 's', cwd: f.root, source: 'compact' },
      { home: f.home },
    ),
  );
  const s1 = context(
    hook(
      'S1',
      { session_id: 's1', cwd: f.root, prompt: 'hi' },
      { home: f.home },
    ),
  );
  assert.ok(s0.includes(block), s0);
  assert.ok(s0.indexOf('amber progress (') < s0.indexOf('verified so far:'));
  assert.ok(s1.includes(block), s1);
});

test('an entry without files prints no files part, and no verified unit prints no block', () => {
  const f = fixture();
  writeProgress(
    f,
    progressFile({
      U1: unit({
        title: 'one',
        status: 'verified',
        history: [verifiedEntry({})],
      }),
    }),
  );
  let brief = context(
    hook('S0', { session_id: 's', cwd: f.root }, { home: f.home }),
  );
  assert.ok(
    brief.includes('verified so far:\n- U1 one - evidence: ok\n'),
    brief,
  );
  assert.ok(!brief.includes('files:'));
  writeProgress(f, progressFile({ U1: unit({ status: 'running' }) }));
  brief = context(
    hook('S0', { session_id: 's', cwd: f.root }, { home: f.home }),
  );
  assert.ok(!brief.includes('verified so far'), brief);
  assert.ok(brief.includes('amber progress ('));
});

test('the send-back directive keeps the summary and leaves the block out', () => {
  const f = fixture();
  writeState(f.home, 's', { run: 'boundary.md' });
  writeProgress(
    f,
    progressFile(
      {
        U1: unit({
          title: 'one',
          status: 'verified',
          history: [verifiedEntry({ files: ['a'], files_count: 1 })],
        }),
        U2: unit({ status: 'running', after: ['U1'] }),
      },
      { current: 'U2', session_ids: ['s'] },
    ),
  );
  const out = hook('S2', { session_id: 's', cwd: f.root }, { home: f.home });
  const reason = text(get(out, 'reason'));
  assert.ok(reason.includes('amber progress ('), reason);
  assert.ok(!reason.includes('verified so far'), reason);
});

test('the briefing carries the completion conditions between the identity line and the standing rules', () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.root, 'boundary.md'),
    BOUNDARY +
      '\n## Completion conditions\n\n1. first\n2. second\n\n## Budget\n- none\n',
  );
  const brief = context(
    hook('S0', { session_id: 's', cwd: f.root }, { home: f.home }),
  );
  assert.match(
    brief,
    /^amber: an active contract governs[^\n]*\nCompletion conditions:\n1\. first\n2\. second\nStanding rules:\n\(none listed\)\n/,
  );
});

test('a contract without a completion-conditions section, or with an empty one, briefs as none listed', () => {
  const f = fixture();
  let brief = context(
    hook('S0', { session_id: 's', cwd: f.root }, { home: f.home }),
  );
  assert.ok(
    brief.includes('Completion conditions:\n(none listed)\nStanding rules:\n'),
    brief,
  );
  fs.writeFileSync(
    path.join(f.root, 'boundary.md'),
    BOUNDARY + '\n## Completion conditions\n\n## Budget\n- none\n',
  );
  brief = context(
    hook('S0', { session_id: 's', cwd: f.root }, { home: f.home }),
  );
  assert.ok(
    brief.includes('Completion conditions:\n(none listed)\nStanding rules:\n'),
    brief,
  );
});
