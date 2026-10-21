import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { harness, targets } from '../helpers/pi.ts';

const amber = resolve('plugin/pi/index.ts');
const recorder = resolve('plugin/scripts/record.cjs');
const runtimeStatus = (pi: any) =>
  pi.events.filter(
    (e: any) => e.method === 'setStatus' && e.statusKey === 'model-tools-fast',
  );
const notices = (pi: any) =>
  pi.events
    .filter((e: any) => e.method === 'notify')
    .map((e: any) => e.message);

function contract(dir: string) {
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  mkdirSync(join(dir, '.amber'));
  writeFileSync(
    join(dir, 'boundary.md'),
    '# Fixture\n- [machine: write-scope allowed/**]\n',
  );
  writeFileSync(
    join(dir, 'plan.md'),
    '- [ ] U1 incomplete [unit: U1 scope=allowed/** oracle=fixture]\n',
  );
  writeFileSync(
    join(dir, '.amber/active.json'),
    JSON.stringify({
      v: 1,
      boundary: 'boundary.md',
      ratified_by: 'fixture',
      ratified_at: '2026-10-21',
    }),
  );
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
}

for (const enabled of [false, true]) {
  test(`prompt-free startup flag ${enabled}: registration and payload gating`, async () => {
    const h = await harness({
      runtime: enabled,
      reply: () => ({ tier: 'default' }),
    });
    try {
      const pi = await h.rpc('openai');
      assert.equal(h.requests.length, 0);
      const commands = (await pi.command('get_commands')).commands;
      assert.equal(
        commands.some((c: any) => c.name === 'fast'),
        enabled,
      );
      assert.equal(runtimeStatus(pi).length > 0, enabled);
      await pi.prompt();
      assert.equal(
        (h.requests[0].payload.tools ?? []).some(
          (t: any) => t.name === 'switch_model',
        ),
        enabled,
      );
      assert.equal(
        h.requests[0].payload.service_tier,
        enabled ? 'priority' : undefined,
      );
      assert.equal(
        notices(pi).some((s: string) => s.includes('not priority')),
        enabled,
      );
      await pi.close();
    } finally {
      await h.close();
    }
  });
}

test('flag off leaves service-tier errors to pi: no fallback or notifications', async () => {
  const h = await harness({
    runtime: false,
    reply: () => ({
      error: { status: 400, message: 'Unsupported service_tier' },
    }),
  });
  try {
    const pi = await h.rpc('openai');
    await pi.prompt();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].payload.service_tier, undefined);
    assert.deepEqual(notices(pi), []);
    assert.deepEqual(runtimeStatus(pi), []);
    await pi.close();
  } finally {
    await h.close();
  }
});

for (const conflict of ['tool', 'command']) {
  for (const order of ['before', 'after']) {
    test(`standalone ${conflict} ${order} Amber: refuse runtime without overriding`, async () => {
      const h = await harness();
      try {
        const fixture = join(h.dir, 'standalone.ts');
        writeFileSync(
          fixture,
          conflict === 'tool'
            ? `import { Type } from '@earendil-works/pi-ai'; export default pi => pi.registerTool({name:'switch_model',label:'standalone',description:'standalone sentinel',parameters:Type.Object({}),async execute(){return {content:[{type:'text',text:'standalone'}],details:{}}}});`
            : `export default pi => pi.registerCommand('fast',{description:'standalone sentinel',handler:async(_args,ctx)=>ctx.ui.notify('standalone sentinel','info')});`,
        );
        const pi = await h.rpc(
          'openai',
          order === 'before' ? [fixture, amber] : [amber, fixture],
        );
        assert.equal(
          notices(pi).filter((s: string) =>
            s.includes('Amber runtime disabled'),
          ).length,
          1,
        );
        assert.deepEqual(runtimeStatus(pi), []);
        const commands = (await pi.command('get_commands')).commands;
        assert.equal(
          commands.filter((c: any) => c.name === 'fast').length,
          conflict === 'command' ? 1 : 0,
        );
        if (conflict === 'command') {
          await pi.prompt('/fast');
          assert.equal(notices(pi).at(-1), 'standalone sentinel');
        }
        await pi.prompt();
        assert.equal(h.requests[0].payload.service_tier, undefined);
        const tools = h.requests[0].payload.tools ?? [];
        assert.equal(
          tools.some((t: any) => t.name === 'switch_model'),
          conflict === 'tool',
        );
        if (conflict === 'tool')
          assert.equal(
            tools.find((t: any) => t.name === 'switch_model').description,
            'standalone sentinel',
          );
        await pi.close();
      } finally {
        await h.close();
      }
    });
  }
}

