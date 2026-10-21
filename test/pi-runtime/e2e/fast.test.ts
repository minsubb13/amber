import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../helpers/pi.ts';

const notices = (pi: any) =>
  pi.events
    .filter(
      (e: any) => e.type === 'extension_ui_request' && e.method === 'notify',
    )
    .map((e: any) => e.message);
const statuses = (pi: any) =>
  pi.events.filter(
    (e: any) =>
      e.type === 'extension_ui_request' &&
      e.method === 'setStatus' &&
      e.statusKey === 'model-tools-fast',
  );

test('fast defaults on, OpenAI only, toggles/report/invalid args, new process resets', async () => {
  const h = await harness({ extensions: ['src/fast.ts'] });
  try {
    const originalSettings = readFileSync(join(h.dir, 'settings.json'), 'utf8');
    const pi = await h.rpc('openai');
    assert.equal(statuses(pi).at(-1).statusText, 'fast');
    await pi.prompt();
    await pi.prompt('/fast');
    assert.match(notices(pi).at(-1), /fast on/);
    await pi.prompt('/fast off');
    assert.equal(statuses(pi).at(-1).statusText, undefined);
    await pi.prompt();
    await pi.prompt('/fast on');
    assert.equal(statuses(pi).at(-1).statusText, 'fast');
    await pi.prompt('/fast invalid');
    assert.match(notices(pi).at(-1), /Usage:/);
    await pi.prompt();
    await pi.command('set_model', {
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
    });
    await pi.prompt();
    assert.deepEqual(
      h.requests.map((r) => r.payload.service_tier),
      ['priority', undefined, 'priority', undefined],
    );
    assert.deepEqual(
      h.requests.map((r) => r.provider),
      ['openai', 'openai', 'openai', 'anthropic'],
    );
    await pi.prompt('/fast off');
    await pi.close();
    const fresh = await h.rpc('openai');
    await fresh.prompt();
    assert.equal(h.requests.at(-1)!.payload.service_tier, 'priority');
    await fresh.close();
    assert.equal(
      readFileSync(join(h.dir, 'settings.json'), 'utf8'),
      originalSettings,
    );
  } finally {
    await h.close();
  }
});

for (const tier of ['default', 'auto', 'priority', 'unknown']) {
  test(`completed tier=${tier}: notice only when downgraded, once per process`, async () => {
    const h = await harness({
      extensions: ['src/fast.ts'],
      reply: () => ({
        tier,
        createdTier: 'auto',
        omitTier: tier === 'unknown',
      }),
    });
    try {
      const pi = await h.rpc('openai');
      await pi.prompt();
      await pi.prompt();
      assert.equal(
        notices(pi).filter((n: string) => n.includes('not priority')).length,
        tier === 'priority' ? 0 : 1,
      );
      if (tier !== 'priority')
        assert.match(notices(pi)[0], new RegExp(`service_tier=${tier}`));
      assert.ok(h.requests.every((r) => r.payload.service_tier === 'priority'));
      await pi.close();
    } finally {
      await h.close();
    }
  });
}

for (const failAgain of [false, true]) {
  test(`tier rejection: one default-tier continuation; second attempt ${failAgain ? 'fails without loop' : 'succeeds'}`, async () => {
    const h = await harness({
      extensions: ['src/fast.ts'],
      reply: (_p, _b, i) =>
        i === 0 || (failAgain && i === 1)
          ? {
              error: {
                status: 400,
                message: 'Unsupported service_tier: priority',
              },
            }
          : {},
    });
    try {
      const pi = await h.rpc('openai');
      await pi.prompt('Answer my original question');
      assert.equal(h.requests.length, 2);
      assert.deepEqual(
        h.requests.map((r) => r.payload.service_tier),
        ['priority', undefined],
      );
      assert.match(
        JSON.stringify(h.requests[1].payload),
        /Answer my original question/,
      );
      assert.equal(
        notices(pi).filter((n: string) => n.includes('continuing once')).length,
        1,
      );
      assert.equal(statuses(pi).at(-1).statusText, undefined);
      const messages = (await pi.command('get_messages')).messages;
      assert.equal(
        messages.filter((m: any) => m.role === 'assistant').at(-1).stopReason,
        failAgain ? 'error' : 'stop',
      );
      await pi.prompt('/fast');
      assert.match(notices(pi).at(-1), /fast off/);
      await pi.prompt();
      assert.equal(h.requests.length, 3);
      assert.equal(h.requests[2].payload.service_tier, undefined);
      await pi.close();
    } finally {
      await h.close();
    }
  });
}

