// Codex rollout adapter without I/O: the event metadata a transcript yields,
// never message bodies. Tested shapes: CLI 0.155.1 response_item and
// item_completed CommandExecution. The latter is essential for code-mode:
// parse the actual executed shell command, not JavaScript source that might
// merely mention a recorder call.
//
// The rollout format belongs to Codex, so every row is read as unknown
// through guards.readField and guards.toText: a malformed row fails or passes
// exactly as it did before the port (a JSON null row stops the whole read
// with the engine's TypeError, a non-string field is converted to text).

import guards = require('./guards.cjs');

const { readField, toText } = guards;

/** A recorder call a shell command can make. */
type RecorderCall =
  | { readonly kind: 'invoke'; readonly skill: Skill }
  | { readonly kind: 'mark'; readonly mark: MarkKind }
  | { readonly kind: 'unit'; readonly command: UnitCommand }
  | { readonly kind: 'done' };

type Skill = 'planning' | 'set' | 'init' | 'status' | 'audit';
type MarkKind = 'skip' | 'finding' | 'hold';
type UnitCommand = 'init' | 'start' | 'verified' | 'failed' | 'hold' | 'claim';
type Marker = 'AMBER_SKIP' | 'AMBER_DONE' | 'AMBER_GOAL' | 'AMBER_REVIEW';
type TypedSkill = 'planning' | 'init' | 'audit';

/** What an event is; built from the closed sets above. */
type EventKind =
  | `skill amber:${Skill}`
  | `mark ${MarkKind}`
  | `cmd unit ${UnitCommand}`
  | 'cmd done'
  | `typed amber:${TypedSkill}`
  | `marker ${Marker}`
  | 'verdict-text';

/** The ledger row an event should have produced, matched by audit.cjs. */
type Expectation =
  | 'skill-invocation'
  | 'planning-invocation'
  | 'unit-hold'
  | 'skip'
  | 'finding'
  | `unit-${Exclude<UnitCommand, 'claim'>}`
  | 'done-declaration';

/** How a recorder call fared in the output the transcript kept. */
type CallResult = 'accepted' | 'refused' | 'mention' | 'unobserved';

/** Where an event was found; ts is the row's timestamp as Codex wrote it. */
interface Meta {
  readonly ln: number;
  readonly ts: unknown;
}

interface TranscriptEvent extends Meta {
  readonly kind: EventKind;
  readonly expect: Expectation | null;
  readonly name?: `amber:${Skill | TypedSkill}`;
  readonly typed?: boolean;
  readonly result?: CallResult;
}

interface CodexTranscript {
  readonly events: TranscriptEvent[];
  readonly users: number;
  readonly assistants: number;
  readonly lines: number;
  readonly cwd: unknown;
  readonly stops: never[];
  readonly reentries: Meta[];
  readonly host: 'codex';
  readonly stopsKnown: false;
  readonly malformed: number;
}

