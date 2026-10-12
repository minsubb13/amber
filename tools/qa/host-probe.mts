// Real Codex hook probe. Artifacts stay in a temporary, isolated git zone.
//
// Usage, after `npm run build:tools`: node build/tools/qa/host-probe.mjs

import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { at, parseJson } from '../shared/json.mjs';
import { pluginDir } from '../shared/paths.mjs';

const base = mkdtempSync(join(tmpdir(), 'amber-host-probe-'));
const root = join(base, 'zone');
const plugin = pluginDir();
const recorder = join(plugin, 'scripts', 'record.cjs');
const amberHome = join(base, 'amber-home');
mkdirSync(root);
function run(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  assert.equal(
    result.status,
    0,
    String(result.stderr || result.stdout || String(result.error)),
  );
  return String(result.stdout);
}
run('git', ['init', '-q']);
writeFileSync(
  join(root, 'AGENTS.md'),
  'This is an isolated hook observation fixture with an approved contract. Follow the explicit probe instructions.\n',
);
writeFileSync(join(root, '.gitignore'), '.amber/\n.claude/worktrees/\n');
writeFileSync(
  join(root, 'boundary.md'),
  '# Hook probe contract\n- files [machine: write-scope src/**]\n- no forbidden command [machine: bash-deny AMBER_PROBE_FORBIDDEN]\n',
);
writeFileSync(
  join(root, 'plan.md'),
  '## Work units\n- [ ] U1 child [unit: U1 scope=src/child.txt oracle=test -f src/child.txt]\n- [ ] U2 parent [unit: U2 scope=src/parent.txt oracle=test -f src/parent.txt]\n',
);
mkdirSync(join(root, 'src'));
writeFileSync(join(root, 'src', '.keep'), '');
run('git', ['add', '.']);
run('git', [
  '-c',
  'user.name=qa',
  '-c',
  'user.email=qa@example.invalid',
  'commit',
  '-qm',
  'fixture',
]);
mkdirSync(join(root, '.amber'));
writeFileSync(
  join(root, '.amber', 'active.json'),
  JSON.stringify({
    v: 1,
    boundary: 'boundary.md',
    ratified_by: 'qa',
    ratified_at: '2026-09-21',
  }),
);
const childRoot = join(root, '.claude', 'worktrees', 'child');
run('git', ['worktree', 'add', '-qb', 'probe-child', childRoot]);
const env: NodeJS.ProcessEnv = { ...process.env, AMBER_HOME: amberHome };
for (const key of [
  'CODEX_THREAD_ID',
  'AMBER_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
]) {
  Reflect.deleteProperty(env, key);
}
run('node', [recorder, 'unit', 'init', 'plan.md'], { env });
const capture = join(base, 'capture.cjs');
writeFileSync(
  capture,
  `const fs = require('fs');
const {spawnSync} = require('child_process');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(join(base, 'hooks.jsonl'))}, JSON.stringify({input, thread:process.env.CODEX_THREAD_ID || null})+'\\n');
if(input.hook_event_name==='PreToolUse' && ['Bash','apply_patch'].includes(input.tool_name)) {
 const r=spawnSync('node',[${JSON.stringify(join(plugin, 'hooks', 'amber-hook.cjs'))},'E1'],{input:JSON.stringify(input),encoding:'utf8',env:process.env});
 if(r.stdout) {fs.appendFileSync(${JSON.stringify(join(base, 'decisions.jsonl'))},JSON.stringify({input,output:JSON.parse(r.stdout)})+'\\n');process.stdout.write(r.stdout);}
}
`,
);
const hook = `{hooks=[{type="command",command=${JSON.stringify('node ' + capture)}}]}`;
const config =
  'hooks={' +
  [
    'SessionStart',
    'SubagentStart',
    'PreToolUse',
    'PostToolUse',
    'SubagentStop',
    'Stop',
  ]
    .map((event) => event + '=[' + hook + ']')
    .join(',') +
  '}';
