import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export const targets = { openai: 'gpt-6.1-sol', anthropic: 'claude-opus-5-5' };
export type Reply = {
  tool?: { name: string; arguments: object };
  text?: string;
  tier?: string;
  createdTier?: string;
  omitTier?: boolean;
  error?: { status: number; message: string; param?: string; code?: string };
};

// Real pi, isolated credentials/resources, and only loopback provider endpoints.
export async function harness(
  options: {
    extensions?: string[];
    persist?: boolean;
    missing?: string[];
    settings?: object;
    runtime?: boolean;
    builtinTools?: boolean;
    reply?: (provider: string, payload: any, index: number) => Reply;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'amber-pi-runtime-test-'));
  const amberHome = join(dir, 'amber-home');
  mkdirSync(amberHome);
  const requests: { provider: string; payload: any }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const provider = req.url!.startsWith('/anthropic/')
      ? 'anthropic'
      : 'openai';
    requests.push({ provider, payload });
    const reply = options.reply?.(provider, payload, requests.length - 1) ?? {};
    if (reply.error) {
      res.writeHead(reply.error.status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: reply.error.message,
            ...(reply.error.param ? { param: reply.error.param } : {}),
            ...(reply.error.code ? { code: reply.error.code } : {}),
          },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (data: any) =>
      res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    const id = `mock_${requests.length}`;
    const text = reply.text ?? `Answer from ${provider}`;
    if (provider === 'anthropic') {
      event({
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: payload.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });
      event({
        type: 'content_block_start',
        index: 0,
        content_block: reply.tool
          ? {
              type: 'tool_use',
              id: `call_${id}`,
              name: reply.tool.name,
              input: {},
            }
          : { type: 'text', text: '' },
      });
      event({
        type: 'content_block_delta',
        index: 0,
        delta: reply.tool
          ? {
              type: 'input_json_delta',
              partial_json: JSON.stringify(reply.tool.arguments),
            }
          : { type: 'text_delta', text },
      });
      event({ type: 'content_block_stop', index: 0 });
      event({
        type: 'message_delta',
        delta: {
          stop_reason: reply.tool ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: 10 },
      });
      event({ type: 'message_stop' });
    } else {
      const item = reply.tool
        ? {
            type: 'function_call',
            id: `fc_${id}`,
            call_id: `call_${id}`,
            name: reply.tool.name,
            arguments: JSON.stringify(reply.tool.arguments),
            status: 'completed',
          }
        : {
            type: 'message',
            id: `msg_${id}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          };
      const response = {
        id,
        object: 'response',
        status: 'completed',
        model: payload.model,
        output: [item],
        ...(reply.omitTier ? {} : { service_tier: reply.tier ?? 'priority' }),
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      };
      event({
        type: 'response.created',
        response: {
          ...response,
          ...(reply.createdTier ? { service_tier: reply.createdTier } : {}),
          status: 'in_progress',
          output: [],
        },
      });
      event({
        type: 'response.output_item.added',
        output_index: 0,
        item: reply.tool
          ? { ...item, arguments: '' }
          : { ...item, content: [] },
      });
      if (reply.tool)
        event({
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: JSON.stringify(reply.tool.arguments),
        });
      else
        event({
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: text,
        });
      event({ type: 'response.output_item.done', output_index: 0, item });
      event({ type: 'response.completed', response });
    }
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as any).port;
  const providers = Object.fromEntries(
    Object.entries(targets).map(([provider, id]) => [
      provider,
      {
        baseUrl: `http://127.0.0.1:${port}/${provider}/v1`,
        ...(options.missing?.includes(provider)
          ? {}
          : { apiKey: 'dummy-test-key' }),
        models: [
          {
            id,
            name: id,
            api:
              provider === 'openai' ? 'openai-responses' : 'anthropic-messages',
            reasoning: true,
            input: ['text'],
            contextWindow: 1000000,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ]),
  );
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers }));
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0 },
      cacheWarming: 'off',
      ...options.settings,
    }),
  );
  const children = new Set<ReturnType<typeof spawn>>();
  async function rpc(
    provider = 'anthropic',
    extensions = options.extensions ?? ['plugin/pi/index.ts'],
    selectStartupModel = true,
    extraArgs: string[] = [],
  ) {
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      TERM: 'dumb',
      LANG: 'C.UTF-8',
      PI_OFFLINE: '1',
      PI_CODING_AGENT_DIR: dir,
      AMBER_HOME: amberHome,
    };
    // Ported standalone cases all exercise the full Amber extension, not just
    // individual helper modules. Explicit fixture paths remain available.
    const mapped = extensions.map((e) =>
      e.startsWith('src/') ? 'plugin/pi/index.ts' : e,
    );
    const loaded = [
      ...new Set(
        mapped.some((e) => resolve(e) === resolve('plugin/pi/index.ts'))
          ? mapped
          : ['plugin/pi/index.ts', ...mapped],
      ),
    ];
    const args = [
      '--offline',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-mcp',
      '--no-themes',
      '--no-approve',
      ...(options.persist ? [] : ['--no-session']),
      ...(selectStartupModel
        ? [
            '--provider',
            provider,
            '--model',
            targets[provider as keyof typeof targets],
          ]
        : []),
      '--thinking',
      'off',
      ...(options.builtinTools ? [] : ['--no-builtin-tools']),
      ...loaded.flatMap((e) => ['-e', resolve(e)]),
      ...(options.runtime === false ? [] : ['--amber-runtime']),
      ...extraArgs,
      '--mode',
      'rpc',
    ];
    const child = spawn('pi', args, {
      cwd: dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    child.on('exit', () => children.delete(child));
    const events: any[] = [];
    let stderr = '',
      buffer = '',
      seq = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      buffer += data;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim()) {
          try {
            events.push(JSON.parse(line));
          } catch {
            stderr += line;
          }
        }
      }
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    async function wait(
      predicate: (events: any[]) => any,
      timeout = 20000,
    ): Promise<any> {
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = predicate(events);
        if (value) return value;
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(
            `pi stopped/timed out: ${stderr}\n${JSON.stringify(events.slice(-6))}`,
          );
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    async function command(type: string, args: object = {}) {
      const id = String(++seq);
      child.stdin.write(JSON.stringify({ id, type, ...args }) + '\n');
      const result = await wait((es) =>
        es.find((e) => e.type === 'response' && e.id === id),
      );
      if (!result.success) throw new Error(JSON.stringify(result));
      return result.data;
    }
    await command('get_state');
    return {
      child,
      events,
      command,
      wait,
      stderr: () => stderr,
      async prompt(message = 'test') {
        const offset = events.length;
        const result = await command('prompt', { message });
        if (result.disposition !== 'handled')
          await wait((es) =>
            es.slice(offset).find((e) => e.type === 'agent_settled'),
          );
        return result;
      },
      async close() {
        child.stdin.end();
        if (child.exitCode === null) await once(child, 'exit');
      },
    };
  }
  return {
    dir,
    amberHome,
    requests,
    rpc,
    async close() {
      for (const child of children) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