for (const [provider, status, message] of [
  ['openai', 400, 'Invalid reasoning.effort'],
  ['openai', 403, 'Forbidden service_tier'],
  ['openai', 500, 'server failed; service_tier unsupported 400'],
  ['anthropic', 400, 'Unsupported service_tier'],
] as const) {
  test(`unrelated error untouched: ${provider} ${status} ${message}`, async () => {
    const h = await harness({
      extensions: ['src/fast.ts'],
      reply: () => ({ error: { status, message } }),
    });
    try {
      const pi = await h.rpc(provider);
      await pi.prompt();
      assert.equal(h.requests.length, 1);
      assert.equal(notices(pi).length, 0);
      assert.equal(statuses(pi).at(-1).statusText, 'fast');
      const assistants = (await pi.command('get_messages')).messages.filter(
        (m: any) => m.role === 'assistant',
      );
      assert.equal(assistants.at(-1).stopReason, 'error');
      assert.ok(assistants.at(-1).errorMessage.includes(message));
      await pi.close();
    } finally {
      await h.close();
    }
  });
}

test('realistic tier error with param only: default-tier fallback with native retries enabled', async () => {
  const h = await harness({
    extensions: ['src/fast.ts'],
    settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
    reply: (_p, _b, i) =>
      i === 0
        ? {
            error: {
              status: 400,
              message:
                "Unsupported value: 'priority' is not supported with this model.",
              param: 'service_tier',
              code: 'unsupported_value',
            },
          }
        : {},
  });
  try {
    const pi = await h.rpc('openai');
    await pi.prompt();
    assert.deepEqual(
      h.requests.map((r) => r.payload.service_tier),
      ['priority', undefined],
    );
    assert.equal(
      notices(pi).filter((n: string) => n.includes('continuing once')).length,
      1,
    );
    assert.equal(
      pi.events.filter((e) => e.type === 'auto_retry_start').length,
      0,
    );
    assert.match(
      JSON.stringify(await pi.command('get_messages')),
      /Answer from openai/,
    );
    await pi.close();
  } finally {
    await h.close();
  }
});

for (const failAgain of [false, true]) {
  test(`native retry consumes tier recovery without a duplicate; next request ${failAgain ? 'fails' : 'succeeds'}`, async () => {
    const h = await harness({
      extensions: ['src/fast.ts'],
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
      reply: (_p, _b, i) =>
        i === 0
          ? {
              error: {
                status: 400,
                message: 'Unsupported value: please retry your request',
                param: 'service_tier',
                code: 'unsupported_value',
              },
            }
          : failAgain
            ? { error: { status: 400, message: 'Invalid reasoning.effort' } }
            : {},
    });
    try {
      const pi = await h.rpc('openai');
      await pi.prompt();
      assert.deepEqual(
        h.requests.map((r) => r.payload.service_tier),
        ['priority', undefined],
      );
      assert.equal(
        pi.events.filter((e) => e.type === 'auto_retry_start').length,
        1,
      );
      assert.equal(
        notices(pi).filter((n: string) => n.includes('continuing once')).length,
        1,
      );
      assert.ok(
        !(await pi.command('get_entries')).entries.some(
          (e: any) => e.customType === 'model-tools-fast-retry',
        ),
      );
      await pi.close();
    } finally {
      await h.close();
    }
  });
}

test('fast follows mid-run switch in both directions', async () => {
  for (const [from, to, id] of [
    ['anthropic', 'openai', 'gpt-6.1-sol'],
    ['openai', 'anthropic', 'claude-opus-5-5'],
  ]) {
    const h = await harness({
      extensions: ['src/switch-model.ts', 'src/fast.ts'],
      reply: (_p, _b, i) =>
        i === 0
          ? {
              tool: {
                name: 'switch_model',
                arguments: { model: `${to}/${id}` },
              },
            }
          : {},
    });
    try {
      const pi = await h.rpc(from);
      await pi.prompt();
      assert.deepEqual(
        h.requests.map((r) => r.provider),
        [from, to],
      );
      assert.deepEqual(
        h.requests.map((r) => r.payload.service_tier),
        [from, to].map((p) => (p === 'openai' ? 'priority' : undefined)),
      );
      await pi.close();
    } finally {
      await h.close();
    }
  }
});
