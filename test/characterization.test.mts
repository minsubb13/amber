// Characterization tests: paths of the hooks and scripts that the other suites
// do not execute, pinned to what the code does today. They exist so that the
// TypeScript port is compared on these paths too (npm run parity captures
// every product process these tests start); they assert current behavior, not
// a specification.
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { get, parseJson } from './support/json.mjs';
import { PLUGIN } from './support/plugin.mjs';

const HOOK = path.join(PLUGIN, 'hooks', 'amber-hook.cjs');
const RECORD = path.join(PLUGIN, 'scripts', 'record.cjs');
const AUDIT = path.join(PLUGIN, 'scripts', 'audit.cjs');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-characterization-'));
const BOUNDARY =
  '# Characterization fixture\n' +
  '- code [machine: write-scope plugin/**]\n' +
  '- notes [machine: write-scope docs/file?.md]\n' +
  '- no push [machine: bash-deny git\\s+push\\b]\n';
const PLAN =
  '# plan\n## Work units\n' +
  '- [ ] U1 first [unit: U1 scope=plugin/** oracle=true]\n' +
  '- [ ] U2 second [unit: U2 scope=docs/** after=U1 oracle=true]\n';
after(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly home: string;
}

function git(root: string, args: readonly string[]): void {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function fixture({
  repo = true,
  contract = true,
  pointer,
}: { repo?: boolean; contract?: boolean; pointer?: unknown } = {}): Fixture {
  const base = fs.mkdtempSync(path.join(BASE, 'case-'));
  const root = path.join(base, 'zone');
  const home = path.join(base, 'amber-home');
  fs.mkdirSync(path.join(root, 'plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'plugin', 'existing.cjs'), 'old\n');
  fs.writeFileSync(path.join(root, 'docs', 'plan.md'), PLAN);
  fs.writeFileSync(path.join(root, '.gitignore'), '.amber/\n');
  if (repo) {
    git(root, ['init', '-q']);
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
  if (contract) {
    fs.writeFileSync(path.join(root, 'boundary.md'), BOUNDARY);
    fs.mkdirSync(path.join(root, '.amber'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.amber', 'active.json'),
      JSON.stringify(
        pointer || {
          v: 1,
          boundary: 'boundary.md',
          ratified_by: 'fixture-user',
          ratified_at: '2026-10-10',
        },
      ),
    );
  }
  return { root, home };
}

function hookE1(
  f: Fixture,
  toolName: string,
  toolInput: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): unknown {
  const input = {
    session_id: 'characterization-session',
    cwd: f.root,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    ...extra,
  };
  const r = spawnSync(process.execPath, [HOOK, 'E1'], {
    input: JSON.stringify(input),
    env: { ...process.env, AMBER_HOME: f.home },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.stdout.trim() ? parseJson(r.stdout) : null;
}

function reason(decision: unknown): unknown {
  assert.ok(decision, 'expected a deny decision');
  assert.equal(
    get(decision, 'hookSpecificOutput', 'permissionDecision'),
    'deny',
  );
  return get(decision, 'hookSpecificOutput', 'permissionDecisionReason');
}

function record(f: Fixture, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [RECORD, ...args], {
    cwd: f.root,
    env: {
      ...process.env,
      AMBER_HOME: f.home,
      AMBER_SESSION_ID: 'characterization-session',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function writeProgress(f: Fixture, text: string): void {
  fs.writeFileSync(path.join(f.root, '.amber', 'progress.json'), text);
}

const patch = (body: string): string =>
  '*** Begin Patch\n' + body + '\n*** End Patch';
const patchDeny = (message: string): string =>
  'amber: cannot inspect apply_patch under contract boundary.md: ' +
  message +
  '. Correct the patch and retry.';

// ---- contract pointer ----

test('E1 denies every tool while the pointer boundary escapes the zone root', () => {
  const f = fixture({
    pointer: {
      v: 1,
      boundary: '../outside.md',
      ratified_by: 'x',
      ratified_at: '2026-10-10',
    },
  });
  assert.equal(
    reason(hookE1(f, 'Bash', { command: 'ls' })),
    'amber: active contract pointer ' +
      path.join(f.root, '.amber', 'active.json') +
      ' is broken (boundary path escapes the zone root). Fix it, or remove the file to release the contract.',
  );
});

// ---- subagent writes and claims ----

test('E1 denies a subagent write when progress.json is missing', () => {
  const f = fixture();
  assert.equal(
    reason(
      hookE1(
        f,
        'Write',
        { file_path: path.join(f.root, 'plugin', 'x.cjs') },
        { agent_id: 'agent-1' },
      ),
    ),
    'amber: subagent agent-1 cannot write under contract boundary.md: no progress.json - the main agent runs `node ' +
      RECORD +
      ' unit init <plan>` first, and each subagent claims its unit',
  );
});

test('E1 denies a subagent write when progress.json has no units', () => {
  const f = fixture();
  writeProgress(f, '{}');
  assert.equal(
    reason(
      hookE1(
        f,
        'Write',
        { file_path: path.join(f.root, 'plugin', 'x.cjs') },
        { agent_id: 'agent-1' },
      ),
    ),
    'amber: subagent agent-1 cannot write under contract boundary.md: progress.json is broken (no units object)',
  );
});

test('E1 refuses a subagent claim when progress.json is missing', () => {
  const f = fixture();
  assert.equal(
    reason(
      hookE1(
        f,
        'Bash',
        { command: 'node ' + RECORD + ' unit claim U1' },
        { agent_id: 'agent-1' },
      ),
    ),
    'amber: cannot record the unit claim: no progress.json in ' + f.root,
  );
});

test('E1 refuses a subagent claim when progress.json has no units', () => {
  const f = fixture();
  writeProgress(f, '{}');
  assert.equal(
    reason(
      hookE1(
        f,
        'Bash',
        { command: 'node ' + RECORD + ' unit claim U1' },
        { agent_id: 'agent-1' },
      ),
    ),
    'amber: cannot record the unit claim: progress.json is broken (no units object)',
  );
});

test('E1 refuses a claim on a unit another subagent holds', () => {
  const f = fixture();
  const init = record(f, ['unit', 'init', 'docs/plan.md']);
  assert.equal(init.status, 0, init.stderr);
  assert.equal(
    hookE1(
      f,
      'Bash',
      { command: 'node ' + RECORD + ' unit claim U1' },
      { agent_id: 'agent-A' },
    ),
    null,
  );
  assert.equal(
    reason(
      hookE1(
        f,
        'Bash',
        { command: 'node ' + RECORD + ' unit claim U1' },
        { agent_id: 'agent-B' },
      ),
    ),
    'amber: unit claim refused: unit U1 is already claimed by agent agent-A',
  );
  const p = parseJson(
    fs.readFileSync(path.join(f.root, '.amber', 'progress.json'), 'utf8'),
  );
  assert.equal(get(p, 'units', 'U1', 'agent_id'), 'agent-A');
});

// ---- record.cjs ----

test('record unit claim by the main agent warns and leaves the unit unclaimed', () => {
  const f = fixture();
  assert.equal(record(f, ['unit', 'init', 'docs/plan.md']).status, 0);
  const r = record(f, ['unit', 'claim', 'U1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    'amber: warning - the claim of U1 was not observed by a hook ' +
      '(no subagent context or no active contract); the unit remains unclaimed\n',
  );
  const p = parseJson(
    fs.readFileSync(path.join(f.root, '.amber', 'progress.json'), 'utf8'),
  );
  assert.equal(get(p, 'units', 'U1', 'agent_id'), null);
});

test('record unit init refuses to replace progress.json without --force', () => {
  const f = fixture();
  assert.equal(record(f, ['unit', 'init', 'docs/plan.md']).status, 0);
  const r = record(f, ['unit', 'init', 'docs/plan.md']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(
    r.stderr,
    'amber: ' +
      path.join(f.root, '.amber', 'progress.json') +
      ' already exists; pass --force to rebuild it from the plan\n',
  );
});

test('record unit init outside a git repository records no preexisting paths', () => {
  const f = fixture({ repo: false });
  const r = record(f, ['unit', 'init', 'docs/plan.md']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    'amber: progress.json initialized with 2 unit(s): U1, U2\n',
  );
  const p = parseJson(
    fs.readFileSync(path.join(f.root, '.amber', 'progress.json'), 'utf8'),
  );
  assert.deepEqual(get(p, 'preexisting'), []);
});

// ---- write-scope globs ----

test('a ? in a write-scope glob matches exactly one character', () => {
  const f = fixture();
  assert.equal(
    hookE1(f, 'Write', { file_path: path.join(f.root, 'docs', 'file1.md') }),
    null,
  );
  assert.equal(
    reason(
      hookE1(f, 'Write', {
        file_path: path.join(f.root, 'docs', 'file12.md'),
      }),
    ),
    'amber: blocked by contract boundary.md: write target docs/file12.md is outside every write-scope ' +
      '(plugin/**, docs/file?.md)',
  );
  assert.equal(
    reason(
      hookE1(f, 'Write', {
        file_path: path.join(f.root, 'docs', 'file/.md'),
      }),
    ),
    'amber: blocked by contract boundary.md: write target docs/file/.md is outside every write-scope ' +
      '(plugin/**, docs/file?.md)',
  );
});

// ---- apply_patch envelope ----

test('apply_patch wrapped in a heredoc is unwrapped before the scope check', () => {
  const f = fixture();
  const inside =
    "<<'EOF'\n" + patch('*** Add File: plugin/new.cjs\n+x') + '\nEOF';
  assert.equal(hookE1(f, 'apply_patch', { command: inside }), null);
  const outside = '<<EOF\n' + patch('*** Add File: secrets.txt\n+x') + '\nEOF';
  assert.equal(
    reason(hookE1(f, 'apply_patch', { command: outside })),
    'amber: blocked by contract boundary.md: write target secrets.txt is outside every write-scope ' +
      '(plugin/**, docs/file?.md)',
  );
});

test('apply_patch accepts one nonempty Environment ID before the first file', () => {
  const f = fixture();
  const body =
    '*** Environment ID: env-1\n*** Update File: plugin/existing.cjs\n@@\n-old\n+new';
  assert.equal(hookE1(f, 'apply_patch', { command: patch(body) }), null);
});

test('apply_patch refuses a repeated or empty Environment ID', () => {
  const f = fixture();
  const twice =
    '*** Environment ID: env-1\n*** Environment ID: env-2\n*** Add File: plugin/a.cjs\n+x';
  assert.equal(
    reason(hookE1(f, 'apply_patch', { command: patch(twice) })),
    patchDeny('Environment ID must be nonempty and appear only once'),
  );
  const empty = '*** Environment ID:   \n*** Add File: plugin/a.cjs\n+x';
  assert.equal(
    reason(hookE1(f, 'apply_patch', { command: patch(empty) })),
    patchDeny('Environment ID must be nonempty and appear only once'),
  );
});

test('apply_patch End of File closes a hunk and allows blank lines after it', () => {
  const f = fixture();
  const body =
    '*** Update File: plugin/existing.cjs\n@@\n-old\n+new\n*** End of File\n\n' +
    '*** Add File: plugin/b.cjs\n+x';
  assert.equal(hookE1(f, 'apply_patch', { command: patch(body) }), null);
});

test('apply_patch refuses an Update File section without hunk lines', () => {
  const f = fixture();
  assert.equal(
    reason(
      hookE1(f, 'apply_patch', {
        command: patch('*** Update File: plugin/existing.cjs'),
      }),
    ),
    patchDeny('each Update File section needs a nonempty update hunk'),
  );
  const eof = '*** Update File: plugin/existing.cjs\n@@\n*** End of File';
  assert.equal(
    reason(hookE1(f, 'apply_patch', { command: patch(eof) })),
    patchDeny('each Update File section needs a nonempty update hunk'),
  );
});

test('apply_patch refuses an update line without a diff prefix', () => {
  const f = fixture();
  const body = '*** Update File: plugin/existing.cjs\n@@\n-old\nbogus';
  assert.equal(
    reason(hookE1(f, 'apply_patch', { command: patch(body) })),
    patchDeny('invalid update line at line 5'),
  );
});

// ---- audit.cjs ----

test('audit reports an unreadable ledger as an error', () => {
  const f = fixture({ contract: false });
  fs.mkdirSync(path.join(f.home, 'runs.jsonl'), { recursive: true });
  const r = spawnSync(process.execPath, [AUDIT, 'summary'], {
    cwd: f.root,
    env: { ...process.env, AMBER_HOME: f.home },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^error: EISDIR/);
  assert.notEqual(r.status, 0);
});