const RECORDER_CALL =
  /\brecord\.cjs["']?\s+(invoke\s+(planning|set|init|status|audit)|mark\s+(skip|finding|hold)|unit\s+(init|start|verified|failed|hold|claim)|done)\b/g;
const REFUSAL_LINE =
  /(?:^|\n)(?:amber: |Error: |.*(?:PreToolUse|hook).*denied).*|blocked by (?:contract|unit)/i;
const REFUSAL_WORDS =
  /refus|denied|outside|is required|is broken|needs |invalid |no progress|open unit|units still open|cannot |unknown unit|worktree remains/i;
const TYPED = /^(?:\/|\$)amber:(planning|init|audit)\b/;
const MARKER = /^\s*(AMBER_SKIP|AMBER_DONE|AMBER_GOAL|AMBER_REVIEW)\b/gm;
const LOOP_DIRECTIVE = /^amber loop \(contract [^\n]+\)/;
const REENTRY = /Re-entry \d+\/\d+/;
const SHELL_TOOL = /^(?:.*\.)?(exec_command|shell_command|shell)$/;

function skillOf(name: string): Skill | null {
  switch (name) {
    case 'planning':
    case 'set':
    case 'init':
    case 'status':
    case 'audit':
      return name;
    default:
      return null;
  }
}

function markOf(name: string): MarkKind | null {
  switch (name) {
    case 'skip':
    case 'finding':
    case 'hold':
      return name;
    default:
      return null;
  }
}

function unitCommandOf(name: string): UnitCommand | null {
  switch (name) {
    case 'init':
    case 'start':
    case 'verified':
    case 'failed':
    case 'hold':
    case 'claim':
      return name;
    default:
      return null;
  }
}

function markerOf(name: string): Marker | null {
  switch (name) {
    case 'AMBER_SKIP':
    case 'AMBER_DONE':
    case 'AMBER_GOAL':
    case 'AMBER_REVIEW':
      return name;
    default:
      return null;
  }
}

function typedSkillOf(name: string): TypedSkill | null {
  switch (name) {
    case 'planning':
    case 'init':
    case 'audit':
      return name;
    default:
      return null;
  }
}

function recorderCall(match: RegExpMatchArray): RecorderCall {
  const skill = skillOf(match[2] ?? '');
  if (skill) return { kind: 'invoke', skill };
  const mark = markOf(match[3] ?? '');
  if (mark) return { kind: 'mark', mark };
  const command = unitCommandOf(match[4] ?? '');
  if (command) return { kind: 'unit', command };
  return { kind: 'done' };
}

/** Message content as text: a string, or the text blocks of an array. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const text = readField(block, 'text');
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
  }
  return '';
}

/** Whether the output shows the recorder's success line for a unit command. */
function unitAccepted(command: UnitCommand, body: string): boolean {
  const transition = (state: string): boolean =>
    new RegExp('^amber: unit U\\d+ -> ' + state, 'm').test(body);
  switch (command) {
    case 'init':
      return /^amber: progress\.json initialized/m.test(body);
    case 'claim':
      return /^amber: unit U\d+ claimed by subagent /m.test(body);
    case 'start':
      return transition('running');
    case 'hold':
      return transition('hold');
    case 'verified':
    case 'failed':
      return transition(command);
  }
}

/** The event a recorder call stands for and whether its output accepted it. */
function describeCall(
  call: RecorderCall,
  body: string,
): { event: Omit<TranscriptEvent, keyof Meta>; accepted: boolean } {
  switch (call.kind) {
    case 'invoke':
      return {
        event: {
          kind: `skill amber:${call.skill}`,
          expect: 'skill-invocation',
          name: `amber:${call.skill}`,
          typed: false,
        },
        accepted: new RegExp(
          '^amber: recorded invoke ' + call.skill + '\\s*$',
          'm',
        ).test(body),
      };
    case 'mark':
      return {
        event: {
          kind: `mark ${call.mark}`,
          expect: call.mark === 'hold' ? 'unit-hold' : call.mark,
        },
        accepted: new RegExp(
          '^amber: recorded mark ' + call.mark + '\\s*$',
          'm',
        ).test(body),
      };
    case 'unit':
      return {
        event: {
          kind: `cmd unit ${call.command}`,
          expect: call.command === 'claim' ? null : `unit-${call.command}`,
        },
        accepted: unitAccepted(call.command, body),
      };
    case 'done':
      return {
        event: { kind: 'cmd done', expect: 'done-declaration' },
        accepted: /^amber: completion signal written /m.test(body),
      };
    default: {
      const unreachable: never = call;
      return unreachable;
    }
  }
}

/**
 * The recorder calls in one shell command, each with how its output shows
 * it: accepted, refused, only mentioned, or unobserved (no output kept, or
 * one output holding both a refusal and a success of a repeated call).
 */
function commandEvents(
  command: unknown,
  output: unknown,
  meta: Meta,
): TranscriptEvent[] {
  const calls = [...toText(command).matchAll(RECORDER_CALL)];
  const body = textOf(output);
  return calls.map((m) => {
    const { event, accepted } = describeCall(recorderCall(m), body);
    const refused = REFUSAL_LINE.test(body) && REFUSAL_WORDS.test(body);
    const identical = calls.filter((c) => c[1] === m[1]).length;
    // One shell result may contain both a refusal and success of the same
    // command. It cannot establish which occurrence produced a ledger row.
    const result: CallResult =
      output === null || (identical > 1 && accepted && refused)
        ? 'unobserved'
        : accepted
          ? 'accepted'
          : refused
            ? 'refused'
            : 'mention';
    return { ...meta, ...event, result };
  });
}

function markerExpect(marker: Marker): Expectation | null {
  switch (marker) {
    case 'AMBER_SKIP':
      return 'skip';
    case 'AMBER_DONE':
      return 'done-declaration';
    case 'AMBER_GOAL':
    case 'AMBER_REVIEW':
      return null;
  }
}

interface Row {
  readonly value: unknown;
  readonly ln: number;
}

interface FallbackCall extends Meta {
  readonly command: unknown;
  output: unknown;
}

interface Execution extends Meta {
  readonly item: unknown;
}

/** The events of one Codex rollout's text; file names it in the error. */
function parseCodexTranscript(text: string, file: string): CodexTranscript {
  const lines = text.split('\n');
  const events: TranscriptEvent[] = [];
  const reentries: Meta[] = [];
  const rows: Row[] = [];
  let cwd: unknown = null;
  let users = 0;
  let assistants = 0;
  let malformed = 0;
  let recognized = false;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push({ value: JSON.parse(line), ln: i + 1 });
    } catch {
      malformed += 1;
    }
  });
  // Final CommandExecution items are authoritative for nested code-mode calls.
  // Direct function calls are a fallback for older rollouts without these items.
  const executions = new Map<unknown, Execution>();
  for (const { value: r, ln } of rows) {
    const p = readField(r, 'payload') || {};
    const item = readField(p, 'item');
    if (
      readField(r, 'type') === 'event_msg' &&
      readField(p, 'type') === 'item_completed' &&
      (item === null || item === undefined
        ? undefined
        : readField(item, 'type')) === 'CommandExecution'
    ) {
      executions.set(readField(item, 'id') || 'line-' + String(ln), {
        item,
        ln,
        ts: readField(r, 'timestamp') || '',
      });
    }
  }
  const fallbackCalls = new Map<unknown, FallbackCall>();
  for (const { value: r, ln } of rows) {
    const p = readField(r, 'payload') || {};
    const ts = readField(r, 'timestamp') || '';
    const type = readField(r, 'type');
    if (type === 'session_meta') {
      cwd = readField(p, 'cwd') || cwd;
      recognized = true;
    }
    if (type === 'turn_context') cwd = cwd || readField(p, 'cwd') || null;
    if (type !== 'response_item') continue;
    recognized = true;
    const payloadType = readField(p, 'type');
    if (payloadType === 'message') {
      const body = textOf(readField(p, 'content'));
      const role = readField(p, 'role');
      if (role === 'user' || role === 'developer') {
        if (role === 'user') {
          users += 1;
          const typed = typedSkillOf(TYPED.exec(body.trim())?.[1] ?? '');
          if (typed) {
            events.push({
              ln,
              ts,
              kind: `typed amber:${typed}`,
              expect:
                typed === 'planning'
                  ? 'planning-invocation'
                  : 'skill-invocation',
              name: `amber:${typed}`,
              typed: true,
            });
          }
        }
        // Count actual injected directives, not examples buried in instructions.
        if (LOOP_DIRECTIVE.test(body.trim()) && REENTRY.test(body)) {
          reentries.push({ ln, ts });
        }
      } else if (role === 'assistant') {
        assistants += 1;
        const kinds = new Set(
          [...body.matchAll(MARKER)].map((m) => markerOf(m[1] ?? '')),
        );
        for (const k of kinds) {
          if (k) {
            events.push({
              ln,
              ts,
              kind: `marker ${k}`,
              expect: markerExpect(k),
            });
          }
        }
        if (!kinds.size && /opening verdict|declined opening/.test(body)) {
          events.push({ ln, ts, kind: 'verdict-text', expect: 'skip' });
        }
      }
    } else if (
      payloadType === 'function_call' &&
      SHELL_TOOL.test(toText(readField(p, 'name') || ''))
    ) {
      let args: unknown;
      try {
        args = JSON.parse(toText(readField(p, 'arguments')));
      } catch {
        continue;
      }
      const command = readField(args, 'cmd') || readField(args, 'command');
      fallbackCalls.set(readField(p, 'call_id'), {
        ln,
        ts,
        command: Array.isArray(command) ? command.at(-1) : command,
        output: null,
      });
    } else if (payloadType === 'function_call_output') {
      const call = fallbackCalls.get(readField(p, 'call_id'));
      if (call) {
        const output = readField(p, 'output');
        call.output = typeof output === 'string' ? output : textOf(output);
      }
    }
  }
  if (!recognized) {
    throw new Error('unsupported Codex transcript shape: ' + file);
  }
  const executedCommands = new Set<unknown>();
  for (const { item, ln, ts } of executions.values()) {
    const raw = readField(item, 'command');
    const command = Array.isArray(raw) ? raw.at(-1) : raw;
    executedCommands.add(command);
    const stdout = readField(item, 'stdout');
    const stderr = readField(item, 'stderr');
    const output =
      readField(item, 'aggregated_output') ??
      readField(item, 'formatted_output') ??
      (typeof stdout === 'string' || typeof stderr === 'string'
        ? toText(stdout || '') + toText(stderr || '')
        : null);
    events.push(...commandEvents(command, output, { ln, ts }));
  }
  for (const call of fallbackCalls.values()) {
    if (!executedCommands.has(call.command)) {
      events.push(
        ...commandEvents(call.command, call.output, {
          ln: call.ln,
          ts: call.ts,
        }),
      );
    }
  }
  events.sort((a, b) => a.ln - b.ln);
  // A final assistant message or task_complete is not proof that a Stop hook
  // ran. Current Codex rollouts do not persist Claude's stop_hook_summary.
  return {
    events,
    users,
    assistants,
    lines: lines.length,
    cwd,
    stops: [],
    reentries,
    host: 'codex',
    stopsKnown: false,
    malformed,
  };
}

export = { commandEvents, parseCodexTranscript };
