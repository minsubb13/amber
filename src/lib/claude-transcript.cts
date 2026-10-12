// Claude Code transcript adapter without I/O: the events the ledger is
// supposed to mirror. Nothing from message bodies is kept beyond the event
// kind and the amber skill or command name.
//
// The transcript format belongs to Claude Code, so every line is read as
// unknown through guards.readField and guards.toText. The original converted
// every field it read with String(), as toText does, so a malformed line -
// a null line or block, a missing or non-string field - fails or passes
// exactly as it did before the port.

import guards = require('./guards.cjs');
import type {
  AuditEvent,
  CallResult,
  ClaudeTranscript,
  Expectation,
  Marker,
  MarkKind,
  UnitCall,
} from './types.cjs';

const { readField, toText } = guards;

const REENTRY_LINE = /still open\. Re-entry \d+\/\d+|Re-entry \d+\/10 on U\d+/;
// record.cjs answers "amber: ..." on success and throws (Error text or
// Usage) on refusal; any other result means the command text only mentioned
// record.cjs (a grep, a heredoc writing a document).
const ACCEPTED =
  /amber: (?:completion signal written|unit U\d+ ->|unit U\d+ claimed by subagent|progress\.json initialized|warning)/;
const REFUSED =
  /^Error: |\bError: |Usage:|refus|is required|is broken|needs the|invalid unit|no progress\.json|active contract pointer|open unit|worktree/i;
const MARK_KIND = /^(skip|finding|hold)\b/;
// The script path may be quoted (`"…/record.cjs" done`).
const DONE_CALL = /record\.cjs["']?\s+done\b/;
const UNIT_CALL =
  /record\.cjs["']?\s+unit\s+(init|start|verified|failed|hold|claim)\b/;
const MARKER = /^\s*(AMBER_SKIP|AMBER_DONE|AMBER_GOAL|AMBER_REVIEW)\b/gm;

/** `a && a.key` on a value parsed from JSON. */
function fieldIf(value: unknown, key: string): unknown {
  return value ? readField(value, key) : value;
}

function markKindOf(args: string): MarkKind | 'malformed' {
  switch (MARK_KIND.exec(args.trim())?.[1] ?? '') {
    case 'skip':
      return 'skip';
    case 'finding':
      return 'finding';
    case 'hold':
      return 'hold';
    default:
      return 'malformed';
  }
}

function markExpect(kind: MarkKind | 'malformed'): Expectation {
  switch (kind) {
    case 'skip':
      return 'skip';
    case 'finding':
      return 'finding';
    case 'hold':
      return 'unit-hold';
    case 'malformed':
      return 'skill-invocation';
  }
}

function unitCallOf(name: string): UnitCall | null {
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

function resultOf(body: string): CallResult {
  if (ACCEPTED.test(body)) return 'accepted';
  if (REFUSED.test(body)) return 'refused';
  return 'mention';
}

/** Classifies the tool results of record.cjs calls made earlier. */
function readToolResults(content: unknown[], events: AuditEvent[]): void {
  for (const b of content) {
    if (readField(b, 'type') !== 'tool_result') continue;
    const toolUseId = readField(b, 'tool_use_id');
    const evs = events.filter((e) => e.toolId && e.toolId === toolUseId);
    if (!evs.length) continue;
    const bodyValue = readField(b, 'content');
    const body =
      typeof bodyValue === 'string'
        ? bodyValue
        : JSON.stringify(bodyValue || '');
    const result = resultOf(body);
    for (const ev of evs) ev.result = result;
  }
}

function readAssistantBlocks(
  content: unknown[],
  ln: number,
  ts: unknown,
  events: AuditEvent[],
): void {
  for (const b of content) {
    const type = readField(b, 'type');
    const name = readField(b, 'name');
    if (type === 'tool_use' && name === 'Skill') {
      const input = readField(b, 'input');
      const skill = toText(fieldIf(input, 'skill') || '');
      if (!skill.startsWith('amber:')) continue;
      const args = toText(fieldIf(input, 'args') || '');
      if (skill === 'amber:mark') {
        const kind = markKindOf(args);
        events.push({ ln, ts, kind: `mark ${kind}`, expect: markExpect(kind) });
      } else {
        events.push({
          ln,
          ts,
          kind: `skill amber:${skill.slice('amber:'.length)}`,
          expect: 'skill-invocation',
          name: skill,
        });
      }
    } else if (type === 'tool_use' && name === 'Bash') {
      const cmd = toText(fieldIf(readField(b, 'input'), 'command') || '');
      const done = DONE_CALL.test(cmd);
      const unit = unitCallOf(UNIT_CALL.exec(cmd)?.[1] ?? '');
      const toolId = readField(b, 'id');
      if (done) {
        events.push({
          ln,
          ts,
          kind: 'cmd done',
          expect: 'done-declaration',
          toolId,
        });
      }
      if (unit) {
        events.push({
          ln,
          ts,
          kind: `cmd unit ${unit}`,
          expect: unit === 'claim' ? null : `unit-${unit}`,
          toolId,
        });
      }
    } else if (type === 'text') {
      const t = toText(readField(b, 'text') || '');
      // An older declaration form was up to three marker lines in one message
      // (AMBER_REVIEW / AMBER_GOAL / AMBER_DONE); every kind counts.
      const kinds = new Set<Marker>();
      for (const mk of t.matchAll(MARKER)) {
        const marker = markerOf(mk[1] ?? '');
        if (marker) kinds.add(marker);
      }
      for (const k of kinds) {
        events.push({ ln, ts, kind: `marker ${k}`, expect: markerExpect(k) });
      }
      if (!kinds.size && /opening verdict|declined opening/.test(t)) {
        events.push({ ln, ts, kind: 'verdict-text', expect: 'skip' });
      }
    }
  }
}

/** The events of one Claude Code transcript's text. */
function parseClaudeTranscript(text: string): ClaudeTranscript {
  const events: AuditEvent[] = [];
  const lines = text.split('\n');
  let users = 0;
  let assistants = 0;
  let cwd: unknown = null;
  const stops: { ln: number; ts: unknown; cat: string }[] = [];
  const reentries: { ln: number; ts: unknown }[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    // Subagent lines live in their own files; the parent transcript's
    // sidechain copies are skipped.
    if (readField(o, 'isSidechain')) return;
    const content = fieldIf(readField(o, 'message'), 'content');
    const ts = readField(o, 'timestamp') || '';
    const ln = i + 1;
    const type = readField(o, 'type');
    if (type === 'user') {
      users += 1;
      if (REENTRY_LINE.test(line)) reentries.push({ ln, ts });
      // A record.cjs command's tool result tells refusal from acceptance;
      // only that classification is kept, never the text.
      if (Array.isArray(content)) readToolResults(content, events);
      return;
    }
    if (!cwd) {
      const lineCwd = readField(o, 'cwd');
      if (lineCwd) cwd = lineCwd;
    }
    // Claude Code writes a system line per Stop, and injects a blocking
    // hook's reason as a user-role line: that is where S2 send-backs, which
    // the ledger does not record, become countable. Counts only.
    if (type === 'system' && readField(o, 'subtype') === 'stop_hook_summary') {
      stops.push({ ln, ts, cat: 'stop' });
      return;
    }
    if (type !== 'assistant' || !Array.isArray(content)) return;
    assistants += 1;
    readAssistantBlocks(content, ln, ts, events);
  });
  return {
    events,
    users,
    assistants,
    lines: lines.length,
    cwd,
    stops,
    reentries,
  };
}

export = { parseClaudeTranscript };