const prompt = [
  'This is an authorized bounded host probe under the already approved fixture contract, not product work. Do not open a new cycle.',
  'Run a shell command printing CODEX_THREAD_ID and pwd. Then spawn exactly one child agent, ownership U1, worktree ' +
    childRoot +
    '.',
  'Tell that child: you are not alone in the repo. Do not revert others. First run node ' +
    recorder +
    ' unit claim U1 with shell workdir ' +
    childRoot +
    '. Then print CODEX_THREAD_ID and pwd from that workdir.',
  'Tell the child: deliberately attempt ONE apply_patch adding ' +
    childRoot +
    '/src/parent.txt with wrong. This is outside your unit; expect a hook denial and report it. Then use apply_patch to add ' +
    childRoot +
    '/src/child.txt containing child. Do not bypass a denied patch using shell writes. If the own-unit patch is also denied, report it and stop. Do not run done.',
  'Wait for the child. Then use apply_patch to add ' +
    root +
    '/src/parent.txt containing parent and finish with a status report. Do not merge or delete the worktree; the probe runner inspects it. Do not use a completion signal.',
].join('\n');
console.log('probe artifacts: ' + base);
const result = spawnSync(
  'codex',
  [
    'exec',
    '--json',
    '--color',
    'never',
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '-C',
    root,
    '-c',
    'plugins={"amber@personal"={enabled=false}}',
    '-c',
    config,
    '-c',
    'model_reasoning_effort="low"',
    prompt,
  ],
  {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 20 * 1024 * 1024,
  },
);
writeFileSync(join(base, 'stdout.jsonl'), result.stdout || '');
writeFileSync(join(base, 'stderr.txt'), result.stderr || '');
assert.equal(
  result.status,
  0,
  result.stderr || (result.error === undefined ? '' : String(result.error)),
);
const rows = readFileSync(join(base, 'hooks.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => parseJson(line));
const tools = rows.filter(
  (r) => at(r, 'input', 'hook_event_name') === 'PreToolUse',
);
const identity = tools.map((r) => ({
  tool: at(r, 'input', 'tool_name'),
  session: at(r, 'input', 'session_id'),
  agent: at(r, 'input', 'agent_id'),
  cwd: at(r, 'input', 'cwd'),
}));
writeFileSync(
  join(base, 'identity.json'),
  JSON.stringify(identity, null, 2) + '\n',
);
assert.ok(
  existsSync(join(childRoot, 'src', 'child.txt')),
  'child patch absent',
);
assert.ok(
  !existsSync(join(childRoot, 'src', 'parent.txt')),
  'cross-unit patch executed',
);
assert.ok(existsSync(join(root, 'src', 'parent.txt')), 'parent patch absent');
assert.ok(
  rows.some((r) => at(r, 'input', 'hook_event_name') === 'SubagentStart'),
  'no child hook',
);
const decisions = readFileSync(join(base, 'decisions.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => parseJson(line));
assert.ok(
  decisions.some((d) =>
    /blocked by unit U1/.test(JSON.stringify(at(d, 'output'))),
  ),
  'no unit-specific denial',
);
const progress = parseJson(
  readFileSync(join(root, '.amber', 'progress.json'), 'utf8'),
);
assert.ok(at(progress, 'units', 'U1', 'agent_id'), 'claim missing');
const childShell = rows.find((r) => {
  const agent = at(r, 'input', 'agent_id');
  return (
    at(r, 'input', 'hook_event_name') === 'PostToolUse' &&
    at(r, 'input', 'tool_name') === 'Bash' &&
    Boolean(agent) &&
    String(at(r, 'input', 'tool_response')).includes(String(agent))
  );
});
assert.ok(
  childShell,
  'child shell must expose the hook agent id as CODEX_THREAD_ID',
);
assert.notEqual(
  at(childShell, 'input', 'agent_id'),
  at(childShell, 'input', 'session_id'),
);
assert.ok(
  tools.some(
    (r) =>
      Boolean(at(r, 'input', 'agent_id')) &&
      at(r, 'input', 'tool_name') === 'apply_patch' &&
      at(r, 'input', 'cwd') === root,
  ),
  'absolute child patch with inherited cwd not observed',
);
console.log(
  'PASS real child identity, worktree claim, own patch and cross-unit denial',
);
