import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  at,
  get,
  list,
  parseJson,
  show,
  text,
  textAt,
} from './support/json.mjs';
import { PLUGIN } from './support/plugin.mjs';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-codex-test-'));
const BOUNDARY =
  '# Codex fixture\n- edits [machine: write-scope plugin/**]\n' +
  '- docs [machine: write-scope docs/*.md]\n- no push [machine: bash-deny git\\s+push\\b]\n' +
  '## Standing rules\n- Preserve the experiment journal.\n## goal test\n- Fixture complete.\n';
after(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  cwd: string;
  readonly home: string;
  readonly session: string;
}

function fixture(contract = true): Fixture {
  const base = fs.mkdtempSync(path.join(BASE, 'case-'));
  const root = path.join(base, 'project with spaces');
  const home = path.join(base, 'amber-home');
  fs.mkdirSync(path.join(root, 'plugin', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'));
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  fs.writeFileSync(path.join(root, 'plugin', 'existing.cjs'), 'old\n');
  fs.writeFileSync(path.join(root, 'secrets.txt'), 'private fixture\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.amber/\n');
  // The fixture files are the pre-run state: committed, so the scope check
  // at done sees only what a test changes afterwards.
  const add = spawnSync('git', ['-C', root, 'add', '-A'], {
    encoding: 'utf8',
  });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '-m',
      'fixture',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(commit.status, 0, commit.stderr);
  if (contract) activate(root);
  return { root, cwd: root, home, session: randomUUID() };
}
function activate(root: string, filename = 'boundary.md'): void {
  fs.mkdirSync(path.join(root, '.amber'), { recursive: true });
  fs.writeFileSync(path.join(root, filename), BOUNDARY);
  fs.writeFileSync(
    path.join(root, '.amber', 'active.json'),
    JSON.stringify({
      v: 1,
      boundary: filename,
      ratified_by: 'fixture-user',
      ratified_at: '2026-09-10',
    }),
  );
}
function env(f: Fixture, thread: string | null = f.session): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env, AMBER_HOME: f.home };
  delete result['CODEX_THREAD_ID'];
  delete result['PI_SESSION_ID'];
  if (thread !== null) result['CODEX_THREAD_ID'] = thread;
  return result;
}
type CodexEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'Stop';
const DISPATCH: Readonly<Record<CodexEvent, string>> = {
  SessionStart: 'S0',
  UserPromptSubmit: 'S1',
  PreToolUse: 'E1',
  Stop: 'S2',
};
// Required fields follow codex-rs/hooks/schema/generated command input schemas.
function hook(
  f: Fixture,
  event: CodexEvent,
  fields: Readonly<Record<string, unknown>> = {},
): unknown {
  const input = {
    session_id: f.session,
    cwd: f.cwd,
    model: 'gpt-fixture-model',
    permission_mode: 'default',
    transcript_path: null,
    hook_event_name: event,
    ...(event === 'SessionStart'
      ? { source: 'startup' }
      : { turn_id: 'turn-fixture' }),
    ...fields,
  };
  const result = spawnSync(
    'sh',
    [path.join(PLUGIN, 'hooks', 'run.sh'), DISPATCH[event]],
    {
      cwd: BASE,
      env: env(f),
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(
    result.status,
    0,
    result.stderr || (result.error === undefined ? '' : String(result.error)),
  );
  assert.equal(result.stderr, '');
  assert.equal(
    fs.existsSync(path.join(f.home, 'state', 'sensor-failures.log')),
    false,
  );
  return result.stdout.trim() ? parseJson(result.stdout) : null;
}
function patch(f: Fixture, command: unknown): unknown {
  return hook(f, 'PreToolUse', {
    tool_name: 'apply_patch',
    tool_use_id: 'call-fixture',
    tool_input: { command },
  });
}
function ledger(f: Fixture): unknown[] {
  const filename = path.join(f.home, 'runs.jsonl');
  return fs.existsSync(filename)
    ? fs
        .readFileSync(filename, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => parseJson(l))
    : [];
}
function record(
  f: Fixture,
  args: readonly string[],
  thread: string | null = f.session,
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [path.join(PLUGIN, 'scripts', 'record.cjs'), ...args],
    {
      cwd: f.cwd,
      env: env(f, thread),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
}
type Tree = [string, Tree | string][];
function tree(root: string): Tree {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.name !== '.git')
    .map((e) => [
      e.name,
      e.isDirectory()
        ? tree(path.join(root, e.name))
        : fs.readFileSync(path.join(root, e.name), 'utf8'),
    ]);
}
/** `key in value`: a TypeError where value is not an object, as `in` throws. */
function hasKey(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(
      `Cannot use 'in' operator to search for '${key}' in ${show(value)}`,
    );
  }
  return key in value;
}
/** String(value), the coercion the original applied. */
function stringOf(value: unknown): string {
  return String(value);
}
/** new RegExp(pattern): undefined is the empty pattern, anything else its text. */
function regExpOf(pattern: unknown): RegExp {
  return new RegExp(pattern === undefined ? '' : stringOf(pattern));
}
const wrapped = (body: string): string =>
  '*** Begin Patch\n' + body + '\n*** End Patch';
const update = (target: string): string =>
  '*** Update File: ' + target + '\n@@\n-old\n+new';
const move = (from: string, to: string): string =>
  '*** Update File: ' + from + '\n*** Move to: ' + to + '\n@@\n-old\n+new';

const patchCases: [string, (f: Fixture) => string, boolean][] = [
  ['allowed add', () => '*** Add File: plugin/new.cjs\n+new', false],
  ['allowed update', () => update('plugin/existing.cjs'), false],
  ['allowed deletion', () => '*** Delete File: plugin/existing.cjs', false],
  ['outside deletion', () => '*** Delete File: secrets.txt', true],
  [
    'two allowed scopes',
    () =>
      '*** Add File: plugin/new.cjs\n+new\n*** Add File: docs/note.md\n+note',
    false,
  ],
  [
    'first allowed then blocked',
    () =>
      '*** Add File: plugin/new.cjs\n+new\n*** Add File: secrets2.txt\n+bad',
    true,
  ],
  [
    'move out checks destination',
    () => move('plugin/existing.cjs', 'outside.cjs'),
    true,
  ],
  [
    'move in checks source',
    () => move('secrets.txt', 'plugin/moved.cjs'),
    true,
  ],
  [
    'allowed move with spaces',
    () => move('plugin/existing.cjs', 'plugin/moved file.cjs'),
    false,
  ],
  [
    'relative path from nested cwd',
    (f) => {
      f.cwd = path.join(f.root, 'plugin', 'nested');
      return '*** Add File: local.cjs\n+new';
    },
    false,
  ],
  [
    'nested cwd escape',
    (f) => {
      f.cwd = path.join(f.root, 'plugin', 'nested');
      return '*** Add File: ../../outside.cjs\n+bad';
    },
    true,
  ],
  [
    'relative spaces',
    () => '*** Add File: plugin/file with spaces.cjs\n+new',
    false,
  ],
  [
    'absolute allowed path',
    (f) =>
      '*** Add File: ' + path.join(f.root, 'plugin', 'absolute.cjs') + '\n+new',
    false,
  ],
  [
    'absolute outside path',
    (f) => '*** Add File: ' + path.join(f.root, '..', 'outside.cjs') + '\n+bad',
    true,
  ],
];
for (const [label, body, denied] of patchCases) {
  test('apply_patch: ' + label, () => {
    const f = fixture();
    const command = wrapped(body(f));
    const before = tree(f.root);
    const out = patch(f, command);
    if (denied) {
      assert.equal(
        at(out, 'hookSpecificOutput', 'permissionDecision'),
        'deny',
        JSON.stringify(out),
      );
    } else assert.equal(out, null);
    assert.deepEqual(
      tree(f.root),
      before,
      'PreToolUse must not execute the patch',
    );
    assert.deepEqual(ledger(f), []);
  });
}

type Operation = 'add' | 'update' | 'delete' | 'move-source' | 'move-target';
const OPERATIONS: readonly Operation[] = [
  'add',
  'update',
  'delete',
  'move-source',
  'move-target',
];
for (const target of ['.amber/active.json', 'boundary.md']) {
  for (const operation of OPERATIONS) {
    test('apply_patch tamper guard: ' + operation + ' ' + target, () => {
      const f = fixture();
      fs.writeFileSync(
        path.join(f.root, 'boundary.md'),
        BOUNDARY.replace('plugin/**', '**'),
      );
      const bodies: Readonly<Record<Operation, string>> = {
        add: '*** Add File: ' + target + '\n+changed',
        update: update(target),
        delete: '*** Delete File: ' + target,
        'move-source': move(target, 'plugin/moved.cjs'),
        'move-target': move('plugin/existing.cjs', target),
      };
      const body = bodies[operation];
      const before = tree(f.root);
      const out = patch(f, wrapped(body));
      assert.equal(at(out, 'hookSpecificOutput', 'permissionDecision'), 'deny');
      assert.match(
        text(get(out, 'hookSpecificOutput', 'permissionDecisionReason')),
        /not editable|contract.*pointer/i,
      );
      assert.deepEqual(tree(f.root), before);
    });
  }
}
const malformedCommands: unknown[] = [
  undefined,
  42,
  '',
  '*** Begin Patch\n*** Add File: plugin/x\n+x',
  wrapped('*** Add File: \n+x'),
  wrapped('*** Unknown File: plugin/x\n+x'),
];
for (const command of malformedCommands) {
  test('malformed apply_patch fails closed: ' + JSON.stringify(command), () => {
    const out = patch(fixture(), command);
    assert.equal(
      at(out, 'hookSpecificOutput', 'permissionDecision'),
      'deny',
      JSON.stringify(out),
    );
  });
}
test('no contract leaves valid and malformed apply_patch silent', () => {
  const f = fixture(false);
  assert.equal(patch(f, wrapped('*** Delete File: secrets.txt')), null);
  assert.equal(patch(f, undefined), null);
  assert.equal(fs.existsSync(f.home), false);
});
test('Codex Bash command envelope enforces the existing command rule', () => {
  const f = fixture();
  const out = hook(f, 'PreToolUse', {
    tool_name: 'Bash',
    tool_use_id: 'call-shell',
    tool_input: { command: 'git push origin main' },
  });
  assert.equal(at(out, 'hookSpecificOutput', 'permissionDecision'), 'deny');
  assert.match(
    text(get(out, 'hookSpecificOutput', 'permissionDecisionReason')),
    /bash-deny/,
  );
});

test('Codex child patches map absolute linked-worktree paths even when hook cwd is the parent', () => {
  const f = fixture();
  hook(f, 'SessionStart');
  fs.writeFileSync(
    path.join(f.root, 'docs', 'plan.md'),
    '## Work units\n- [ ] U1 child [unit: U1 scope=plugin/child.cjs oracle=true]\n',
  );
  assert.equal(record(f, ['unit', 'init', 'docs/plan.md']).status, 0);
  const child = path.join(f.root, '.claude', 'worktrees', 'child');
  const wt = spawnSync(
    'git',
    ['-C', f.root, 'worktree', 'add', '-q', '--detach', child],
    { encoding: 'utf8' },
  );
  assert.equal(wt.status, 0, wt.stderr);
  const agent = randomUUID();
  const invoke = (toolName: string, command: string): unknown =>
    hook(f, 'PreToolUse', {
      agent_id: agent,
      agent_type: 'default',
      tool_name: toolName,
      tool_input: { command },
      tool_use_id: 'call-child',
    });
  assert.equal(
    invoke(
      'Bash',
      'node "' + path.join(PLUGIN, 'scripts', 'record.cjs') + '" unit claim U1',
    ),
    null,
  );
  const allowed = wrapped(
    '*** Add File: ' + path.join(child, 'plugin', 'child.cjs') + '\n+ok',
  );
  assert.equal(invoke('apply_patch', allowed), null);
  const denied = invoke(
    'apply_patch',
    wrapped(
      '*** Add File: ' + path.join(child, 'plugin', 'other.cjs') + '\n+bad',
    ),
  );
  assert.match(
    textAt(denied, 'hookSpecificOutput', 'permissionDecisionReason'),
    /blocked by unit U1/,
  );
  const tamper = invoke(
    'apply_patch',
    wrapped(
      '*** Add File: ' + path.join(child, '.amber', 'active.json') + '\n+{}',
    ),
  );
  assert.match(
    textAt(tamper, 'hookSpecificOutput', 'permissionDecisionReason'),
    /not editable/,
  );
  const outside = invoke(
    'apply_patch',
    wrapped(
      '*** Add File: ' +
        path.join(f.root, '..', 'unrelated', 'plugin', 'child.cjs') +
        '\n+bad',
    ),
  );
  assert.equal(at(outside, 'hookSpecificOutput', 'permissionDecision'), 'deny');
  assert.equal(
    ledger(f).filter((r) => get(r, 'trigger') === 'unit-claim').length,
    1,
  );
});

test('Codex startup and resume restore model state and current standing rules', () => {
  const f = fixture();
  for (const source of ['startup', 'resume']) {
    const model = 'gpt-fixture-model-' + source;
    const out = hook(f, 'SessionStart', { source, model });
    assert.match(
      text(get(out, 'hookSpecificOutput', 'additionalContext')),
      /boundary.md/,
    );
    assert.match(
      text(get(out, 'hookSpecificOutput', 'additionalContext')),
      /Preserve the experiment journal\./,
    );
    const state = parseJson(
      fs.readFileSync(
        path.join(f.home, 'state', 'session-' + f.session + '.json'),
        'utf8',
      ),
    );
    assert.equal(get(state, 'model'), model);
    assert.equal(get(state, 'briefed'), 'boundary.md');
  }
  assert.deepEqual(ledger(f), []);
});
test('Codex prompt briefs a contract activated after startup once', () => {
  const f = fixture(false);
  hook(f, 'SessionStart');
  activate(f.root, 'current-contract.md');
  const out = hook(f, 'UserPromptSubmit', {
    prompt: 'Continue the actual work.',
  });
  assert.match(
    text(get(out, 'hookSpecificOutput', 'additionalContext')),
    /current-contract.md/,
  );
  assert.equal(hook(f, 'UserPromptSubmit', { prompt: 'Continue.' }), null);
  assert.deepEqual(ledger(f), []);
});
for (const skill of ['planning', 'set', 'init', 'status', 'audit']) {
  test('Codex recorder invokes ' + skill + ' exactly once', () => {
    const f = fixture(false);
    f.cwd = path.join(f.root, 'plugin', 'nested');
    hook(f, 'SessionStart');
    hook(f, 'UserPromptSubmit', { prompt: '$' + skill + ' inspect fixture' });
    const result = record(f, ['invoke', skill, 'inspect', 'fixture']);
    assert.equal(result.status, 0, result.stderr);
    const rows = ledger(f);
    assert.equal(rows.length, 1);
    assert.equal(get(rows, 0, 'trigger'), 'skill-invocation');
    assert.equal(
      get(rows, 0, 'summary'),
      'amber:' + skill + ' inspect fixture',
    );
    assert.equal(get(rows, 0, 'session_id'), f.session);
    assert.equal(get(rows, 0, 'cwd'), f.cwd);
    assert.equal(get(rows, 0, 'model'), 'gpt-fixture-model');
  });
}
for (const kind of ['skip', 'finding']) {
  test('Codex recorder marks ' + kind + ' exactly once', () => {
    const f = fixture(false);
    const result = record(f, ['mark', kind, 'survey result', '-', 'settled']);
    assert.equal(result.status, 0, result.stderr);
    const rows = ledger(f);
    assert.equal(rows.length, 1);
    assert.equal(get(rows, 0, 'trigger'), kind);
    assert.equal(get(rows, 0, 'summary'), 'survey result - settled');
    assert.equal(get(rows, 0, 'session_id'), f.session);
    assert.equal(get(rows, 0, 'cwd'), f.cwd);
  });
}
test('Codex recorder marks an external hold with kind external', () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.root, 'docs', 'plan.md'),
    '## Work units\n- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]\n',
  );
  const init = record(f, ['unit', 'init', 'docs/plan.md']);
  assert.equal(init.status, 0, init.stderr);
  const result = record(f, ['mark', 'hold', 'U1 - external: sweep running']);
  assert.equal(result.status, 0, result.stderr);
  const holds = (): unknown[] =>
    ledger(f).filter((r) => get(r, 'trigger') === 'unit-hold');
  assert.equal(holds().length, 1);
  assert.equal(get(holds(), 0, 'kind'), 'external');
  assert.equal(get(holds(), 0, 'unit'), 'U1');
  assert.match(text(get(holds(), 0, 'summary')), /sweep running/);
  assert.equal(get(holds(), 0, 'session_id'), f.session);
  const progress = (): unknown =>
    parseJson(
      fs.readFileSync(path.join(f.root, '.amber', 'progress.json'), 'utf8'),
    );
  assert.equal(get(progress(), 'hold', 'kind'), 'external');
  const plain = record(f, ['mark', 'hold', 'U1 - waiting on the operator']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(holds().length, 2);
  assert.equal(hasKey(holds()[1], 'kind'), false);
  assert.equal(hasKey(get(progress(), 'hold'), 'kind'), false);
});
// ---- argument preparation (record-args joinMarkWords, prepareUnitArgs) ----
test('unit start folds a lowercase unit id', () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.root, 'docs', 'plan.md'),
    '## Work units\n- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]\n',
  );
  const init = record(f, ['unit', 'init', 'docs/plan.md']);
  assert.equal(init.status, 0, init.stderr);
  const start = record(f, ['unit', 'start', 'u1']);
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stdout, 'amber: unit U1 -> running\n');
  const progress = parseJson(
    fs.readFileSync(path.join(f.root, '.amber', 'progress.json'), 'utf8'),
  );
  assert.equal(get(progress, 'units', 'U1', 'status'), 'running');
  const starts = ledger(f).filter((r) => get(r, 'trigger') === 'unit-start');
  assert.equal(starts.length, 1);
  assert.equal(get(starts, 0, 'unit'), 'U1');
});
test('unit start refuses a bare number as before', () => {
  const f = fixture();
  const usage = record(f, ['--help']).stdout;
  const result = record(f, ['unit', 'start', '1']);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'amber: unit start needs a unit id like U1\n' + usage,
  );
  assert.deepEqual(ledger(f), []);
});
test('mark finding joins two quoted phrases with a dash', () => {
  const f = fixture(false);
  const result = record(f, ['mark', 'finding', 'a b', 'c d']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(get(ledger(f), 0, 'summary'), 'a b - c d');
});
test('mark finding with an empty word among phrases is not joined', () => {
  const f = fixture(false);
  const result = record(f, ['mark', 'finding', 'a b', '', 'c d']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(get(ledger(f), 0, 'summary'), 'a b  c d');
});
test('mark finding keeps a single phrase as is', () => {
  const f = fixture(false);
  const result = record(f, ['mark', 'finding', 'a - b']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(get(ledger(f), 0, 'summary'), 'a - b');
});
test('mark skip keeps unquoted words as is', () => {
  const f = fixture(false);
  const words = ['opening', 'verdict', '-', 'no', 'contract:', 'x'];
  const result = record(f, ['mark', 'skip', ...words]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    get(ledger(f), 0, 'summary'),
    'opening verdict - no contract: x',
  );
});
const invalidArgs: string[][] = [
  [],
  ['invoke'],
  ['invoke', 'unknown'],
  ['mark'],
  ['mark', 'other', 'text'],
  ['mark', 'skip'],
  ['mark', 'finding', '   '],
];
for (const args of invalidArgs) {
  test(
    'Codex recorder rejects invalid arguments without recording: ' +
      JSON.stringify(args),
    () => {
      const f = fixture(false);
      const result = record(f, args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /usage|invalid|required|expected|unknown/i);
      assert.deepEqual(ledger(f), []);
    },
  );
}
test('Codex recorder requires thread ID and supports help without it', () => {
  const f = fixture(false);
  const missing = record(f, ['invoke', 'planning'], null);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /CODEX_THREAD_ID/);
  const help = record(f, ['--help'], null);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /invoke/);
  assert.match(help.stdout, /mark/);
  assert.deepEqual(ledger(f), []);
});

function plantSignal(
  f: Fixture,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  fs.mkdirSync(path.join(f.root, '.amber'), { recursive: true });
  fs.writeFileSync(
    path.join(f.root, '.amber', 'done.json'),
    JSON.stringify({
      v: 1,
      ts: new Date().toISOString(),
      target: 'boundary.md',
      review: 'planted review',
      goal: 'planted goal',
      summary: 'fixture complete',
      ...fields,
    }),
  );
}
const signalExists = (f: Fixture): boolean =>
  fs.existsSync(path.join(f.root, '.amber', 'done.json'));
const DONE = [
  'done',
  '--review',
  'fixture artifact and current checks satisfy every row',
  '--goal',
  'fixture checked',
  '--summary',
  'fixture complete',
];

test('Codex Stop lifecycle: passed releases the contract', () => {
  const f = fixture();
  hook(f, 'SessionStart');
  const stop = (active: boolean): unknown =>
    hook(f, 'Stop', {
      last_assistant_message: 'Finished.',
      stop_hook_active: active,
    });
  assert.equal(stop(false), null, 'no signal, no gate');
  // The session registers as a driver when it runs a unit command or the signal itself.
  hook(f, 'PreToolUse', {
    tool_name: 'Bash',
    tool_use_id: 'call-unit',
    tool_input: { command: 'node record.cjs unit start U1' },
  });
  const noGoal = record(f, [
    'done',
    '--review',
    'checked',
    '--summary',
    'fixture complete',
  ]);
  assert.notEqual(noGoal.status, 0);
  assert.match(noGoal.stderr, /--goal/);
  assert.equal(signalExists(f), false);
  const written = record(f, DONE);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /boundary\.md/);
  assert.equal(signalExists(f), true);
  assert.equal(stop(false), null);
  const rows = ledger(f);
  assert.equal(rows.length, 1);
  assert.equal(get(rows, 0, 'gate'), 'passed');
  assert.equal(get(rows, 0, 'session_id'), f.session);
  assert.equal(get(rows, 0, 'cwd'), f.cwd);
  assert.equal(get(rows, 0, 'model'), 'gpt-fixture-model');
  assert.equal(get(rows, 0, 'summary'), 'fixture complete');
  assert.equal(get(rows, 0, 'goal'), 'fixture checked');
  assert.equal(get(rows, 0, 'review_target'), 'boundary.md');
  assert.match(text(get(rows, 0, 'review')), /current checks/);
  assert.equal(signalExists(f), false, 'signal consumed');
  assert.equal(
    fs.existsSync(path.join(f.root, '.amber', 'active.json')),
    false,
    'pointer released',
  );
  assert.equal(
    fs.existsSync(path.join(f.home, 'state', 'gate-' + f.session + '.json')),
    false,
  );
  assert.equal(stop(true), null);
  assert.equal(
    ledger(f).length,
    1,
    'foreign Stop reentry must not duplicate records',
  );
});
test('Codex Stop leaves a signal alone for a session that does not drive the run', () => {
  const f = fixture();
  hook(f, 'SessionStart');
  plantSignal(f);
  assert.equal(
    hook(f, 'Stop', {
      last_assistant_message: 'Finished.',
      stop_hook_active: false,
    }),
    null,
  );
  assert.equal(
    signalExists(f),
    true,
    'signal untouched by a non-driving session',
  );
  assert.deepEqual(ledger(f), []);
  assert.equal(fs.existsSync(path.join(f.root, '.amber', 'active.json')), true);
  hook(f, 'PreToolUse', {
    tool_name: 'Bash',
    tool_use_id: 'call-unit',
    tool_input: { command: 'node record.cjs unit start U1' },
  });
  assert.equal(
    hook(f, 'Stop', {
      last_assistant_message: 'Finished.',
      stop_hook_active: false,
    }),
    null,
  );
  assert.equal(signalExists(f), false);
  assert.equal(ledger(f).length, 1);
  assert.equal(get(ledger(f), 0, 'gate'), 'passed');
  assert.equal(
    fs.existsSync(path.join(f.root, '.amber', 'active.json')),
    false,
  );
});
for (const outcome of ['exhausted', 'withdrawn']) {
  test('Codex Stop lifecycle under a broken pointer: ' + outcome, () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.root, 'boundary.md'));
    hook(f, 'SessionStart');
    const refused = record(f, DONE);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /broken/);
    const stop = (active: boolean): unknown => {
      plantSignal(f);
      return hook(f, 'Stop', {
        last_assistant_message: 'Finished.',
        stop_hook_active: active,
      });
    };
    assert.equal(get(stop(false), 'decision'), 'block');
    assert.equal(signalExists(f), false, 'a rejected signal is consumed');
    if (outcome === 'exhausted') {
      assert.equal(get(stop(true), 'decision'), 'block');
      assert.equal(get(stop(true), 'decision'), 'block');
      assert.equal(stop(true), null);
    } else {
      assert.equal(
        hook(f, 'Stop', {
          last_assistant_message: 'Still working.',
          stop_hook_active: true,
        }),
        null,
      );
    }
    const rows = ledger(f);
    assert.equal(rows.length, outcome === 'withdrawn' ? 0 : 1);
    if (rows.length) {
      assert.equal(get(rows, 0, 'gate'), 'exhausted');
      assert.equal(get(rows, 0, 'contract'), 'broken');
      assert.equal(get(rows, 0, 'summary'), 'fixture complete');
    }
    assert.equal(
      fs.existsSync(path.join(f.home, 'state', 'gate-' + f.session + '.json')),
      false,
    );
  });
}
test('Codex Stop records a request-scoped completion without a contract', () => {
  const f = fixture(false);
  hook(f, 'SessionStart');
  const withGoal = record(f, DONE);
  assert.notEqual(withGoal.status, 0);
  assert.match(withGoal.stderr, /omit --goal/);
  const written = record(f, [
    'done',
    '--review',
    'requested artifact and test were checked',
    '--summary',
    'reviewed',
  ]);
  assert.equal(written.status, 0, written.stderr);
  const passed = hook(f, 'Stop', {
    last_assistant_message: 'AMBER_DONE: old markers are plain text',
    stop_hook_active: false,
  });
  assert.equal(passed, null);
  const rows = ledger(f);
  assert.equal(rows.length, 1);
  assert.equal(get(rows, 0, 'review_target'), 'request');
  assert.match(text(get(rows, 0, 'review')), /artifact and test/);
  assert.equal(get(rows, 0, 'summary'), 'reviewed');
  assert.equal(hasKey(rows[0], 'gate'), false);
});
test('Codex Stop ignores old marker lines without a signal', () => {
  const f = fixture();
  hook(f, 'SessionStart');
  const out = hook(f, 'Stop', {
    stop_hook_active: false,
    last_assistant_message:
      'AMBER_REVIEW: boundary.md - old\nAMBER_GOAL: old\nAMBER_DONE: old protocol',
  });
  assert.equal(out, null);
  assert.deepEqual(ledger(f), []);
  assert.equal(fs.existsSync(path.join(f.root, '.amber', 'active.json')), true);
});
test('Codex done compares changed files with the write-scope and records declarations', () => {
  const f = fixture();
  hook(f, 'SessionStart');
  hook(f, 'PreToolUse', {
    tool_name: 'Bash',
    tool_use_id: 'call-unit',
    tool_input: { command: 'node record.cjs unit start U1' },
  });
  fs.writeFileSync(
    path.join(f.root, 'notes.txt'),
    'written through the shell\n',
  );
  const refused = record(f, DONE);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /working-tree\s+notes\.txt/);
  assert.match(refused.stderr, /--out-of-scope/);
  assert.equal(signalExists(f), false);
  const declared = record(f, [
    ...DONE,
    '--out-of-scope',
    'notes.txt=fixture note kept on purpose',
  ]);
  assert.equal(declared.status, 0, declared.stderr);
  assert.equal(
    hook(f, 'Stop', {
      last_assistant_message: 'Finished.',
      stop_hook_active: false,
    }),
    null,
  );
  const rows = ledger(f);
  assert.equal(rows.length, 1);
  assert.equal(get(rows, 0, 'gate'), 'passed');
  assert.equal(get(rows, 0, 'out_of_scope_count'), 1);
  assert.equal(get(rows, 0, 'out_of_scope', 0, 'path'), 'notes.txt');
  assert.match(
    text(get(rows, 0, 'out_of_scope', 0, 'reason')),
    /kept on purpose/,
  );
});
test('hook configuration routes Codex apply_patch and resume to shared handlers', () => {
  const hooks = get(
    parseJson(
      fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'),
    ),
    'hooks',
  );
  assert.ok(
    list(get(hooks, 'PreToolUse')).some(
      (group) =>
        regExpOf(get(group, 'matcher')).test('apply_patch') &&
        regExpOf(get(group, 'matcher')).test('Monitor') &&
        list(get(group, 'hooks')).some((h) =>
          / E1$/.test(String(get(h, 'command'))),
        ),
    ),
  );
  assert.ok(
    list(get(hooks, 'SessionStart')).some(
      (group) =>
        regExpOf(get(group, 'matcher')).test('resume') &&
        list(get(group, 'hooks')).some((h) =>
          / S0$/.test(String(get(h, 'command'))),
        ),
    ),
  );
});

