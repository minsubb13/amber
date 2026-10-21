import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import switchModel from './switch-model.ts';
import fast from './fast.ts';

/** Flags are parsed after factories load. Register nothing optional until startup. */
export default function runtime(pi: ExtensionAPI) {
  pi.registerFlag('amber-runtime', {
    type: 'boolean',
    default: false,
    description: 'Enable optional model handoff and OpenAI priority-request controls',
  });
  let initialized = false;
  pi.on('session_start', (_event, ctx) => {
    if (initialized || pi.getFlag('amber-runtime') !== true) return;
    initialized = true;
    // All extension factories have loaded, independent of their load order.
    // Never replace a standalone tool or install a competing command handler.
    if (pi.getAllTools().some(tool => tool.name === 'switch_model') ||
        pi.getCommands().some(command => command.name === 'fast')) {
      const message = 'Amber runtime disabled: switch_model or /fast is already installed. Remove the standalone pi-model-tools package/extensions before enabling --amber-runtime; Amber does not change settings automatically.';
      if (ctx.hasUI) ctx.ui.notify(message, 'warning');
      else console.error(message);
      return;
    }
    switchModel(pi);
    fast(pi, ctx);
  });
}
