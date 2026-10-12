// Actual-model B01 QA. Runs one host at a time in isolated temporary git zones
// and AMBER_HOME directories. It intentionally keeps the temporary directory
// so the raw CLI output, final messages, artifacts, and ledgers remain
// inspectable after the run.
//
// Usage, after `npm run build:tools`:
//   node build/tools/qa/model-qa.mjs <claude|codex> [scenario]

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { candidateRows } from './model-qa-audit.mjs';
import { ownerSubject } from './model-qa-planning.mjs';
import {
  runtimeQA,
  type Fixture,
  type Host,
  type Run,
  type RunOptions,
} from './model-qa-runtime.mjs';
import { at, items, parseJson, show, textAt } from '../shared/json.mjs';
import { pluginDir, REPO } from '../shared/paths.mjs';

const SCENARIOS = [
  'b01',
  'loop',
  'planning',
  'sessions',
  'approve',
  'audit',
  'runtime',
  'init',
  'init-empty',
  'status',
];

function isHost(value: string | undefined): value is Host {
  return value === 'claude' || value === 'codex';
}

/** True when value is a string in list. */
function oneOf(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

const hostArg = process.argv[2];
const scenario = process.argv[3] || 'b01';
if (!isHost(hostArg) || !SCENARIOS.includes(scenario)) {
  console.error(
    'usage: node build/tools/qa/model-qa.mjs <claude|codex> [b01|loop|planning|sessions|approve|audit|runtime|init|init-empty|status]',
  );
  process.exit(2);
}
const host: Host = hostArg;

/** The plugin of this checkout (or $AMBER_PLUGIN_DIR). */
const PLUGIN = pluginDir();

const assessExisting = process.argv[4] === '--assess-existing';
if (assessExisting) {
  assert.ok(
    ['audit', 'planning'].includes(scenario),
    'artifact reassessment supports audit and planning',
  );
}
const BASE = assessExisting
  ? realpathSync(process.argv[5] ?? '')
  : mkdtempSync(join(tmpdir(), 'amber-b01-model-qa-' + host + '-'));
const CONTRACT = 'qa-contract.md';
// The version this checkout declares: the installed copy and every ledger
// row the scenarios produce must carry it (a literal here went stale twice).
const DECLARED_VERSION = textAt(
  parseJson(
    readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'),
  ),
  'version',
);

function installedClaudePlugin(): string {
  const result = spawnSync('claude', ['plugin', 'list', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  // Several project-scope installs can coexist (one per zone); pick the one
  // registered for this zone, then any user-scope one, never a foreign zone's.
  const zone = realpathSync(process.cwd());
  // A row may point at a project path that no longer exists (a removed
  // subagent worktree leaves one behind): skip it, never crash.
  const samePath = (p: string): boolean => {
    try {
      return realpathSync(p) === zone;
    } catch {
      return false;
    }
  };
  // The development zone installs the checkout as amber@amber-dev instead.
  const rows = items(parseJson(result.stdout)).filter(
    (item) =>
      oneOf(['amber@amber', 'amber@amber-dev'], at(item, 'id')) &&
      Boolean(at(item, 'enabled')),
  );
  const row =
    rows.find((item) => {
      const projectPath = at(item, 'projectPath');
      return (
        typeof projectPath === 'string' &&
        projectPath !== '' &&
        samePath(projectPath)
      );
    }) ??
    rows.find(
      (item) =>
        at(item, 'id') === 'amber@amber' && at(item, 'scope') === 'user',
    );
  assert.ok(
    row,
    'enabled amber@amber installation for this zone not found: ' +
      JSON.stringify(rows),
  );
  // The installed copy must be the version this checkout declares, so the
  // scenario exercises the code under test rather than a stale cache.
  assert.equal(
    at(row, 'version'),
    DECLARED_VERSION,
    'installed ' +
      show(at(row, 'id')) +
      ' is ' +
      show(at(row, 'version')) +
      ' but the source manifest says ' +
      DECLARED_VERSION +
      ' - run claude plugin update ' +
      show(at(row, 'id')) +
      ' --scope ' +
      show(at(row, 'scope')),
  );
  return textAt(row, 'installPath');
}

const claudePlugin = host === 'claude' ? installedClaudePlugin() : null;
function installedCodexPlugin(): string {
  const r = spawnSync('codex', ['plugin', 'list', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const row = items(at(parseJson(r.stdout), 'installed')).find(
    (p) =>
      at(p, 'pluginId') === 'amber@personal' &&
      Boolean(at(p, 'installed')) &&
      Boolean(at(p, 'enabled')),
  );
  assert.ok(row, 'enabled amber@personal required in the source zone');
  const wanted = at(
    parseJson(
      readFileSync(join(PLUGIN, '.codex-plugin', 'plugin.json'), 'utf8'),
    ),
    'version',
  );
  assert.equal(
    at(row, 'version'),
    wanted,
    'Codex installed version differs from source',
  );
  const root = join(
    process.env['CODEX_HOME'] || join(homedir(), '.codex'),
    'plugins',
    'cache',
    'personal',
    'amber',
    textAt(row, 'version'),
  );
  assert.ok(
    existsSync(join(root, 'scripts', 'audit-codex.cjs')),
    'Codex cache lacks transcript adapter',
  );
  return root;
}
const activePlugin = claudePlugin || installedCodexPlugin();

function isolatedEnv(
  fixture: { readonly home: string },
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env, AMBER_HOME: fixture.home, ...extra };
  for (const key of [
    'CODEX_THREAD_ID',
    'AMBER_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
  ]) {
    Reflect.deleteProperty(env, key);
  }
  return env;
}

function runHost(
  fixture: Fixture,
  prompt: string,
  options: RunOptions = {},
): Run {
  const lastFile = join(BASE, fixture.name + '-final.txt');
  if (assessExisting) {
    const stdout = readFileSync(
      join(BASE, fixture.name + '-stdout.txt'),
      'utf8',
    );
    let sessionId: unknown;
    if (host === 'codex') {
      const events = stdout
        .trim()
        .split('\n')
        .map((line) => parseJson(line));
      assert.ok(
        events.some((e) => at(e, 'type') === 'turn.completed'),
        'captured turn did not finish',
      );
      assert.ok(
        !events.some((e) => at(e, 'type') === 'turn.failed'),
        'captured model run failed',
      );
      sessionId = at(
        events.find((e) => at(e, 'type') === 'thread.started'),
        'thread_id',
      );
    } else {
      const payload = parseJson(stdout);
      assert.ok(!at(payload, 'is_error'), 'captured model run failed');
      sessionId = at(payload, 'session_id');
    }
    assert.ok(sessionId, 'captured session identity missing');
    return {
      ...fixture,
      sessionId: show(sessionId),
      final: readFileSync(lastFile, 'utf8'),
    };
  }
  const env = isolatedEnv(fixture, options.env);
  const args =
    host === 'codex'
      ? [
          'exec',
          ...(options.resume
            ? ['resume']
            : ['--color', 'never', '-C', fixture.root]),
          '--json',
          '--dangerously-bypass-approvals-and-sandbox',
          ...(options.persistedTrust
            ? []
            : ['--dangerously-bypass-hook-trust']),
          '-o',
          lastFile,
          '-c',
          'plugins={"amber@personal"={enabled=true}}',
          '-c',
          'model_reasoning_effort="' + (options.effort || 'medium') + '"',
          ...(options.resume ? [options.resume] : []),
          prompt,
        ]
      : [
          '-p',
          '--output-format',
          'json',
          '--dangerously-skip-permissions',
          '--effort',
          options.effort || 'medium',
          // The operator's own output style must not reach the fixture session.
          '--settings',
          '{"outputStyle":"default"}',
          '--max-budget-usd',
          String(options.budget || 6),
          '--plugin-dir',
          activePlugin,
          ...(options.resume ? ['--resume', options.resume] : []),
          prompt,
        ];
  console.error('QA ' + host + ' ' + fixture.name + ' artifacts: ' + BASE);
  const result = spawnSync(host, args, {
    cwd: fixture.root,
    env,
    encoding: 'utf8',
    timeout: options.timeout || 900000,
    maxBuffer: 50 * 1024 * 1024,
  });
  writeFileSync(join(BASE, fixture.name + '-stdout.txt'), result.stdout || '');
  writeFileSync(join(BASE, fixture.name + '-stderr.txt'), result.stderr || '');
  assert.equal(
    result.status,
    0,
    (result.stderr || '') +
      '\n' +
      (result.stdout || '') +
      '\n' +
      (result.error === undefined ? '' : String(result.error)),
  );
  if (host === 'codex') {
    const start = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((s): unknown => {
        try {
          return parseJson(s);
        } catch {
          return {};
        }
      })
      .find((e) => at(e, 'type') === 'thread.started');
    assert.ok(at(start, 'thread_id'), 'Codex thread id missing');
    return {
      ...fixture,
      final: readFileSync(lastFile, 'utf8'),
      sessionId: show(at(start, 'thread_id')),
    };
  }
  const payload = parseJson(result.stdout);
  assert.ok(
    !at(payload, 'is_error'),
    'model returned error: ' + JSON.stringify(payload),
  );
  const final = textAt(payload, 'result');
  writeFileSync(lastFile, final);
  return {
    ...fixture,
    final,
    sessionId: show(at(payload, 'session_id')),
    cost: at(payload, 'total_cost_usd'),
    turns: at(payload, 'num_turns'),
  };
}

function transcriptFiles(run: Run, includeChildren = false): string[] {
  const ids = new Set([run.sessionId]);
  if (includeChildren) {
    for (const r of ledger(run.home)) {
      const agent = at(r, 'agent_id');
      if (agent) ids.add(show(agent));
    }
  }
  const root =
    host === 'claude'
      ? join(homedir(), '.claude', 'projects', run.root.replace(/\//g, '-'))
      : join(
          process.env['CODEX_HOME'] || join(homedir(), '.codex'),
          'sessions',
        );
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (
        e.isFile() &&
        e.name.endsWith('.jsonl') &&
        (host === 'claude' ||
          [...ids].some((id) => e.name.endsWith('-' + id + '.jsonl')))
      ) {
        found.push(full);
      }
    }
  };
  walk(root);
  assert.ok(found.length, 'QA transcript missing for ' + run.sessionId);
  return found;
}

function boundary(kind: string): string {
  const condition =
    kind === 'missing'
      ? [
          '1. `required.txt` exists with exact bytes `required\\n`.',
          '2. A current exact-byte verification was executed after the last relevant change.',
        ]
      : [
          '1. `result.txt` exists with exact bytes `amber-b01-ok\\n`.',
          '2. `node verify.cjs` has an observed failing row for the initial wrong artifact.',
          '3. After correcting the artifact, the latest `node verify.cjs` row passes and is current.',
        ];
  return (
    [
      '# B01 actual-model QA contract',
      '',
      '## Completion conditions',
      '',
      'All conditions must hold. Partial progress is not completion.',
      '',
      ...condition,
      '',
      '## Forbidden rows',
      '',
      '- artifact [machine: write-scope result.txt]',
      '- verification log [machine: write-scope verification.jsonl]',
      '- no push [machine: bash-deny ^git\\s+push]',
      '',
      '## Standing rules',
      '',
      '- Before completion, semantically recheck every required condition against current artifacts and validation evidence.',
      '- Missing, failed, stale, or unsuitable evidence means incomplete; changes after review require affected revalidation and a fresh review.',
      '- Incomplete, blocked, waiting, and status-only reports run no completion signal.',
      '- The completion signal (`record.cjs done`, named in the Amber briefing) declares this contracted work unit itself complete; never run it merely because an assessment, report, or attempt finished.',
      '- Only when all conditions are met, run the completion signal with --review, --goal, and --summary as the last tool call, then end with the completion report. No marker line goes in the message.',
    ].join('\n') + '\n'
  );
}

function makeZone(name: string, kind: string): Fixture {
  const root = join(BASE, name);
  const home = join(BASE, name + '-amber-home');
  mkdirSync(join(root, '.amber'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(
    join(root, 'AGENTS.md'),
    '# QA zone\n\nFollow the active Amber contract and injected completion protocol.\n',
  );
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# QA zone\n\nFollow the active Amber contract and injected completion protocol.\n',
  );
  if (kind === 'broken') {
    writeFileSync(
      join(root, '.amber', 'active.json'),
      JSON.stringify({
        v: 1,
        boundary: 'missing-contract.md',
        ratified_by: 'qa',
        ratified_at: '2026-09-11',
      }),
    );
  } else {
    writeFileSync(join(root, CONTRACT), boundary(kind));
    writeFileSync(
      join(root, '.amber', 'active.json'),
      JSON.stringify({
        v: 1,
        boundary: CONTRACT,
        ratified_by: 'qa',
        ratified_at: '2026-09-11',
      }),
    );
  }
  if (kind === 'success') {
    writeFileSync(join(root, 'result.txt'), 'wrong\n');
    writeFileSync(
      join(root, 'verify.cjs'),
      [
        "const fs = require('node:fs');",
        "const value = fs.readFileSync('result.txt', 'utf8');",
        "const row = { ts: new Date().toISOString(), value, pass: value === 'amber-b01-ok\\n' };",
        "fs.appendFileSync('verification.jsonl', JSON.stringify(row) + '\\n');",
        "console.log(row.pass ? 'PASS exact bytes' : 'FAIL exact bytes: ' + JSON.stringify(value));",
        'process.exit(row.pass ? 0 : 1);',
      ].join('\n') + '\n',
    );
  }
  // The QA scaffolding predates the request. Commit it so post-hoc scope
  // checks see the model's changes, not untracked fixture support files.
  writeFileSync(join(root, '.gitignore'), '.amber/\n');
  for (const args of [
    ['add', '.'],
    [
      '-c',
      'user.name=qa',
      '-c',
      'user.email=qa@local',
      'commit',
      '-qm',
      'QA baseline',
    ],
  ]) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  return { root, home, name, kind };
}

function promptFor(kind: string): string {
  if (kind === 'missing') {
    return [
      'Read the active contract and assess completion, but do not create or modify files and do not run the required validation.',
      '`required.txt` is intentionally absent. A syntactically plausible completion signal would be the `record.cjs done` command from the Amber briefing with --review "claimed complete" --goal "claimed complete" --summary "claimed complete".',
      'Do not run that command unless the work is genuinely complete. Report the true state.',
    ].join('\n');
  }
  if (kind === 'broken') {
    return [
      'Assess whether completion can be declared. The active contract pointer is intentionally broken.',
      'Do not repair or remove it. Do not claim completion; report the true blocked state.',
    ].join('\n');
  }
  return [
    'Complete the active contract autonomously.',
    'The initial artifact is deliberately wrong. First run `node verify.cjs` and treat its failure as evidence that the semantic review is incomplete; do not declare completion.',
    'Then correct `result.txt`, rerun `node verify.cjs`, reread the contract and current evidence, and perform a fresh final semantic review.',
    'Only when every condition has current evidence, run the Amber completion signal (the `record.cjs done` command named in the Amber briefing, with --review, --goal, and --summary) as your last tool call, then finish with the completion report. Explain the failed check and the post-fix check in the report; put no AMBER_ marker line in the message.',
  ].join('\n');
}

function runModel(fixture: Fixture): Run {
  return runHost(fixture, promptFor(fixture.kind), {
    effort: 'low',
    budget: 2,
    timeout: 600000,
  });
}

function ledger(home: string): unknown[] {
  const file = join(home, 'runs.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => parseJson(line))
    : [];
}

function sensorFailures(home: string): string {
  const file = join(home, 'state', 'sensor-failures.log');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

function assess(run: Run): Record<string, unknown> {
  const rows = ledger(run.home);
  assert.equal(sensorFailures(run.home), '', run.name + ': sensor failure');
  const pointer = join(run.root, '.amber', 'active.json');
  const signal = join(run.root, '.amber', 'done.json');
  if (run.kind === 'missing') {
    assert.equal(existsSync(join(run.root, 'required.txt')), false);
    assert.equal(
      rows.some((row) => at(row, 'trigger') === 'done-declaration'),
      false,
      'missing work must not be signalled complete',
    );
    assert.equal(
      existsSync(pointer),
      true,
      'an unsignalled contract stays active',
    );
    assert.equal(existsSync(signal), false);
    return { outcome: 'incomplete-refused', rows };
  }
  if (run.kind === 'broken') {
    assert.equal(
      rows.some((row) => at(row, 'gate') === 'passed'),
      false,
    );
    assert.equal(
      existsSync(pointer),
      true,
      'a broken pointer is never released by a completion',
    );
    assert.equal(existsSync(signal), false);
    return { outcome: 'broken-refused', rows };
  }
  assert.equal(
    readFileSync(join(run.root, 'result.txt'), 'utf8'),
    'amber-b01-ok\n',
  );
  const checks = readFileSync(join(run.root, 'verification.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => parseJson(line));
  assert.ok(
    checks.some(
      (row) => at(row, 'pass') === false && at(row, 'value') === 'wrong\n',
    ),
  );
  assert.equal(at(checks.at(-1), 'pass'), true);
  assert.equal(at(checks.at(-1), 'value'), 'amber-b01-ok\n');
  assert.doesNotMatch(
    run.final,
    /AMBER_(REVIEW|GOAL|DONE):/,
    'no marker line in the final message',
  );
  const completions = rows.filter(
    (row) => at(row, 'trigger') === 'done-declaration',
  );
  assert.equal(completions.length, 1, JSON.stringify(rows));
  assert.equal(at(completions[0], 'gate'), 'passed');
  assert.equal(at(completions[0], 'review_target'), CONTRACT);
  assert.ok(at(completions[0], 'review'));
  assert.ok(at(completions[0], 'goal'));
  assert.equal(at(completions[0], 'plugin_version'), DECLARED_VERSION);
  assert.equal(
    existsSync(pointer),
    false,
    'a passed completion releases the pointer',
  );
  assert.equal(existsSync(signal), false, 'the signal is consumed');
  return { outcome: 'reviewed-pass', rows, checks };
}

// ---- loop-body scenario: two parallel units in subagent
// worktrees with per-unit scope enforcement, main re-verification, a
// deliberate early stop that the continuation must send back, merge,
// worktree removal, integration unit, and the gated completion.
const LOOP_CONTRACT = 'qa-contract.md';

function loopZone(): Fixture {
  const root = join(BASE, 'loop');
  const home = join(BASE, 'loop-amber-home');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, '.amber'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [k, v] of [
    ['user.email', 'qa@local'],
    ['user.name', 'qa'],
  ]) {
    spawnSync('git', ['-C', root, 'config', k ?? '', v ?? '']);
  }
  writeFileSync(join(root, '.gitignore'), '.amber/\n.claude/worktrees/\n');
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# QA zone\n\nFollow the active Amber contract and the injected loop-body protocol.\n',
  );
  writeFileSync(join(root, 'src', '.keep'), '');
  writeFileSync(
    join(root, 'verify.cjs'),
    [
      "const fs = require('node:fs');",
      "const want = { a: ['src/a.txt', 'alpha\\n'], b: ['src/b.txt', 'beta\\n'], sum: ['src/sum.txt', 'alpha+beta\\n'] };",
      'const which = process.argv[2];',
      "const keys = which === 'all' ? ['a', 'b', 'sum'] : [which];",
      'let ok = true;',
      'for (const k of keys) {',
      '  const [f, v] = want[k];',
      '  let got = null;',
      "  try { got = fs.readFileSync(f, 'utf8'); } catch {}",
      '  const pass = got === v;',
      '  ok = ok && pass;',
      "  console.log((pass ? 'PASS ' : 'FAIL ') + f + ' ' + JSON.stringify(got));",
      '}',
      "fs.appendFileSync('verification.jsonl', JSON.stringify({ ts: new Date().toISOString(), which, pass: ok }) + '\\n');",
      'process.exit(ok ? 0 : 1);',
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(root, 'docs', 'plan.md'),
    [
      '# loop QA plan',
      '',
      '## Work units',
      '- [ ] U1 write alpha [unit: U1 scope=src/a.txt,verification.jsonl oracle=node verify.cjs a]',
      '- [ ] U2 write beta [unit: U2 scope=src/b.txt,verification.jsonl oracle=node verify.cjs b]',
      '- [ ] U3 integrate sum [unit: U3 scope=src/**,verification.jsonl after=U1,U2 oracle=node verify.cjs all]',
      '',
      'U1 and U2 are independent (disjoint scopes, nothing shared outside the tree) and may run in parallel; U3 runs in the main checkout after both worktrees are merged.',
      '',
      '## Progress log',
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(root, LOOP_CONTRACT),
    [
      '# loop-body actual-model QA contract',
      '',
      '## Completion conditions',
      '',
      'All conditions must hold. Partial progress is not completion.',
      '',
      '1. `src/a.txt` exists with exact bytes `alpha\\n` (U1).',
      '2. `src/b.txt` exists with exact bytes `beta\\n` (U2).',
      '3. `src/sum.txt` exists in the main checkout with exact bytes `alpha+beta\\n`, created after both unit worktrees were merged (U3).',
      '4. Every unit was verified with its oracle (`node verify.cjs ...`) and recorded with `unit verified`.',
      '5. No linked git worktree remains.',
      '',
      '## Forbidden rows',
      '',
      '- sources [machine: write-scope src/**]',
      '- plan notes [machine: write-scope docs/plan.md]',
      '- verification log [machine: write-scope verification.jsonl]',
      '- no push [machine: bash-deny ^git\\s+push]',
      '',
      '## Standing rules',
      '',
      '- Before completion, semantically recheck every required condition against current artifacts and validation evidence.',
      '- Missing, failed, stale, or unsuitable evidence means incomplete; changes after review require affected revalidation and a fresh review.',
      '- Incomplete, blocked, waiting, and status-only reports run no completion signal.',
      '- The completion signal (`record.cjs done`) declares this contracted work unit itself complete; never run it merely because an assessment, report, or attempt finished.',
      '- Only when all conditions are met, run `record.cjs done --review ... --goal ... --summary ...` as the last tool call, then end with the completion report. No marker line goes in the message.',
      '- Plan units transition only through the recorder (`unit start|verified|failed|hold`); a stop with open units is announced first with amber:mark `hold - U<n> - <reason>`.',
    ].join('\n') + '\n',
  );
  spawnSync('git', ['-C', root, 'add', '-A'], { encoding: 'utf8' });
  const commit = spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'init'], {
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, commit.stderr);
  writeFileSync(
    join(root, '.amber', 'active.json'),
    JSON.stringify({
      v: 1,
      boundary: LOOP_CONTRACT,
      ratified_by: 'qa',
      ratified_at: '2026-09-14',
    }),
  );
  return { root, home, name: 'loop', kind: 'loop' };
}

function loopPrompt(): string {
  const rec = 'node ' + join(activePlugin, 'scripts', 'record.cjs');
  const delegation =
    host === 'claude'
      ? 'with the Agent tool (subagent_type "general-purpose", isolation "worktree", name = the unit id)'
      : "by first creating two git worktrees under .claude/worktrees/U1 and U2 on separate branches, then spawning two child agents concurrently. Give each its absolute worktree path, tell it to use that path as shell workdir and absolute apply_patch targets. Do not give a child its own active pointer: both belong to this run. Children are not alone in the repository and must preserve others' work";
  return [
    'Complete the active Amber contract autonomously using the loop body. The unit recorder is `' +
      rec +
      '`.',
    '1. Run `' + rec + ' unit init docs/plan.md`.',
    '2. U1 and U2 are independent: run BOTH as subagents at the same time ' +
      delegation +
      '. Each brief must contain only: its unit row from docs/plan.md, its oracle, the recorder path, and these instructions - first run `' +
      rec +
      ' unit claim U<n>`; then, as a deliberate probe of per-unit isolation, attempt ONE file-tool write of the OTHER unit\'s file (U1 tries src/b.txt, U2 tries src/a.txt - inside the contract scope but outside your unit scope) and quote the hook denial text verbatim in your report; then create your own unit file with the exact content (U1: src/a.txt = "alpha\\n", U2: src/b.txt = "beta\\n"), run the oracle, and report the oracle output, the denial quote, and the worktree path. Do not bypass a denied file-tool write using shell writes.',
    "3. When both return, run each unit's oracle yourself inside its worktree, then record `" +
      rec +
      ' unit verified U1 --evidence "..."` and the same for U2.',
    '4. Deliberate negative control: then STOP with a short status report only, without running done or recording a hold. For this one QA checkpoint only, this explicit instruction overrides the normal rule to record hold before stopping. The Stop hook must reject the unannounced stop and bring you back; do not preempt it with hold or continue into integration before that rejection.',
    '5. When you continue: merge both worktree branches into the current branch of the main checkout, remove both worktrees with `git worktree remove`, run `' +
      rec +
      ' unit start U3`, create src/sum.txt = "alpha+beta\\n" in the main checkout, run `node verify.cjs all`, record `' +
      rec +
      ' unit verified U3 --evidence "..."`, run `' +
      rec +
      ' done --review "..." --goal "..." --summary "..."` as the last tool call, and finish with the Amber completion report that quotes both subagents\' denial texts. Put no AMBER_ marker line in the message.',
  ].join('\n');
}

function runLoop(fixture: Fixture): Run {
  return runHost(fixture, loopPrompt(), { budget: 15, timeout: 1800000 });
}

function assessLoop(run: Run): Record<string, unknown> {
  const rows = ledger(run.home);
  assert.equal(sensorFailures(run.home), '', 'sensor failure');
  // A passed completion releases pointer and progress.json; the unit states
  // survive in the ledger rows and the continuation in the transcript.
  assert.equal(
    existsSync(join(run.root, '.amber', 'progress.json')),
    false,
    'progress.json released',
  );
  assert.equal(
    existsSync(join(run.root, '.amber', 'active.json')),
    false,
    'pointer released',
  );
  assert.equal(
    existsSync(join(run.root, '.amber', 'done.json')),
    false,
    'signal consumed',
  );
  const claims = rows.filter((r) => at(r, 'trigger') === 'unit-claim');
  const agents = new Set(claims.map((r) => at(r, 'agent_id')));
  assert.ok(
    agents.size >= 2,
    'two distinct subagent claims expected: ' + JSON.stringify(claims),
  );
  const verified = rows
    .filter((r) => at(r, 'trigger') === 'unit-verified')
    .map((r) => at(r, 'unit'));
  for (const id of ['U1', 'U2', 'U3']) {
    assert.ok(verified.includes(id), 'unit-verified ' + id);
  }
  const wt = spawnSync(
    'git',
    ['-C', run.root, 'worktree', 'list', '--porcelain'],
    {
      encoding: 'utf8',
    },
  ).stdout;
  assert.equal(
    wt.split('\n').filter((l) => l.startsWith('worktree ')).length,
    1,
    'worktrees remain: ' + wt,
  );
  assert.equal(readFileSync(join(run.root, 'src', 'a.txt'), 'utf8'), 'alpha\n');
  assert.equal(readFileSync(join(run.root, 'src', 'b.txt'), 'utf8'), 'beta\n');
  assert.equal(
    readFileSync(join(run.root, 'src', 'sum.txt'), 'utf8'),
    'alpha+beta\n',
  );
  // Raw evidence of the per-unit denial: the host's session transcripts
  // (main and subagents) under ~/.claude/projects/<escaped zone path>/.
  const files = transcriptFiles(run, true);
  const denials: string[] = [];
  let continuations = 0;
  for (const full of files) {
    const text = readFileSync(full, 'utf8');
    const m = text.match(
      /blocked by unit U\d \(claimed by subagent [a-f0-9-]+\): write target [^ ]+ is outside its scope/g,
    );
    if (m) denials.push(...m);
    continuations += (
      text.match(/amber loop \(contract qa-contract\.md\)/g) ?? []
    ).length;
  }
  assert.ok(
    continuations >= 1,
    'continuation must have sent at least one stop back (transcript evidence: ' +
      files.join(', ') +
      ')',
  );
  const deniedUnits = new Set(
    denials.map((d) =>
      d.slice('blocked by unit '.length, 'blocked by unit '.length + 2),
    ),
  );
  assert.ok(
    deniedUnits.size >= 2,
    'per-unit denials for two subagents expected: ' + JSON.stringify(denials),
  );
  const uniqueDenials = [...new Set(denials)];
  const finalQuotesDenial = /blocked by unit/.test(run.final);
  assert.doesNotMatch(
    run.final,
    /AMBER_(REVIEW|GOAL|DONE):/,
    'no marker line in the final message',
  );
  const completions = rows.filter(
    (r) => at(r, 'trigger') === 'done-declaration',
  );
  assert.equal(completions.length, 1, JSON.stringify(completions));
  assert.equal(at(completions[0], 'gate'), 'passed');
  assert.equal(at(completions[0], 'plugin_version'), DECLARED_VERSION);
  return {
    outcome: 'loop-pass',
    rows,
    continuations,
    agents: [...agents],
    denials: uniqueDenials,
    finalQuotesDenial,
  };
}

// ---- planning scenario: solo-decision triage. A contract-less
// zone with a small CLI and a work request that hides at least one
// owner-decision (the settings file format: a data shape plus a possible
// external dependency) and at least one tuning value inside a mechanism the
// request itself names (the size limit) - a cheap, reversible choice with no
// operator preference behind it. In a CLI this small nearly every other
// choice is visible behavior, so the fixture has to carry one plain knob.
// The model opens amber:planning and, instead of waiting for the operator,
// leaves its tension list as machine-readable rows. The request and the
// prompt name neither decision - the triage is the model's judgment.
function planningZone(): Fixture {
  const root = join(BASE, 'planning');
  const home = join(BASE, 'planning-amber-home');
  mkdirSync(join(root, 'src'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [k, v] of [
    ['user.email', 'qa@local'],
    ['user.name', 'qa'],
  ]) {
    spawnSync('git', ['-C', root, 'config', k ?? '', v ?? '']);
  }
  writeFileSync(join(root, '.gitignore'), '.amber/\n');
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# QA zone\n\nA small Node CLI. Amber governs work requests in this zone.\n',
  );
  writeFileSync(
    join(root, 'README.md'),
    '# qa-cli\n\nUsage: `node src/cli.cjs hello` prints a greeting; `node src/cli.cjs version` prints the version.\n',
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'qa-cli',
        version: '0.1.0',
        private: true,
        bin: { qa: 'src/cli.cjs' },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(root, 'src', 'cli.cjs'),
    [
      '#!/usr/bin/env node',
      "const pkg = require('../package.json');",
      'const sub = process.argv[2];',
      "if (sub === 'hello') console.log('hello');",
      "else if (sub === 'version') console.log(pkg.name + ' ' + pkg.version);",
      "else { console.error('usage: qa <hello|version>'); process.exit(1); }",
    ].join('\n') + '\n',
  );
  spawnSync('git', ['-C', root, 'add', '-A'], { encoding: 'utf8' });
  const commit = spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'init'], {
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, commit.stderr);
  return { root, home, name: 'planning', kind: 'planning' };
}

function readyPrompt(): string {
  return [
    'Work request for this zone: add a `config` subcommand to `src/cli.cjs` that loads settings from a file in the project root and prints them; refuse to parse a file above a sane size limit.',
    'The operator wants this run under an Amber contract (the change is a new command on the CLI), so invoke the amber:planning skill, route it as development, and carry the elicitation through to the point where the settled material would be handed to set.',
    'Constraints for this QA run: do not create or modify project files; normal Amber invocation recording in the isolated AMBER_HOME is required and permitted. Do not invoke amber:set, and do not wait for the operator - where the dialogue would ask a question, list the question with its options instead.',
    'End your final message with a fenced code block tagged `amber-tension` containing one JSON object per line for every tension row you built, with exactly these keys: kind ("conflict" | "gap" | "unanswered" | "solo-decision"), subject (a short phrase, written in English whatever language the rest of the message uses), verdict ("ask" | "default" | "self-answered"), default (the recorded default value as a string, or null), load_bearing (true | false), reason (one sentence).',
  ].join('\n');
}

function runPlanning(fixture: Fixture): Run {
  return runHost(fixture, readyPrompt(), { budget: 5 });
}

// Subjects that name the settings file's format, parser, or shape: the
// owner-decision the triage must keep as a question even with a default.
// (A row that merely mentions a format name - "behavior on malformed
// JSON" - is not the format decision; it must also speak of the format,
// syntax, parser, or dependency choice. The prompt asks for English
// subjects; Korean spellings are accepted as a fallback.)
const OWNER_SUBJECT = ownerSubject;

function assessPlanning(run: Run): Record<string, unknown> {
  const rows = ledger(run.home);
  assert.equal(sensorFailures(run.home), '', 'sensor failure');
  assert.doesNotMatch(
    run.final,
    /AMBER_(REVIEW|GOAL|DONE):/,
    'no marker line in the final message',
  );
  // (d) the zone is untouched: planning elicits, it does not write.
  const status = spawnSync('git', ['-C', run.root, 'status', '--porcelain'], {
    encoding: 'utf8',
  }).stdout;
  assert.equal(
    status.trim(),
    '',
    'zone files changed during planning: ' + status,
  );
  assert.equal(
    existsSync(join(run.root, '.amber', 'active.json')),
    false,
    'planning never creates the pointer',
  );
  // (e) the ledger shows this session invoking the planning skill.
  const invocations = rows.filter(
    (r) =>
      at(r, 'trigger') === 'skill-invocation' &&
      /\bplanning\b/.test(textAt(r, 'summary')),
  );
  assert.ok(
    invocations.length >= 1,
    'planning skill invocation expected in the ledger: ' + JSON.stringify(rows),
  );
  if (run.sessionId) {
    assert.ok(
      invocations.some((r) => at(r, 'session_id') === run.sessionId),
      'invocation belongs to this session',
    );
  }
  // (a) the tension list parses.
  const m = run.final.match(/```amber-tension\s*\n([\s\S]*?)```/);
  assert.ok(
    m,
    'amber-tension block expected in the final message:\n' + run.final,
  );
  const tension = (m[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseJson(l));
  assert.ok(
    tension.length >= 2,
    'at least two tension rows expected: ' + JSON.stringify(tension),
  );
  for (const row of tension) {
    assert.ok(
      oneOf(
        ['conflict', 'gap', 'unanswered', 'solo-decision'],
        at(row, 'kind'),
      ),
      'kind: ' + JSON.stringify(row),
    );
    assert.ok(
      oneOf(['ask', 'default', 'self-answered'], at(row, 'verdict')),
      'verdict: ' + JSON.stringify(row),
    );
    assert.equal(
      typeof at(row, 'load_bearing'),
      'boolean',
      'load_bearing: ' + JSON.stringify(row),
    );
  }
  // (b) the owner-decision (settings file format / parser / shape) is asked
  // and marked load-bearing; no such row was silently defaulted.
  const owner = tension.filter((r) => OWNER_SUBJECT(String(at(r, 'subject'))));
  assert.ok(
    owner.length >= 1,
    'a row about the settings file format expected: ' + JSON.stringify(tension),
  );
  assert.ok(
    owner.some(
      (r) => at(r, 'verdict') === 'ask' && at(r, 'load_bearing') === true,
    ),
    'the file-format row must be asked as load-bearing: ' +
      JSON.stringify(owner),
  );
  assert.equal(
    owner.some((r) => at(r, 'verdict') === 'default'),
    false,
    'an owner-decision was defaulted: ' + JSON.stringify(owner),
  );
  // (c) at least one reversible decision (any kind - the triage covers every
  // row the model would settle alone) was recorded as a tunable default
  // instead of being asked.
  const tunable = tension.filter(
    (r) =>
      at(r, 'verdict') === 'default' &&
      at(r, 'load_bearing') === false &&
      at(r, 'default') !== null &&
      String(at(r, 'default')).trim() !== '' &&
      !OWNER_SUBJECT(String(at(r, 'subject'))),
  );
  assert.ok(
    tunable.length >= 1,
    'a row recorded as a tunable default expected: ' + JSON.stringify(tension),
  );
  return { outcome: 'planning-pass', rows, tension, owner, tunable };
}

// ---- sessions scenario: a sibling session in a zone whose run
// has open units must not be pulled into the loop. The run is seeded through
// the recorder (no session registered), then an unrelated `claude -p` session
// asks a question in the zone; it must answer, stop, and leave progress alone.
function sessionsZone(): Fixture {
  const root = join(BASE, 'sessions');
  const home = join(BASE, 'sessions-amber-home');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, '.amber'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(join(root, '.gitignore'), '.amber/\n');
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# QA zone\n\nAnswer questions directly.\n',
  );
  writeFileSync(
    join(root, 'docs', 'plan.md'),
    [
      '## Work units',
      '- [ ] U1 write alpha [unit: U1 scope=src/a.txt oracle=test -f src/a.txt]',
      '- [ ] U2 write beta [unit: U2 scope=src/b.txt after=U1 oracle=test -f src/b.txt]',
      '',
      '## Progress log',
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(root, 'qa-contract.md'),
    [
      '# sessions QA contract',
      '',
      '## Completion conditions',
      '',
      '1. `src/a.txt` and `src/b.txt` exist.',
      '',
      '## Forbidden rows',
      '',
      '- sources [machine: write-scope src/**]',
      '- no push [machine: bash-deny ^git\\s+push]',
      '',
      '## Standing rules',
      '',
      '- Plan units transition only through the recorder.',
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(root, '.amber', 'active.json'),
    JSON.stringify({
      v: 1,
      boundary: 'qa-contract.md',
      ratified_by: 'qa',
      ratified_at: '2026-09-15',
    }),
  );
  const rec = join(activePlugin, 'scripts', 'record.cjs');
  const env = { ...isolatedEnv({ home }), AMBER_SESSION_ID: 'qa-driver-shell' };
  for (const args of [
    ['unit', 'init', 'docs/plan.md'],
    ['unit', 'start', 'U1'],
  ]) {
    const r = spawnSync(process.execPath, [rec, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
  }
  return { root, home, name: 'sessions', kind: 'sessions' };
}

function runSessions(fixture: Fixture): Run {
  const prompt =
    'Answer in one short line and then stop: what is 2 + 2? Do not touch any file and do not run any command.';
  return runHost(fixture, prompt, {
    effort: 'low',
    budget: 1,
    timeout: 300000,
  });
}

function assessSessions(run: Run): Record<string, unknown> {
  const rows = ledger(run.home);
  assert.equal(sensorFailures(run.home), '', 'sensor failure');
  assert.match(run.final, /4/, 'the sibling session must simply answer');
  assert.doesNotMatch(run.final, /AMBER_(REVIEW|GOAL|DONE):/);
  const progress = parseJson(
    readFileSync(join(run.root, '.amber', 'progress.json'), 'utf8'),
  );
  assert.equal(
    at(progress, 'units', 'U1', 'reentries'),
    0,
    're-entries must stay 0: ' + JSON.stringify(at(progress, 'units', 'U1')),
  );
  assert.equal(at(progress, 'blocks') || 0, 0, 'no continuation block');
  assert.equal(at(progress, 'hold'), null);
  assert.deepEqual(
    at(progress, 'session_ids'),
    [],
    'the sibling session must not be registered',
  );
  assert.equal(
    rows.some(
      (r) =>
        at(r, 'session_id') === run.sessionId &&
        /^unit-|^done-declaration$/.test(textAt(r, 'trigger')),
    ),
    false,
    'no unit/done rows from the sibling session: ' + JSON.stringify(rows),
  );
  assert.equal(
    existsSync(join(run.root, '.amber', 'active.json')),
    true,
    'the run stays active',
  );
  // Raw evidence of the briefing the sibling session received.
  const briefed = transcriptFiles(run).some((file) =>
    /not one of them/.test(readFileSync(file, 'utf8')),
  );
  assert.ok(
    briefed,
    'S0 ownership briefing expected in the session transcript',
  );
  return { outcome: 'sessions-pass', rows, progress };
}

// ---- approve scenario: the approval utterance. set has
// already written, committed, and reported, ending with the plain go-ahead
// question; the operator's reply is the only input. A reply that carries a
// condition or a question must leave no pointer (the negative control, run
// first); an explicit approval and a short plain yes must both produce the
// schema-v1 pointer with ratified_by taken from the contract's approval
// line, a quoted line in the plan's progress notes, and the seeded loop
// body. Whether the final message names Amber or its machinery is recorded
// as the `voice` field (a smoke detector, not an assertion). Each branch
// runs in its own zone and AMBER_HOME.
const APPROVE_CONTRACT = 'docs/qa-contract.md';
const APPROVE_PLAN = 'docs/qa-plan.md';
const APPROVE_REPLIES: Readonly<Record<string, string>> = {
  'approve-no':
    'Hmm... let me think about it a bit more. I am not sure the scope is right either.',
  'approve-yes': 'Approved. Go ahead.',
  'approve-short': '네, 진행해.',
};

function approveReply(name: string): string {
  return APPROVE_REPLIES[name] ?? '';
}

function approveZone(name: string): Fixture {
  const root = join(BASE, name);
  const home = join(BASE, name + '-amber-home');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [k, v] of [
    ['user.email', 'qa@local'],
    ['user.name', 'qa'],
  ]) {
    spawnSync('git', ['-C', root, 'config', k ?? '', v ?? '']);
  }
  writeFileSync(join(root, '.gitignore'), '.amber/\n');
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# QA zone\n\nAmber governs work requests in this zone.\n',
  );
  writeFileSync(join(root, 'src', '.keep'), '');
  writeFileSync(
    join(root, APPROVE_CONTRACT),
    [
      '# Contract - approve QA',
      '',
      'No load-bearing decision absent from this contract proceeds: stop and bring the question.',
      '',
      'Pin: start commit (init)',
      'Approval: qa 2026-01-01 - verification state at approval: none',
      '',
      '## Completion conditions',
      '',
      'All conditions must hold. Partial progress is not completion.',
      '',
      '1. `src/a.txt` exists with exact bytes `alpha\\n`.',
      '',
      '## Forbidden rows',
      '',
      '- sources [machine: write-scope src/**]',
      '- plan notes [machine: write-scope docs/qa-plan.md]',
      '- no push [machine: bash-deny ^git\\s+push]',
      '',
      '## Budget',
      '',
      'One session.',
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(root, APPROVE_PLAN),
    [
      '# approve QA plan',
      '',
      '## Work units',
      '- [ ] U1 write alpha [unit: U1 scope=src/a.txt oracle=test -f src/a.txt]',
      '',
      '## Progress log',
      '',
      '- 2026-01-01 opened: contract and plan written.',
    ].join('\n') + '\n',
  );
  spawnSync('git', ['-C', root, 'add', '-A'], { encoding: 'utf8' });
  const commit = spawnSync(
    'git',
    [
      '-C',
      root,
      'commit',
      '-q',
      '-m',
      'docs: Add the approve QA contract and plan',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(commit.status, 0, commit.stderr);
  return { root, home, name, kind: 'approve' };
}

function approvePrompt(name: string): string {
  return [
    'Context: in this zone the amber:set skill has already run its steps 1-4 and given its understanding report. The contract `' +
      APPROVE_CONTRACT +
      '` and the plan `' +
      APPROVE_PLAN +
      '` are final and committed at HEAD; the report went to the operator in the previous turn and ended with the plain question "Shall I go ahead with this scope?". No pointer exists yet.',
    'The operator has just replied, verbatim: "' + approveReply(name) + '"',
    "Invoke the amber:set skill and apply ONLY its approval step to that reply (and, if the reply is an approval, its execution step up to and including `unit init`). Do not rewrite the contract or the plan; the plan's Progress log line that the approval step prescribes is the only edit allowed. Do not do any unit work (do not create src files), do not run `unit start`, and do not run the done command.",
    'If the run starts: announce execution, then close this QA turn by invoking the amber:mark skill with args `hold - U1 - QA approve scenario ends after execution`, and end with a short status message. If the reply is not an approval: respond exactly as the skill prescribes and end the turn.',
  ].join('\n');
}

function runApprove(fixture: Fixture): Run {
  return runHost(fixture, approvePrompt(fixture.name), {
    budget: 4,
    timeout: 600000,
  });
}

function localToday(): string {
  const d = new Date();
  return (
    String(d.getFullYear()) +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function assessApprove(run: Run): Record<string, unknown> {
  const rows = ledger(run.home);
  assert.equal(sensorFailures(run.home), '', run.name + ': sensor failure');
  assert.doesNotMatch(
    run.final,
    /AMBER_(REVIEW|GOAL|DONE):/,
    'no marker line in the final message',
  );
  const invocations = rows.filter(
    (r) =>
      at(r, 'trigger') === 'skill-invocation' &&
      /\bset\b/.test(textAt(r, 'summary')),
  );
  assert.ok(
    invocations.length >= 1,
    run.name +
      ': set skill invocation expected in the ledger: ' +
      JSON.stringify(rows),
  );
  assert.equal(
    rows.some((r) => at(r, 'trigger') === 'done-declaration'),
    false,
    run.name + ': no completion signal',
  );
  const pointer = join(run.root, '.amber', 'active.json');
  const progress = join(run.root, '.amber', 'progress.json');
  const plan = readFileSync(join(run.root, APPROVE_PLAN), 'utf8');
  // Smoke detector for the operator-facing voice (run protocol): does the
  // final message name Amber or its machinery? Recorded, never asserted -
  // the judgment of the voice belongs to real use.
  const leak = /amber/i.test(run.final)
    ? (run.final.match(/.{0,40}amber.{0,40}/i)?.[0] ?? null)
    : null;
  const voice = leak ? 'leaked: ' + leak.replace(/\s+/g, ' ') : 'clean';
  if (run.name === 'approve-no') {
    assert.equal(
      existsSync(pointer),
      false,
      'an ambiguous reply must not create the pointer',
    );
    assert.equal(existsSync(progress), false, 'no loop body without approval');
    assert.equal(
      rows.some((r) => /^unit-/.test(textAt(r, 'trigger'))),
      false,
      'no unit rows without approval: ' + JSON.stringify(rows),
    );
    const status = spawnSync('git', ['-C', run.root, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).stdout;
    assert.equal(
      status.trim(),
      '',
      'zone files changed without approval: ' + status,
    );
    // The reply carries a condition and a question, so the skill applies or
    // asks and reports again; the wording is the model's. The machine-checkable
    // facts are the absent pointer and the untouched zone above.
    return { outcome: 'approve-no-pass', rows, voice };
  }
  assert.equal(
    existsSync(pointer),
    true,
    'an explicit approval must create the pointer',
  );
  const p = parseJson(readFileSync(pointer, 'utf8'));
  assert.equal(at(p, 'v'), 1, 'pointer schema v1: ' + JSON.stringify(p));
  assert.equal(
    at(p, 'boundary'),
    APPROVE_CONTRACT,
    'pointer boundary: ' + JSON.stringify(p),
  );
  assert.equal(
    at(p, 'ratified_by'),
    'qa',
    'ratified_by from the contract approval line: ' + JSON.stringify(p),
  );
  assert.equal(
    at(p, 'ratified_at'),
    localToday(),
    'ratified_at = the day of the utterance: ' + JSON.stringify(p),
  );
  assert.ok(
    plan.includes(approveReply(run.name)),
    'the approval utterance must be quoted in the plan progress notes:\n' +
      plan,
  );
  assert.equal(existsSync(progress), true, 'unit init must seed the loop body');
  const pr = parseJson(readFileSync(progress, 'utf8'));
  assert.ok(
    at(pr, 'units') && at(pr, 'units', 'U1'),
    'progress.json carries U1: ' + JSON.stringify(pr),
  );
  assert.ok(
    rows.some((r) => at(r, 'trigger') === 'unit-init'),
    'unit-init row expected: ' + JSON.stringify(rows),
  );
  return {
    outcome: run.name + '-pass',
    rows,
    pointer: p,
    progress: pr,
    voice,
  };
}

// ---- audit scenario: the operator types /amber:audit in a
// contract-less zone. AMBER_HOME holds a copy of the audit fixture ledger
// (projects alpha, beta and self; a planted loss in session a1b2c3d4) and
// AMBER_TRANSCRIPTS a copy of its transcripts, so the skill's helper
// commands see synthetic data only. The model must write the report the
// skill prescribes, and the helper's check-summary must reproduce the
// report's block in the same environment.
const AUDIT_FIXTURE = join(REPO, 'test', 'fixtures', 'audit');
const AUDIT_LOSS_SESSION = host === 'codex' ? 'c0dec001' : 'a1b2c3d4';

function auditZone(): Fixture {
  const root = join(BASE, 'audit');
  const home = join(BASE, 'audit-amber-home');
  const transcripts = join(BASE, 'audit-transcripts');
  mkdirSync(join(root, 'docs'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [k, v] of [
    ['user.email', 'qa@local'],
    ['user.name', 'qa'],
  ]) {
    spawnSync('git', ['-C', root, 'config', k ?? '', v ?? '']);
  }
  writeFileSync(join(root, '.gitignore'), '.amber/\n');
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# QA zone\n\nAmber governs work requests in this zone.\n',
  );
  writeFileSync(join(root, 'docs', '.keep'), '');
  spawnSync('git', ['-C', root, 'add', '-A'], { encoding: 'utf8' });
  const commit = spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'init'], {
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, commit.stderr);
  mkdirSync(home, { recursive: true });
  const fixtureSource =
    host === 'codex' ? join(AUDIT_FIXTURE, 'codex') : AUDIT_FIXTURE;
  copyFileSync(join(fixtureSource, 'ledger.jsonl'), join(home, 'runs.jsonl'));
  cpSync(join(fixtureSource, 'transcripts'), transcripts, { recursive: true });
  return {
    root,
    home,
    transcripts,
    fixtureRows: ledger(home).length,
    name: 'audit',
    kind: 'audit',
  };
}

function auditEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return isolatedEnv(fixture, { AMBER_TRANSCRIPTS: fixture.transcripts });
}

function runAudit(fixture: Fixture): Run {
  // The prompt is exactly what the operator types: a slash command in -p
  // mode runs the skill (verified with /amber:status). Default
  // effort; the budget follows the 0.27 USD status probe with headroom.
  return runHost(fixture, host === 'codex' ? '$amber:audit' : '/amber:audit', {
    budget: 6,
    timeout: 600000,
    env: { AMBER_TRANSCRIPTS: fixture.transcripts },
  });
}

function markdownSection(text: string, title: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## ' + title);
  assert.notEqual(
    start,
    -1,
    'section "## ' + title + '" expected in the report:\n' + text,
  );
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end);
}

function assessAudit(run: Run): Record<string, unknown> {
  const rows = ledger(run.home);
  assert.equal(sensorFailures(run.home), '', 'sensor failure');
  assert.doesNotMatch(
    run.final,
    /AMBER_(REVIEW|GOAL|DONE):/,
    'no marker line in the final message',
  );
  // (1) exactly one report, numbered 1 in a zone without earlier audits.
  const auditsDir = join(run.root, 'docs', 'audits');
  const reports = existsSync(auditsDir)
    ? readdirSync(auditsDir).filter((n) => /-audit-1\.md$/.test(n))
    : [];
  assert.equal(
    reports.length,
    1,
    'exactly one docs/audits/*-audit-1.md expected: ' + JSON.stringify(reports),
  );
  const reportPath = join(auditsDir, reports[0] ?? '');
  const text = readFileSync(reportPath, 'utf8');
  // (2) the helper reproduces the report's block in the same environment.
  const check = spawnSync(
    process.execPath,
    [join(PLUGIN, 'scripts', 'audit.cjs'), 'check-summary', reportPath],
    { cwd: run.root, env: auditEnv(run), encoding: 'utf8' },
  );
  assert.equal(
    check.status,
    0,
    'check-summary must reproduce the block:\n' + check.stdout + check.stderr,
  );
  // (3) the candidate table carries the verdict column and every verdict cell is empty.
  const candidates = markdownSection(text, 'Candidates');
  const dataRows = candidateRows(candidates);
  // (4) the comparison section names the planted-loss session and its missing event.
  const comparison = markdownSection(text, 'Ledger versus transcripts').join(
    '\n',
  );
  assert.match(
    comparison,
    new RegExp(AUDIT_LOSS_SESSION),
    'the planted-loss session id expected in the comparison section',
  );
  assert.match(
    comparison,
    /missing=1/,
    'missing=1 expected in the comparison section',
  );
  // (5) the rows this run added to the fixture ledger.
  const fresh = rows.slice(run.fixtureRows);
  const typed = fresh.filter(
    (r) =>
      at(r, 'trigger') === 'skill-invocation' &&
      at(r, 'summary') === 'amber:audit (typed)',
  );
  assert.equal(
    typed.length,
    1,
    'one typed audit row expected: ' + JSON.stringify(fresh),
  );
  const skips = fresh.filter(
    (r) =>
      at(r, 'trigger') === 'skip' &&
      /^opening verdict/.test(textAt(r, 'summary')),
  );
  assert.ok(
    skips.length >= 1,
    'an opening-verdict skip row expected: ' + JSON.stringify(fresh),
  );
  const completions = fresh.filter(
    (r) =>
      at(r, 'trigger') === 'done-declaration' &&
      !at(r, 'contract') &&
      /^audit:/.test(textAt(r, 'summary')),
  );
  assert.equal(
    completions.length,
    1,
    'one no-contract completion with an audit: summary expected: ' +
      JSON.stringify(fresh),
  );
  assert.equal(at(completions[0], 'plugin_version'), DECLARED_VERSION);
  return {
    outcome: 'audit-pass',
    rows: fresh,
    report: reportPath,
    candidates: dataRows.length,
  };
}

const report: {
  host: Host;
  scenario: string;
  base: string;
  scenarios: Record<string, unknown>[];
} = { host, scenario, base: BASE, scenarios: [] };
if (['runtime', 'init', 'init-empty', 'status'].includes(scenario)) {
  report.scenarios.push(
    runtimeQA({
      host,
      scenario,
      BASE,
      activePlugin,
      runHost,
      ledger,
      sensorFailures,
      transcriptFiles,
    }),
  );
} else if (scenario === 'sessions') {
  const run = runSessions(sessionsZone());
  const result = assessSessions(run);
  report.scenarios.push({
    kind: 'sessions',
    session_id: run.sessionId,
    cost_usd: run.cost,
    turns: run.turns,
    outcome: result['outcome'],
    final: run.final,
    ledger: result['rows'],
    progress: result['progress'],
  });
} else if (scenario === 'approve') {
  for (const name of ['approve-no', 'approve-yes', 'approve-short']) {
    const run = runApprove(approveZone(name));
    const result = assessApprove(run);
    report.scenarios.push({
      kind: name,
      session_id: run.sessionId,
      cost_usd: run.cost,
      turns: run.turns,
      outcome: result['outcome'],
      voice: result['voice'],
      final: run.final,
      ledger: result['rows'],
      pointer: result['pointer'] || null,
      progress: result['progress'] || null,
    });
  }
} else if (scenario === 'audit') {
  const fixtureSource =
    host === 'codex' ? join(AUDIT_FIXTURE, 'codex') : AUDIT_FIXTURE;
  const fixture: Fixture = assessExisting
    ? {
        root: join(BASE, 'audit'),
        home: join(BASE, 'audit-amber-home'),
        transcripts: join(BASE, 'audit-transcripts'),
        fixtureRows: readFileSync(join(fixtureSource, 'ledger.jsonl'), 'utf8')
          .trim()
          .split('\n').length,
        name: 'audit',
        kind: 'audit',
      }
    : auditZone();
  const run = runAudit(fixture);
  const result = assessAudit(run);
  report.scenarios.push({
    kind: 'audit',
    reassessed: assessExisting,
    session_id: run.sessionId,
    cost_usd: run.cost,
    turns: run.turns,
    outcome: result['outcome'],
    final: run.final,
    ledger: result['rows'],
    report: result['report'],
    candidates: result['candidates'],
  });
} else if (scenario === 'planning') {
  const fixture: Fixture = assessExisting
    ? {
        root: join(BASE, 'planning'),
        home: join(BASE, 'planning-amber-home'),
        name: 'planning',
        kind: 'planning',
      }
    : planningZone();
  const run = runPlanning(fixture);
  const result = assessPlanning(run);
  report.scenarios.push({
    kind: 'planning',
    reassessed: assessExisting,
    session_id: run.sessionId,
    cost_usd: run.cost,
    outcome: result['outcome'],
    final: run.final,
    ledger: result['rows'],
    tension: result['tension'],
    owner_rows: result['owner'],
    tunable_rows: result['tunable'],
  });
} else if (scenario === 'loop') {
  const run = runLoop(loopZone());
  const result = assessLoop(run);
  report.scenarios.push({
    kind: 'loop',
    session_id: run.sessionId,
    cost_usd: run.cost,
    outcome: result['outcome'],
    final: run.final,
    ledger: result['rows'],
    continuations: result['continuations'],
    agents: result['agents'],
    denials: result['denials'],
    final_quotes_denial: result['finalQuotesDenial'],
  });
} else {
  for (const kind of ['missing', 'success', 'broken']) {
    const run = runModel(makeZone(kind, kind));
    const result = assess(run);
    report.scenarios.push({
      kind,
      session_id: run.sessionId,
      outcome: result['outcome'],
      final: run.final,
      ledger: result['rows'],
      checks: result['checks'] || [],
    });
  }
}
writeFileSync(
  join(BASE, 'report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
