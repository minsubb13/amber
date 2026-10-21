import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from '../helpers/pi.ts';

test('reload preserves process toggle and once-only completed-tier notice', async () => {
  const h = await harness({ reply: () => ({ tier: 'default' }) });
  try {
    const fixture = join(h.dir, 'reload.ts');
    writeFileSync(
      fixture,
      `export default pi => pi.registerCommand('runtime-reload',{handler:async(_args,ctx)=>{await ctx.reload();}});`,
    );
    const pi = await h.rpc('openai', [fixture]);
    await pi.prompt();
    await pi.prompt('/fast off');
    await pi.command('prompt', { message: '/runtime-reload' });
    // RPC handles extension commands synchronously; get_commands is a barrier.
    assert.equal(
      (await pi.command('get_commands')).commands.filter(
        (c: any) => c.name === 'fast',
      ).length,
      1,
    );
    await pi.prompt();
    await pi.prompt('/fast on');
    await pi.prompt();
    assert.deepEqual(
      h.requests.map((r) => r.payload.service_tier),
      ['priority', undefined, 'priority'],
    );
    const notifications = pi.events
      .filter((e) => e.method === 'notify')
      .map((e) => e.message);
    assert.equal(
      notifications.filter((n: string) => n.includes('not priority')).length,
      1,
    );
    assert.ok(!pi.events.some((e) => e.type === 'extension_error'));
    await pi.close();
  } finally {
    await h.close();
  }
});
