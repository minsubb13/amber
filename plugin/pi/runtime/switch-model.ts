import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const targets = ['openai/gpt-6.1-sol', 'anthropic/claude-opus-5-5'] as const;
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'switch_model',
    label: 'Switch model',
    description: 'Hand over this session to an allowed model. The selected model answers the very next response in this run. Does not change startup defaults or ask for confirmation.',
    parameters: Type.Object({
      // Keep literal tuples here: mapping arrays erases TypeBox's tuple
      // inference and makes the execute parameter type `never`.
      model: Type.Union([Type.Literal('openai/gpt-6.1-sol'), Type.Literal('anthropic/claude-opus-5-5')]),
      thinking: Type.Optional(Type.Union([
        Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'),
        Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max'),
      ])),
    }),
    executionMode: 'sequential',
    async execute(_id, args, _signal, _update, ctx) {
      // Keep validation here as well as in the schema: never resolve arbitrary targets.
      if (!targets.includes(args.model)) throw new Error('Model is not in the switch_model allowlist');
      if (args.thinking !== undefined && !levels.includes(args.thinking)) throw new Error('Invalid thinking level');
      const [provider, id] = args.model.split('/');
      const model = ctx.modelRegistry.find(provider, id);
      if (!model) throw new Error(`Model unavailable: ${args.model}`);
      // Pi checks usable auth before changing model or thinking, appends the same
      // model_change entry as /model, and applies its per-model thinking default.
      if (!await pi.setModel(model)) throw new Error(`No usable credentials for ${args.model}; model unchanged`);
      if (args.thinking !== undefined) pi.setThinkingLevel(args.thinking);
      return {
        content: [{ type: 'text', text: `${args.model} has taken over this session. You are the selected model; continue the task from the next response. Startup defaults are unchanged.` }],
        details: { model: args.model, thinking: pi.getThinkingLevel() },
      };
    },
  });
}
