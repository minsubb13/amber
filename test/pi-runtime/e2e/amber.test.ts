// The changes merged on 2026-10-21 (#23 to #27) run through the pi extension
// as they run through the Claude Code and Codex hooks: each test drives a real
// pi over RPC against a loopback model and reads what Amber wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { harness } from '../helpers/pi.ts';

const recorder = resolve('plugin/scripts/record.cjs');
const planningSkill = resolve('plugin/pi/skills/amber-planning/SKILL.md');
const INDEX = 'Completion index:';
const FULL = 'Pure Q&A, discussion, and status responses need no signal';

function git(dir: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** A git zone with one commit; harness files stay untracked. */
function zone(dir: string) {
  git(dir, 'init', '-q');
  // The harness keeps pi's and Amber's own files in the zone directory.
  writeFileSync(join(dir, '.git/info/exclude'), 'amber-home/\n');
  git(dir, 'config', 'user.email', 'fixture@example.com');
  git(dir, 'config', 'user.name', 'fixture');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'fixture');
}

function record(h: any, session: string, args: string[]) {
  const result = spawnSync(process.execPath, [recorder, ...args], {
    cwd: h.dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: h.dir,
      PI_CODING_AGENT_DIR: h.dir,
      AMBER_HOME: h.amberHome,
      PI_SESSION_ID: session,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** The newest hidden Amber briefing in the current session. */
async function lastBriefing(pi: any): Promise<string> {
  const entries = (await pi.command('get_entries')).entries;
  const amber = entries.filter(
    (e: any) => e.type === 'custom_message' && e.customType === 'amber',
  );
  assert.ok(amber.length > 0, 'no amber briefing in the session');
  const content = amber[amber.length - 1].content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function sessionState(h: any, session: string) {
  return JSON.parse(
    readFileSync(join(h.amberHome, 'state', `session-${session}.json`), 'utf8'),
  );
}

function ledger(h: any): any[] {
  const file = join(h.amberHome, 'runs.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const toolResults = (pi: any) =>
  pi.events.filter((e: any) => e.type === 'tool_execution_end');

test('#26 pi passes the session start source: index on startup and new, full on resume, fork and compact', async () => {
  const h = await harness({
    persist: true,
    // A compaction needs history older than the recent part it keeps.
    settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
  });
  try {
    zone(h.dir);
    const pi = await h.rpc();
    const first = await pi.command('get_state');

    await pi.prompt('startup');
    assert.match(await lastBriefing(pi), new RegExp(INDEX));
    assert.doesNotMatch(await lastBriefing(pi), new RegExp(FULL));

    await pi.command('new_session');
    await pi.prompt('after new');
    assert.match(await lastBriefing(pi), new RegExp(INDEX));

    await pi.command('switch_session', { sessionPath: first.sessionFile });
    await pi.prompt('after resume');
    assert.match(await lastBriefing(pi), new RegExp(FULL));

    const fork = (await pi.command('get_fork_messages')).messages;
    assert.ok(fork.length > 0);
    await pi.command('fork', { entryId: fork[fork.length - 1].entryId });
    const forked = await pi.command('get_state');
    assert.notEqual(forked.sessionId, first.sessionId);
    await pi.prompt('after fork');
    assert.match(await lastBriefing(pi), new RegExp(FULL));

    await pi.command('new_session');
    await pi.prompt('before compact');
    assert.match(await lastBriefing(pi), new RegExp(INDEX));
    await pi.command('compact');
    await pi.prompt('after compact');
    assert.match(await lastBriefing(pi), new RegExp(FULL));
    await pi.close();
  } finally {
    await h.close();
  }
});

test('#26 a pi launch that continues a saved session briefs the full procedure, like a resume', async () => {
  const h = await harness({ persist: true });
  try {
    zone(h.dir);
    const first = await h.rpc();
    const { sessionFile, sessionId } = await first.command('get_state');
    await first.prompt('before the restart');
    assert.match(await lastBriefing(first), new RegExp(INDEX));
    await first.close();

    const again = await h.rpc('anthropic', undefined, true, [
      '--session',
      sessionFile,
    ]);
    assert.equal((await again.command('get_state')).sessionId, sessionId);
    await again.prompt('after the restart');
    assert.match(await lastBriefing(again), new RegExp(FULL));
    await again.close();

    // A launch into a fresh session stays a startup.
    const fresh = await h.rpc();
    await fresh.prompt('fresh');
    assert.match(await lastBriefing(fresh), new RegExp(INDEX));
    await fresh.close();
  } finally {
    await h.close();
  }
});

test('#27 a planning read opens the phase gate on pi; the refusal names the pi recorder; mark skip closes it', async () => {
  const h = await harness({
    builtinTools: true,
    reply: (_p, _b, i) => {
      const steps = [
        { tool: { name: 'read', arguments: { path: planningSkill } } },
        {
          tool: {
            name: 'write',
            arguments: { path: 'src.txt', content: 'too early' },
          },
        },
        {
          tool: {
            name: 'write',
            arguments: { path: 'docs/x-contract.md', content: '# draft\n' },
          },
        },
        {
          tool: {
            name: 'bash',
            arguments: {
              command: `node ${recorder} mark skip 'opening verdict - no contract: fixture'`,
            },
          },
        },
        {
          tool: {
            name: 'edit',
            arguments: {
              path: 'README.md',
              edits: [{ oldText: '# fixture', newText: '# fixture edited' }],
            },
          },
        },
      ];
      return steps[i] ?? { text: 'done' };
    },
  });
  try {
    zone(h.dir);
    const pi = await h.rpc();
    const session = (await pi.command('get_state')).sessionId;
    await pi.prompt('open planning');
    const results = toolResults(pi);
    assert.equal(results.length, 5);
    assert.equal(results[0].isError, false);
    assert.equal(results[1].isError, true);
    const refusal = JSON.stringify(results[1]);
    assert.match(refusal, /planning phase open since/);
    assert.match(refusal, /on Codex and pi `node \S+record\.cjs mark skip/);
    assert.equal(existsSync(join(h.dir, 'src.txt')), false);
    assert.equal(results[2].isError, false);
    assert.ok(existsSync(join(h.dir, 'docs/x-contract.md')));
    assert.equal(results[3].isError, false, JSON.stringify(results[3]));
    assert.equal(results[4].isError, false, JSON.stringify(results[4]));
    assert.match(readFileSync(join(h.dir, 'README.md'), 'utf8'), /edited/);
    assert.equal(sessionState(h, session).phase, undefined);
    const exits = ledger(h).filter((r) => r.trigger === 'phase-exit');
    assert.equal(exits.length, 1);
    assert.equal(exits[0].exit, 'skip');
    assert.equal(exits[0].session_id, session);
    await pi.close();
  } finally {
    await h.close();
  }
});

/** A contract with a completion section, activated by the recorder. */
function activeContract(h: any, session: string) {
  zone(h.dir);
  writeFileSync(
    join(h.dir, 'boundary.md'),
    '# Fixture\n\n## Completion conditions\n\n1. fixture condition holds\n\n## Forbidden rows\n\n- scope [machine: write-scope allowed/**]\n',
  );
  writeFileSync(
    join(h.dir, 'plan.md'),
    '## Work units\n\n- [ ] U1 first [unit: U1 scope=allowed/** oracle=true]\n- [ ] U2 second [unit: U2 scope=allowed/** after=U1 oracle=true]\n\n## Progress log\n',
  );
  git(h.dir, 'add', 'boundary.md', 'plan.md');
  git(h.dir, 'commit', '-q', '-m', 'contract');
  record(h, session, [
    'activate',
    'boundary.md',
    '--by',
    'fixture',
    '--at',
    '2026-10-21',
  ]);
}

test('#23 on pi, only a recorder command at command position registers the session as a driver', async () => {
  const replies = [
    `echo 'node ${recorder} unit start U1'`,
    `grep -c 'record.cjs unit verified' plan.md || true`,
    null,
    `node ${recorder} unit start U1`,
    `node ${recorder} unit hold U1 --reason 'external: fixture'`,
  ];
  const h = await harness({
    builtinTools: true,
    reply: (_p, _b, i) => {
      const command = replies[i];
      return command
        ? { tool: { name: 'bash', arguments: { command } } }
        : { text: 'done' };
    },
  });
  try {
    activeContract(h, 'fixture-operator');
    record(h, 'fixture-operator', ['unit', 'init', 'plan.md']);
    const pi = await h.rpc();
    const session = (await pi.command('get_state')).sessionId;
    await pi.prompt('mention the recorder');
    assert.equal(toolResults(pi).length, 2);
    assert.equal(sessionState(h, session).run, undefined);
    let progress = JSON.parse(
      readFileSync(join(h.dir, '.amber/progress.json'), 'utf8'),
    );
    assert.ok(!(progress.session_ids ?? []).includes(session));
    await pi.prompt('drive the run');
    assert.equal(sessionState(h, session).run, 'boundary.md');
    progress = JSON.parse(
      readFileSync(join(h.dir, '.amber/progress.json'), 'utf8'),
    );
    assert.ok(progress.session_ids.includes(session));
    await pi.close();
  } finally {
    await h.close();
  }
});

test('#24 on pi, the recorder activates a contract with a content baseline', async () => {
  const h = await harness({
    builtinTools: true,
    reply: (_p, _b, i) =>
      i === 0
        ? {
            tool: {
              name: 'bash',
              arguments: {
                command: `node ${recorder} activate boundary.md --by fixture --at 2026-10-21`,
              },
            },
          }
        : { text: 'done' },
  });
  try {
    zone(h.dir);
    writeFileSync(
      join(h.dir, 'boundary.md'),
      '# Fixture\n\n- scope [machine: write-scope allowed/**]\n',
    );
    writeFileSync(join(h.dir, 'README.md'), '# dirty before the run\n');
    const pi = await h.rpc();
    await pi.prompt('approve');
    assert.equal(toolResults(pi)[0].isError, false);
    const pointer = JSON.parse(
      readFileSync(join(h.dir, '.amber/active.json'), 'utf8'),
    );
    assert.equal(pointer.boundary, 'boundary.md');
    assert.equal(pointer.ratified_by, 'fixture');
    assert.equal(
      pointer.baseline.commit,
      git(h.dir, 'rev-parse', 'HEAD').trim(),
    );
    assert.match(pointer.baseline.manifest['README.md'], /^[0-9a-f]{40}$/);
    assert.match(pointer.baseline.contract_blob, /^[0-9a-f]{40}$/);
    await pi.close();
  } finally {
    await h.close();
  }
});

test('#25 a pi session opens with the completion conditions and the verified units', async () => {
  const h = await harness({});
  try {
    activeContract(h, 'fixture-operator');
    record(h, 'fixture-operator', ['unit', 'init', 'plan.md']);
    record(h, 'fixture-operator', ['unit', 'start', 'U1']);
    mkdirSync(join(h.dir, 'allowed'));
    writeFileSync(join(h.dir, 'allowed/a.txt'), 'work\n');
    record(h, 'fixture-operator', [
      'unit',
      'verified',
      'U1',
      '--evidence',
      'fixture oracle passed',
    ]);
    const pi = await h.rpc();
    await pi.prompt('continue');
    const briefing = await lastBriefing(pi);
    assert.match(briefing, /fixture condition holds/);
    assert.match(briefing, /verified so far:/);
    assert.match(
      briefing,
      /U1[^\n]*allowed\/a\.txt[^\n]*fixture oracle passed/,
    );
    await pi.close();
  } finally {
    await h.close();
  }
});
