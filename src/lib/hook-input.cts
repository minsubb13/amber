// The hook input's boundary check, without I/O. The host protocols send
// session_id, cwd and model as strings; a value of another type is read as
// absent. Every other field stays as found and is converted where it is
// read, as the hand-written hook did. A JSON null input fails with the
// TypeError the original raised when its handler read the first field.

import guards = require('./guards.cjs');
import type { HookEvent, HookInput } from './types.cjs';

/** The field each handler read first, which named the original's TypeError. */
function firstField(event: HookEvent): string {
  switch (event) {
    case 'S0':
    case 'E1':
      return 'cwd';
    case 'S1':
    case 'S2':
      return 'session_id';
    case 'S3':
      return 'tool_input';
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function hookInput(raw: unknown, event: HookEvent): HookInput {
  if (raw === null) guards.readField(raw, firstField(event));
  const field = (key: string): unknown =>
    guards.isObject(raw) ? raw[key] : undefined;
  const toolInput = field('tool_input');
  const sessionId = stringField(field('session_id'));
  const cwd = stringField(field('cwd'));
  const model = stringField(field('model'));
  return {
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(model === undefined ? {} : { model }),
    prompt: field('prompt'),
    tool_name: field('tool_name'),
    tool_input: guards.isObject(toolInput) ? toolInput : {},
    agent_id: field('agent_id'),
    stop_hook_active: field('stop_hook_active'),
  };
}

/** The event name hooks.json passes, or null for any other argument. */
function hookEvent(name: unknown): HookEvent | null {
  switch (name) {
    case 'S0':
    case 'S1':
    case 'S2':
    case 'S3':
    case 'E1':
      return name;
    default:
      return null;
  }
}

export = { hookInput, hookEvent };
