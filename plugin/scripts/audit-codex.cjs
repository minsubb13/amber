// Codex rollout adapter. Read-only; returns event metadata, never message bodies.
// Tested shapes: CLI 0.155.1 response_item and item_completed CommandExecution.
// The latter is essential for code-mode: parse the actual executed shell
// command, not JavaScript source that might merely mention a recorder call.
'use strict';
const fs = require('node:fs');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => typeof b.text === 'string' ? b.text : '').join('\n');
  return '';
}

function commandEvents(command, output, meta) {
  const calls = [...String(command).matchAll(/\brecord\.cjs["']?\s+(invoke\s+(planning|set|init|status|audit)|mark\s+(skip|finding|hold)|unit\s+(init|start|verified|failed|hold|claim)|done)\b/g)];
  const body = textOf(output);
  return calls.map(m => {
    let ev;
    let accepted;
    if (m[2]) {
      ev = {kind:'skill amber:' + m[2], expect:'skill-invocation', name:'amber:' + m[2], typed:false};
      accepted = new RegExp('^amber: recorded invoke ' + m[2] + '\\s*$', 'm').test(body);
    } else if (m[3]) {
      ev = {kind:'mark ' + m[3], expect:m[3] === 'hold' ? 'unit-hold' : m[3]};
      accepted = new RegExp('^amber: recorded mark ' + m[3] + '\\s*$', 'm').test(body);
    } else if (m[4]) {
      const kind = m[4];
      ev = {kind:'cmd unit ' + kind, expect:kind === 'claim' ? null : 'unit-' + kind};
      accepted = kind === 'init' ? /^amber: progress\.json initialized/m.test(body)
        : kind === 'claim' ? /^amber: unit U\d+ claimed by subagent /m.test(body)
        : new RegExp('^amber: unit U\\d+ -> ' + (kind === 'start' ? 'running' : kind === 'hold' ? 'hold' : kind), 'm').test(body);
    } else {
      ev = {kind:'cmd done', expect:'done-declaration'};
      accepted = /^amber: completion signal written /m.test(body);
    }
    const refused = /(?:^|\n)(?:amber: |Error: |.*(?:PreToolUse|hook).*denied).*|blocked by (?:contract|unit)/i.test(body) &&
      /refus|denied|outside|is required|is broken|needs |invalid |no progress|open unit|units still open|cannot |unknown unit|worktree remains/i.test(body);
    const identical = calls.filter(c => c[1] === m[1]).length;
    // One shell result may contain both a refusal and success of the same
    // command. It cannot establish which occurrence produced a ledger row.
    const result = output === null || (identical > 1 && accepted && refused) ? 'unobserved'
      : accepted ? 'accepted' : refused ? 'refused' : 'mention';
    return {...meta, ...ev, result};
  });
}

function codexEvents(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const events = [];
  const stops = [];
  const reentries = [];
  const rows = [];
  let cwd = null;
  let users = 0;
  let assistants = 0;
  let malformed = 0;
  let recognized = false;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push({value:JSON.parse(line),ln:i+1}); } catch { malformed += 1; }
  });
  // Final CommandExecution items are authoritative for nested code-mode calls.
  // Direct function calls are a fallback for older rollouts without these items.
  const executions = new Map();
  for (const {value:r,ln} of rows) {
    const p = r.payload || {};
    if (r.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution') {
      executions.set(p.item.id || 'line-' + ln, {item:p.item, ln, ts:r.timestamp || ''});
    }
  }
  const fallbackCalls = new Map();
  for (const {value:r,ln} of rows) {
    const p = r.payload || {};
    const ts = r.timestamp || '';
    if (r.type === 'session_meta') { cwd = p.cwd || cwd; recognized = true; }
    if (r.type === 'turn_context') cwd = cwd || p.cwd || null;
    if (r.type !== 'response_item') continue;
    recognized = true;
    if (p.type === 'message') {
      const text = textOf(p.content);
      if (p.role === 'user' || p.role === 'developer') {
        if (p.role === 'user') {
          users += 1;
          const typed = /^(?:\/|\$)amber:(planning|init|audit)\b/.exec(text.trim());
          if (typed) events.push({ln,ts,kind:'typed amber:' + typed[1],expect:typed[1] === 'planning' ? 'planning-invocation' : 'skill-invocation',name:'amber:' + typed[1],typed:true});
        }
        // Count actual injected directives, not examples buried in instructions.
        if (/^amber loop \(contract [^\n]+\)/.test(text.trim()) && /Re-entry \d+\/\d+/.test(text)) reentries.push({ln,ts});
      } else if (p.role === 'assistant') {
        assistants += 1;
        const kinds = new Set([...text.matchAll(/^\s*(AMBER_SKIP|AMBER_DONE|AMBER_GOAL|AMBER_REVIEW)\b/gm)].map(m=>m[1]));
        for (const k of kinds) events.push({ln,ts,kind:'marker ' + k,expect:k === 'AMBER_SKIP' ? 'skip' : k === 'AMBER_DONE' ? 'done-declaration' : null});
        if (!kinds.size && /opening verdict|declined opening/.test(text)) events.push({ln,ts,kind:'verdict-text',expect:'skip'});
      }
    } else if (p.type === 'function_call' && /^(?:.*\.)?(exec_command|shell_command|shell)$/.test(p.name || '')) {
      let args;
      try { args = JSON.parse(p.arguments); } catch { continue; }
      const command = args.cmd || args.command;
      fallbackCalls.set(p.call_id, {ln,ts,command:Array.isArray(command) ? command.at(-1) : command,output:null});
    } else if (p.type === 'function_call_output' && fallbackCalls.has(p.call_id)) {
      fallbackCalls.get(p.call_id).output = typeof p.output === 'string' ? p.output : textOf(p.output);
    }
  }
  if (!recognized) throw new Error('unsupported Codex transcript shape: ' + file);
  const executedCommands = new Set();
  for (const {item,ln,ts} of executions.values()) {
    const command = Array.isArray(item.command) ? item.command.at(-1) : item.command;
    executedCommands.add(command);
    const output = item.aggregated_output ?? item.formatted_output ??
      (typeof item.stdout === 'string' || typeof item.stderr === 'string' ? (item.stdout || '') + (item.stderr || '') : null);
    events.push(...commandEvents(command,output,{ln,ts}));
  }
  for (const call of fallbackCalls.values()) {
    if (!executedCommands.has(call.command)) events.push(...commandEvents(call.command,call.output,{ln:call.ln,ts:call.ts}));
  }
  events.sort((a,b)=>a.ln-b.ln);
  // A final assistant message or task_complete is not proof that a Stop hook
  // ran. Current Codex rollouts do not persist Claude's stop_hook_summary.
  return {events,users,assistants,lines:lines.length,cwd,stops,reentries,host:'codex',stopsKnown:false,malformed};
}

module.exports = {codexEvents, commandEvents};
