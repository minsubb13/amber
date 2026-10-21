import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, targets } from '../helpers/pi.ts';

for (const [from, to] of [
  ['anthropic', 'openai'],
  ['openai', 'anthropic'],
]) {
  test(`switch_model ${from} -> ${to}: pickup, session entry, thinking and unchanged defaults`, async () => {
    const target = `${to}/${targets[to as keyof typeof targets]}`;
    const h = await harness({
      persist: true,
      settings: {
        defaultProvider: from,
        defaultModel: targets[from as keyof typeof targets],
      },
      extensions: ['src/switch-model.ts'],
      reply: (_p, _b, i) =>
        i === 0
          ? {
              tool: {
                name: 'switch_model',
                arguments: { model: target, thinking: 'high' },
              },
            }
          : {},
    });
    try {
      const settings = readFileSync(join(h.dir, 'settings.json'), 'utf8');
      const pi = await h.rpc(from);
      await pi.prompt();
      assert.deepEqual(
        h.requests.map((r) => r.provider),
        [from, to],
      );
      assert.equal(
        h.requests[1].payload.model,
        targets[to as keyof typeof targets],
      );
      const state = await pi.command('get_state');
      assert.equal(state.model.provider, to);
      assert.equal(state.thinkingLevel, 'high');
      const entries = (await pi.command('get_entries')).entries;
      assert.ok(
        entries.some(
          (e: any) =>
            e.type === 'model_change' &&
            e.provider === to &&
            e.modelId === targets[to as keyof typeof targets],
        ),
      );
      assert.ok(
        entries.some(
          (e: any) =>
            e.type === 'thinking_level_change' && e.thinkingLevel === 'high',
        ),
      );
      const result = pi.events.find((e) => e.type === 'tool_execution_end');
      assert.equal(result.isError, false);
      assert.match(JSON.stringify(result.result), /has taken over/);
      assert.match(
        JSON.stringify(await pi.command('get_messages')),
        new RegExp(`Answer from ${to}`),
      );
      assert.ok(
        !pi.events.some(
          (e) =>
            e.type === 'extension_ui_request' &&
            ['confirm', 'select'].includes(e.method),
        ),
      );
      await pi.close();
      assert.equal(
        readFileSync(join(h.dir, 'settings.json'), 'utf8'),
        settings,
      );
      const fresh = await h.rpc(from, undefined, false);
      assert.equal((await fresh.command('get_state')).model.provider, from);
      await fresh.close();
    } finally {
      await h.close();
    }
  });
}

for (const failure of [
  'allowlist',
  'missing credentials',
  'invalid thinking',
]) {
  test(`switch_model refuses ${failure} without model/thinking/session changes`, async () => {
    const args =
      failure === 'allowlist'
        ? { model: 'openai/not-allowed', thinking: 'high' }
        : {
            model: 'openai/gpt-6.1-sol',
            thinking: failure === 'invalid thinking' ? 'bogus' : 'high',
          };
    const h = await harness({
      extensions: ['src/switch-model.ts'],
      missing: failure === 'missing credentials' ? ['openai'] : [],
      reply: (_p, _b, i) =>
        i === 0 ? { tool: { name: 'switch_model', arguments: args } } : {},
    });
    try {
      const pi = await h.rpc();
      const before = await pi.command('get_state');
      const originalEntries = (await pi.command('get_entries')).entries;
      await pi.prompt();
      const state = await pi.command('get_state');
      assert.equal(state.model.provider, before.model.provider);
      assert.equal(state.thinkingLevel, before.thinkingLevel);
      assert.deepEqual(
        h.requests.map((r) => r.provider),
        ['anthropic', 'anthropic'],
      );
      const results = pi.events.filter((e) => e.type === 'tool_execution_end');
      assert.equal(results.length, 1);
      assert.equal(results[0].isError, true);
      if (failure === 'missing credentials')
        assert.match(
          JSON.stringify(results[0].result),
          /No usable credentials/,
        );
      else
        assert.match(
          JSON.stringify(results[0].result),
          /valid|schema|allowlist/i,
        );
      const switches = (entries: any[]) =>
        entries.filter((e) =>
          ['model_change', 'thinking_level_change'].includes(e.type),
        );
      assert.deepEqual(
        switches((await pi.command('get_entries')).entries),
        switches(originalEntries),
      );
      await pi.close();
    } finally {
      await h.close();
    }
  });
}

test('scope oracle negative control: persisted-default mutation is detected and affects unforced startup', async () => {
  const h = await harness({
    settings: { defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5' },
  });
  try {
    const path = join(h.dir, 'settings.json');
    const before = readFileSync(path, 'utf8');
    // Deliberately simulate the forbidden persistence effect in the isolated fixture.
    writeFileSync(
      path,
      JSON.stringify({
        ...JSON.parse(before),
        defaultProvider: 'openai',
        defaultModel: 'gpt-6.1-sol',
      }),
    );
    assert.notEqual(
      readFileSync(path, 'utf8'),
      before,
      'the settings-equality oracle detects a persisted default',
    );
    const pi = await h.rpc('anthropic', [], false);
    assert.equal(
      (await pi.command('get_state')).model.provider,
      'openai',
      'unforced startup detects changed defaults',
    );
    await pi.close();
  } finally {
    await h.close();
  }
});

test('omitted thinking uses pi per-model default', async () => {
  const h = await harness({
    settings: { modelThinkingLevels: { 'openai/gpt-6.1-sol': 'high' } },
    extensions: ['src/switch-model.ts'],
    reply: (_p, _b, i) =>
      i === 0
        ? {
            tool: {
              name: 'switch_model',
              arguments: { model: 'openai/gpt-6.1-sol' },
            },
          }
        : {},
  });
  try {
    const pi = await h.rpc();
    await pi.prompt();
    assert.equal(
      pi.events.find((e) => e.type === 'tool_execution_end').isError,
      false,
    );
    assert.equal((await pi.command('get_state')).model.provider, 'openai');
    assert.equal((await pi.command('get_state')).thinkingLevel, 'high');
    await pi.close();
  } finally {
    await h.close();
  }
});