for (const [from, to] of [
  ['anthropic', 'openai'],
  ['openai', 'anthropic'],
]) {
  test(`mid-run ${from} -> ${to}: next-request pickup, attribution and E1 refusal`, async () => {
    const h = await harness({
      builtinTools: true,
      reply: (_p, _b, i) =>
        i === 0
          ? {
              tool: {
                name: 'switch_model',
                arguments: {
                  model: `${to}/${targets[to as keyof typeof targets]}`,
                },
              },
            }
          : i === 1
            ? {
                tool: {
                  name: 'write',
                  arguments: {
                    path: 'forbidden.txt',
                    content: 'must not exist',
                  },
                },
              }
            : {},
    });
    try {
      contract(h.dir);
      const pi = await h.rpc(from);
      await pi.prompt();
      assert.deepEqual(
        h.requests.map((r) => r.provider),
        [from, to, to],
      );
      assert.equal(existsSync(join(h.dir, 'forbidden.txt')), false);
      const results = pi.events.filter((e) => e.type === 'tool_execution_end');
      assert.equal(results[0].isError, false);
      assert.equal(results[1].isError, true);
      assert.match(JSON.stringify(results[1]), /scope|blocked|contract/i);
      const states = readdirSync(join(h.amberHome, 'state'))
        .filter((n) => n.startsWith('session-'))
        .map((n) =>
          JSON.parse(readFileSync(join(h.amberHome, 'state', n), 'utf8')),
        );
      assert.ok(
        states.some((s) => s.model === targets[to as keyof typeof targets]),
      );
      assert.ok(existsSync(join(h.dir, '.amber/active.json')));
      await pi.close();
    } finally {
      await h.close();
    }
  });
}

for (const native of [false, true]) {
  test(`tier recovery plus S2 refuses completion of open work (native retry=${native})`, async () => {
    let session: string;
    const h = await harness({
      builtinTools: true,
      settings: { retry: { enabled: native, maxRetries: 1, baseDelayMs: 1 } },
      reply: (_p, _b, i) => {
        if (i === 0)
          return {
            error: {
              status: 400,
              message: native
                ? 'Unsupported value: please retry your request'
                : 'Unsupported value',
              param: 'service_tier',
            },
          };
        if (i === 1)
          return {
            tool: {
              name: 'bash',
              arguments: {
                command: `node ${recorder} done --review 'fixture review' --goal 'fixture goal' --summary 'premature completion'`,
              },
            },
          };
        if (i === 3)
          record(h, session, [
            'unit',
            'hold',
            'U1',
            '--reason',
            'external: fixture stops after observed rejection',
          ]);
        if (i > 3) throw new Error('duplicate continuation');
        return { text: 'fixture answer; work is still incomplete' };
      },
    });
    try {
      contract(h.dir);
      const pi = await h.rpc('openai');
      session = (await pi.command('get_state')).sessionId;
      assert.ok(session);
      record(h, session, ['unit', 'init', 'plan.md']);
      record(h, session, ['unit', 'start', 'U1']);
      await pi.prompt();
      assert.deepEqual(
        h.requests.map((r) => r.payload.service_tier),
        ['priority', undefined, undefined, undefined],
      );
      assert.equal(
        pi.events.filter((e) => e.type === 'auto_retry_start').length,
        native ? 1 : 0,
      );
      const entries = (await pi.command('get_entries')).entries;
      assert.equal(
        entries.filter((e: any) => e.customType === 'model-tools-fast-retry')
          .length,
        native ? 0 : 1,
      );
      assert.ok(
        entries.some(
          (e: any) =>
            e.customType === 'amber' &&
            /open|unit|incomplete|verified/i.test(JSON.stringify(e)),
        ),
      );
      assert.ok(existsSync(join(h.dir, '.amber/active.json')));
      const progress = JSON.parse(
        readFileSync(join(h.dir, '.amber/progress.json'), 'utf8'),
      );
      assert.notEqual(progress.units.U1.status, 'verified');
      assert.equal(
        notices(pi).filter((s: string) => s.includes('continuing once')).length,
        1,
      );
      await pi.close();
    } finally {
      await h.close();
    }
  });
}
