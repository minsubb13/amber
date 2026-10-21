import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// Process-local only: preserve toggle and once-only notice across /reload too.
const key = Symbol.for('amber.pi.runtime.fast.v1');
type State = { enabled: boolean; tierNoticeShown: boolean };
export default function (pi: ExtensionAPI, initialContext: ExtensionContext) {
  const processState = globalThis as typeof globalThis & { [key]?: State };
  const state = processState[key] ??= { enabled: true, tierNoticeShown: false };
  let injected = false;
  let retryPending = false;
  const status = (ctx: ExtensionContext) => ctx.ui.setStatus('model-tools-fast', state.enabled ? 'fast' : undefined);
  const notify = (ctx: ExtensionContext, text: string, warning = false) => {
    if (ctx.hasUI) ctx.ui.notify(text, warning ? 'warning' : 'info');
    else console.error(`[fast] ${text}`);
  };
  status(initialContext);
  pi.on('session_start', (_event, ctx) => status(ctx));
  pi.registerCommand('fast', {
    description: 'Show or toggle OpenAI priority requests for this process: /fast [on|off]',
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value && value !== 'on' && value !== 'off') {
        notify(ctx, 'Usage: /fast [on|off]', true);
        return;
      }
      if (value) state.enabled = value === 'on';
      status(ctx);
      notify(ctx, `fast ${state.enabled ? 'on' : 'off'} (this process only; OpenAI agent-loop requests)`);
    },
  });
  pi.on('before_provider_request', (event, ctx) => {
    // Pi can retry before agent_before_settle. An already-started request
    // consumes our pending continuation, whether that retry succeeds or fails.
    retryPending = false;
    injected = state.enabled && ctx.model?.provider === 'openai';
    if (injected) return { ...(event.payload as Record<string, unknown>), service_tier: 'priority' };
  });
  pi.on('provider_stream_event', (event, ctx) => {
    if (!injected || event.provider !== 'openai' || state.tierNoticeShown) return;
    const data = event.data as { type?: string; response?: { service_tier?: string } };
    // Early response.created may say auto, while the completed tier differs.
    if (data.type !== 'response.completed' && data.type !== 'response.incomplete') return;
    const tier = data.response?.service_tier;
    if (tier !== 'priority') {
      state.tierNoticeShown = true;
      notify(ctx, `OpenAI reported service_tier=${tier ?? 'unknown'}, not priority. Priority execution is not confirmed.`, true);
    }
  });
  pi.on('message_end', (event, ctx) => {
    const message = event.message;
    if (!injected || message.role !== 'assistant' || message.provider !== 'openai' || message.stopReason !== 'error') return;
    const error = message.errorMessage ?? '';
    // Pi 1.3.0 formats SDK HTTP errors with this status prefix. Do not infer
    // HTTP status from numbers embedded in an unrelated response body.
    if (!/^OpenAI API error \(400\):/.test(error) || !/\bservice_tier\b/i.test(error)) return;
    injected = false;
    state.enabled = false;
    retryPending = true;
    status(ctx);
    notify(ctx, 'OpenAI rejected service_tier. fast off for this process; continuing once at the default tier.', true);
  });
  pi.on('agent_before_settle', (event) => {
    if (!retryPending) return;
    retryPending = false; // Consume before requesting continuation: cannot loop.
    if (event.outcome === 'aborted') return;
    // Pi requires a non-assistant tail to continue after an error. Add one
    // context message rather than re-submitting or duplicating the user prompt.
    return {
      entries: [{ type: 'custom_message', customType: 'model-tools-fast-retry', content: 'Recovery for the immediately preceding failed request: priority was rejected before an answer, and fast was turned off for this retry. Continue that task once at the default tier. This is a historical recovery event, not an instruction for later turns or future fast settings.', display: false }],
      continue: true,
    };
  });
}