test('Codex invoke planning opens the phase and mark skip closes it with a phase-exit row', () => {
  const f = fixture(false);
  hook(f, 'SessionStart');
  const invoked = record(f, ['invoke', 'planning', 'phase gate']);
  assert.equal(invoked.status, 0, invoked.stderr);
  const stateFile = path.join(
    f.home,
    'state',
    'session-' + f.session + '.json',
  );
  const phase = get(parseJson(fs.readFileSync(stateFile, 'utf8')), 'phase');
  assert.equal(get(phase, 'state'), 'planning');
  assert.equal(get(phase, 'zone'), fs.realpathSync(f.root));
  assert.deepEqual(get(phase, 'snapshot'), []);
  assert.equal(ledger(f).length, 1);
  fs.writeFileSync(path.join(f.root, 'plugin', 'shell.cjs'), 'shell\n');
  const skipped = record(f, [
    'mark',
    'skip',
    'opening verdict - no contract: fixture',
  ]);
  assert.equal(skipped.status, 0, skipped.stderr);
  const rows = ledger(f);
  assert.equal(rows.length, 3);
  assert.equal(get(rows, 1, 'trigger'), 'skip');
  assert.equal(get(rows, 2, 'trigger'), 'phase-exit');
  assert.equal(get(rows, 2, 'phase'), 'planning');
  assert.equal(get(rows, 2, 'exit'), 'skip');
  assert.deepEqual(get(rows, 2, 'changed'), ['plugin/shell.cjs']);
  assert.equal(get(rows, 2, 'session_id'), f.session);
  assert.equal(get(rows, 2, 'model'), 'gpt-fixture-model');
  assert.equal(
    'phase' in (parseJson(fs.readFileSync(stateFile, 'utf8')) as object),
    false,
  );
});
