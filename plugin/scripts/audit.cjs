#!/usr/bin/env node
// Read-only audit helper. It
// reads the operator-global ledger, Claude Code / Codex session transcripts and an
// audit report, and writes nothing. Every count is bounded by --period-end
// so a live run elsewhere cannot change a number after it was written into
// a report; --exclude drops a project (for example the zone where Amber
// develops itself) from the field rows.
//
//   node audit.cjs summary                    field ledger counts (the report's ledger-counts block)
//   node audit.cjs dead                       declared mechanisms vs field firings
//   node audit.cjs sessions [n]               sample candidates, newest first (default 20)
//   node audit.cjs session <id-prefix>        transcript events vs ledger rows of one session
//   node audit.cjs check-summary <report.md>  recompute the ledger-counts block; exit 1 on any difference
//   node audit.cjs check-session <id-prefix>  exit 0 iff the transcript shows an opening verdict
//                                             that the ledger has no skip row for (loss detected)
//
// Options, anywhere on the command line: --period-end <ISO> (default now;
// printed as a millisecond ISO instant) and --exclude <project> (repeatable,
// default none). Inputs: ${AMBER_HOME:-~/.amber}/runs.jsonl and the
// explicit transcript root AMBER_TRANSCRIPTS, or both hosts' default roots.
// A missing ledger
// is zero rows; a missing transcript is an error (exit 1).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { codexEvents } = require('./audit-codex.cjs');

const HOME = os.homedir();
const AMBER_HOME = process.env.AMBER_HOME || path.join(HOME, '.amber');
const LEDGER = path.join(AMBER_HOME, 'runs.jsonl');
const TRANSCRIPT_ROOTS = process.env.AMBER_TRANSCRIPTS ? [process.env.AMBER_TRANSCRIPTS] : [
  path.join(HOME, '.claude', 'projects'),
  path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'sessions'),
  path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'archived_sessions'),
];
const PROJECTS = TRANSCRIPT_ROOTS.join(', ');
const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const MATCH_WINDOW_MS = 15 * 60 * 1000;
const TYPED_ROW = / \(typed\)$/;

const USAGE = [
  'usage: node audit.cjs <command> [--period-end <ISO>] [--exclude <project>]...',
  '  summary                    field ledger counts (the report block)',
  '  dead                       declared mechanisms vs field firings',
  '  sessions [n]               sample candidates, newest first (default 20)',
  '  session <id-prefix>        transcript events vs ledger rows of one session',
  '  check-summary <report.md>  recompute the block in the report; exit 1 on any difference',
  '  check-session <id-prefix>  exit 0 iff an opening verdict in the transcript has no skip row',
  'inputs: ' + LEDGER + ' (missing = zero rows), transcripts under ' + PROJECTS,
].join('\n');

class UsageError extends Error {}

// ---- options ----
function parseArgs(argv) {
  const opts = { periodEnd: null, exclude: [], positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--period-end' || a === '--exclude') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(a + ' needs a value');
      if (a === '--period-end') opts.periodEnd = value;
      else opts.exclude.push(value);
      i += 1;
    } else if (a.startsWith('--')) {
      throw new UsageError('unknown option ' + a);
    } else {
      opts.positional.push(a);
    }
  }
  return opts;
}
function normalizePeriodEnd(value) {
  const ms = value === null || value === undefined ? Date.now() : Date.parse(value);
  if (Number.isNaN(ms)) throw new UsageError('--period-end needs an ISO date-time, got ' + JSON.stringify(value));
  return new Date(ms).toISOString();
}
function canonicalExclude(list) {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))].sort();
}
function excludedText(ctx) {
  return ctx.exclude.length ? ctx.exclude.join(',') : 'none';
}

// ---- ledger ----
function loadRows(periodEnd) {
  let text;
  try {
    text = fs.readFileSync(LEDGER, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a malformed line is a finding, counted below */ rows.push({ malformed: true }); }
  }
  return rows.filter((r) => r.malformed || (r.ts || '') <= periodEnd);
}
function fieldOf(rows, ctx) {
  return rows.filter((r) => !r.malformed && !ctx.exclude.includes(r.project));
}
function count(list, key) {
  const c = {};
  for (const x of list) { const k = key(x); c[k] = (c[k] || 0) + 1; }
  return Object.keys(c).sort().map((k) => k + '=' + c[k]).join(' ');
}

function summaryLines(ctx) {
  const rows = loadRows(ctx.periodEnd);
  const field = fieldOf(rows, ctx);
  const done = field.filter((r) => r.trigger === 'done-declaration');
  const passed = done.filter((r) => r.gate === 'passed' && r.contract);
  const contracts = [...new Set(passed.map((r) => r.contract))].sort();
  const skips = field.filter((r) => r.trigger === 'skip');
  const skill = field.filter((r) => r.trigger === 'skill-invocation');
  return [
    'period_end=' + ctx.periodEnd,
    'excluded_projects=' + excludedText(ctx),
    'ledger_rows=' + rows.length + ' malformed=' + rows.filter((r) => r.malformed).length + ' field_rows=' + field.length,
    'by_project: ' + count(field, (r) => r.project),
    'by_trigger: ' + count(field, (r) => r.trigger),
    'by_model: ' + count(field, (r) => r.model || 'unknown'),
    'model_unknown_by_trigger: ' + count(field.filter((r) => !r.model || r.model === 'unknown'), (r) => r.trigger),
    'by_plugin_version: ' + count(field, (r) => r.plugin_version || 'unknown'),
    'skill_invocations: ' + count(skill, (r) => (r.summary || '').split(/\s/)[0]),
    'skips: ' + count(skips, (r) => (/^(opening verdict|declined opening)/.exec(r.summary || '') || [null, 'other'])[1]),
    'done: with_contract=' + done.filter((r) => r.contract).length + ' without_contract=' + done.filter((r) => !r.contract).length +
      ' with_review=' + done.filter((r) => r.review).length + ' with_goal=' + done.filter((r) => r.goal).length,
    'gate: ' + count(done, (r) => r.gate || 'none'),
    'completions_distinct_contracts=' + contracts.length,
    'completions: ' + contracts.join(' '),
    'unit_events: ' + count(field.filter((r) => /^unit-/.test(r.trigger)), (r) => r.trigger.slice(5)),
    'unit_rows_attributed: session=' + field.filter((r) => /^unit-/.test(r.trigger) && r.session_id !== 'shell').length +
      ' shell=' + field.filter((r) => /^unit-/.test(r.trigger) && r.session_id === 'shell').length,
    'out_of_scope_declarations=' + field.filter((r) => r.out_of_scope).length,
    'sessions_distinct=' + new Set(field.map((r) => r.session_id)).size,
  ];
}

// ---- declared mechanisms ----
// Source of the list: hooks.json (S0/S1/S2/S3/E1), the plugin's skills/
// directory (one row per skill, so a new skill appears by itself),
// record.cjs subcommands, mark kinds, contract machine rows, loop-body
// events, out-of-scope declarations, typed init/audit rows. Mechanisms that
// leave no ledger row by design are listed as unrecorded. Nothing here is
// marked as fixed: the operator may remove any row's mechanism.
function skillNames() {
  try {
    return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}
function mechanisms(ctx) {
  const field = fieldOf(loadRows(ctx.periodEnd), ctx);
  const n = (fn) => field.filter(fn).length;
  const summary = (r) => r.summary || '';
  const sk = (name) => n((r) => r.trigger === 'skill-invocation' && summary(r).startsWith(name) && !TYPED_ROW.test(summary(r)));
  const rows = [
    ['S1 typed /amber:planning (planning-invocation)', n((r) => r.trigger === 'planning-invocation')],
  ];
  for (const name of skillNames()) {
    const full = 'amber:' + name;
    if (name === 'mark') {
      // A well-formed mark is recorded as its event (skip, finding, hold);
      // only malformed arguments fall back to a plain skill-invocation row.
      rows.push([full + ' (Skill tool: skip, finding and hold rows)',
        n((r) => ['skip', 'finding', 'unit-hold'].includes(r.trigger)) + sk(full)]);
    } else {
      rows.push([full + ' (Skill tool)', sk(full)]);
    }
  }
  rows.push(
    ['amber:set research route (args mention research)', n((r) => r.trigger === 'skill-invocation' && /^amber:set/.test(summary(r)) && /research/.test(summary(r)))],
    ['S1 typed /amber:init (skill-invocation "amber:init (typed)")', n((r) => r.trigger === 'skill-invocation' && summary(r) === 'amber:init (typed)')],
    ['S1 typed /amber:audit (skill-invocation "amber:audit (typed)")', n((r) => r.trigger === 'skill-invocation' && summary(r) === 'amber:audit (typed)')],
    ['mark skip: opening verdict - no contract', n((r) => r.trigger === 'skip' && /^opening verdict/.test(summary(r)))],
    ['mark skip: declined opening', n((r) => r.trigger === 'skip' && /^declined opening/.test(summary(r)))],
    ['mark skip: other subjects', n((r) => r.trigger === 'skip' && !/^(opening verdict|declined opening)/.test(summary(r)))],
    ['mark finding', n((r) => r.trigger === 'finding')],
    ['mark hold (unit-hold)', n((r) => r.trigger === 'unit-hold')],
    ['hold plain (unit-hold without kind; one stop passes)', n((r) => r.trigger === 'unit-hold' && r.kind !== 'external')],
    ['hold external (unit-hold kind=external; every stop passes until the next transition)', n((r) => r.trigger === 'unit-hold' && r.kind === 'external')],
    ['done with contract (contract run completed)', n((r) => r.trigger === 'done-declaration' && r.contract)],
    ['done without contract (no-contract unit completed)', n((r) => r.trigger === 'done-declaration' && !r.contract)],
    ['done with semantic review attestation (review field)', n((r) => r.trigger === 'done-declaration' && r.review)],
    ['gate passed', n((r) => r.gate === 'passed')],
    ['gate exhausted (send-back retries used up)', n((r) => r.gate === 'exhausted')],
    ['unit init', n((r) => r.trigger === 'unit-init')],
    ['unit start', n((r) => r.trigger === 'unit-start')],
    ['unit verified', n((r) => r.trigger === 'unit-verified')],
    ['unit failed', n((r) => r.trigger === 'unit-failed')],
    ['unit limit (ten re-entries on one unit)', n((r) => r.trigger === 'unit-limit')],
    ['unit claim (subagent claim observed by E1, unit-claim)', n((r) => r.trigger === 'unit-claim')],
    ['out-of-scope declaration at verified/done', n((r) => !!r.out_of_scope)],
    ['E1 deny (write-scope / bash-deny refusal)', null, 'by design: the refusal reaches the model as the denial text; no ledger row'],
    ['S2 continuation send-back (re-entry)', null, 'by design: only the tenth re-entry writes unit-limit; the session command counts the re-entry directives in the transcript'],
    ['hold consumed by S2 (one stop let through)', null, 'by design: no row on consumption'],
    ['operator-typed /amber:status', null, 'by design: S1 records typed init and audit only; a typed status leaves no row'],
    ['S0 briefing (session opening: contract awareness, waiting signal, non-driving session)', null, 'by design: context injection only; no row'],
    ['sensor failure breadcrumb (state/sensor-failures.log)', fs.existsSync(path.join(AMBER_HOME, 'state', 'sensor-failures.log')) ? 'file present' : 0],
  );
  return rows;
}
function deadLines(ctx) {
  const out = ['period_end=' + ctx.periodEnd, 'excluded_projects=' + excludedText(ctx), 'mechanism | field_count | status'];
  for (const [name, c, note] of mechanisms(ctx)) {
    const status = c === null ? 'unrecorded (' + note + ')' : (c === 0 ? 'DEAD (0 in field)' : 'live');
    out.push(name + ' | ' + (c === null ? '-' : c) + ' | ' + status);
  }
  return out;
}

// ---- transcripts ----
function transcriptsFor(prefix) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes:true}); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir,entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('-tmp-')) walk(full); }
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const rollout = /^rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(entry.name);
        const id = rollout ? rollout[1] : entry.name.slice(0,-6);
        if (id.startsWith(prefix)) hits.push(full);
      }
    }
  };
  for (const root of TRANSCRIPT_ROOTS) walk(root);
  return [...new Set(hits)];
}
function findTranscript(prefix) {
  const hits = transcriptsFor(prefix);
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    throw new Error('transcript for ' + prefix + ': no <id>*.jsonl under ' + PROJECTS +
      ' (no Claude Code or Codex transcript on this machine for that session; set AMBER_TRANSCRIPTS to another root)');
  }
  throw new Error('transcript for ' + prefix + ': ' + hits.length + ' candidates ' + hits.join(', ') + ' - use a longer prefix');
}
// Events the ledger is supposed to mirror. Nothing from message bodies is
// kept beyond the event kind and the amber skill/command name.
function transcriptEvents(file) {
  if (path.basename(file).startsWith('rollout-')) return codexEvents(file);
  const events = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let users = 0;
  let assistants = 0;
  let cwd = null;
  const stops = [];
  const reentries = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (o.isSidechain) return; // subagent lines live in their own files; the parent transcript's sidechain copies are skipped
    const content = o.message && o.message.content;
    const ts = o.timestamp || '';
    const ln = i + 1;
    if (o.type === 'user') {
      users += 1;
      if (/still open\. Re-entry \d+\/\d+|Re-entry \d+\/10 on U\d+/.test(line)) reentries.push({ ln, ts });
      // A record.cjs command's tool result tells refusal from acceptance;
      // only that classification is kept, never the text.
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          const evs = events.filter((e) => e.toolId && e.toolId === b.tool_use_id);
          if (!evs.length) continue;
          const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          // record.cjs answers "amber: ..." on success and throws (Error text
          // or Usage) on refusal; any other result means the command text
          // only mentioned record.cjs (a grep, a heredoc writing a document).
          let result;
          if (/amber: (?:completion signal written|unit U\d+ ->|unit U\d+ claimed by subagent|progress\.json initialized|warning)/.test(body)) result = 'accepted';
          else if (/^Error: |\bError: |Usage:|refus|is required|is broken|needs the|invalid unit|no progress\.json|active contract pointer|open unit|worktree/i.test(body)) result = 'refused';
          else result = 'mention';
          for (const ev of evs) ev.result = result;
        }
      }
      return;
    }
    if (!cwd && o.cwd) cwd = o.cwd;
    // Claude Code writes a system line per Stop, and injects a blocking
    // hook's reason as a user-role line. That is where S2 send-backs, which
    // the ledger does not record, become countable (positive control:
    // loop-body QA probe transcripts show several "Re-entry n/10" user lines
    // each; the summary's preventedContinuation stays false and
    // hasOutput is true on every stop, so neither marks a block). Counts only.
    if (o.type === 'system' && o.subtype === 'stop_hook_summary') {
      stops.push({ ln, ts, cat: 'stop' });
      return;
    }
    if (o.type !== 'assistant' || !Array.isArray(content)) return;
    assistants += 1;
    for (const b of content) {
      if (b.type === 'tool_use' && b.name === 'Skill') {
        const skill = String(b.input && b.input.skill || '');
        if (!skill.startsWith('amber:')) continue;
        const args = String(b.input && b.input.args || '');
        if (skill === 'amber:mark') {
          const m = /^(skip|finding|hold)\b/.exec(args.trim());
          const kind = m ? m[1] : 'malformed';
          events.push({ ln, ts, kind: 'mark ' + kind, expect: kind === 'skip' ? 'skip' : kind === 'finding' ? 'finding' : kind === 'hold' ? 'unit-hold' : 'skill-invocation' });
        } else {
          events.push({ ln, ts, kind: 'skill ' + skill, expect: 'skill-invocation', name: skill });
        }
      } else if (b.type === 'tool_use' && b.name === 'Bash') {
        const cmd = String(b.input && b.input.command || '');
        // The script path may be quoted (`"…/record.cjs" done`): the draft's
        // pattern missed that spelling and lost a real completion call.
        const done = /record\.cjs["']?\s+done\b/.test(cmd);
        const unit = /record\.cjs["']?\s+unit\s+(init|start|verified|failed|hold|claim)\b/.exec(cmd);
        if (done) events.push({ ln, ts, kind: 'cmd done', expect: 'done-declaration', toolId: b.id });
        if (unit) events.push({ ln, ts, kind: 'cmd unit ' + unit[1], expect: unit[1] === 'claim' ? null : 'unit-' + unit[1], toolId: b.id });
      } else if (b.type === 'text') {
        const t = String(b.text || '');
        // An older declaration form was up to three marker lines in one
        // message (AMBER_REVIEW / AMBER_GOAL / AMBER_DONE); every kind counts.
        const kinds = new Set();
        for (const mk of t.matchAll(/^\s*(AMBER_SKIP|AMBER_DONE|AMBER_GOAL|AMBER_REVIEW)\b/gm)) kinds.add(mk[1]);
        for (const k of kinds) events.push({ ln, ts, kind: 'marker ' + k, expect: k === 'AMBER_SKIP' ? 'skip' : k === 'AMBER_DONE' ? 'done-declaration' : null });
        if (!kinds.size && /opening verdict|declined opening/.test(t)) events.push({ ln, ts, kind: 'verdict-text', expect: 'skip' });
      }
    }
  });
  return { events, users, assistants, lines: lines.length, cwd, stops, reentries };
}
function ledgerForSession(prefix, ctx) {
  return loadRows(ctx.periodEnd).filter((r) => !r.malformed && String(r.session_id || '').startsWith(prefix));
}
function compareSession(prefix, ctx) {
  const file = findTranscript(prefix);
  const t = transcriptEvents(file);
  const rows = ledgerForSession(prefix, ctx);
  // Unit rows written from a shell without a session id carry session "shell";
  // they are matched by zone and time instead, and reported as unattributed.
  const shellRows = loadRows(ctx.periodEnd).filter((r) => !r.malformed && r.session_id === 'shell' && t.cwd && r.cwd === t.cwd);
  const used = new Set();
  const usedShell = new Set();
  const gapOf = (row, ev) => Math.abs((Date.parse(row.ts) || 0) - (Date.parse(ev.ts || '') || 0));
  const results = t.events.map((ev) => {
    if (ev.result === 'unobserved') return { ev, status: 'unobservable (command outcome absent or ambiguous)' };
    if (ev.result === 'mention') return { ev, status: 'not an invocation (command text only mentions record.cjs)' };
    // A refused command wrote no row, so it must not take the row of the
    // accepted call that followed it (the draft matched before this check).
    if (ev.result === 'refused') return { ev, status: 'refused by the command (no row by design)' };
    if (!ev.expect) return { ev, status: 'n/a (no row by design)' };
    return { ev, status: 'MISSING' };
  });
  const pending = () => results.filter((r) => r.status === 'MISSING');
  // Closest pairs first (same trigger, inside the window), so an earlier
  // call cannot take the row that a later, closer call produced - the
  // draft assigned in event order and misfiled one real completion call.
  const assign = (candidates, list, usedSet, status) => {
    const pairs = [];
    for (const r of candidates) {
      list.forEach((row, i) => {
        if (usedSet.has(i) || row.trigger !== r.ev.expect) return;
        if (r.ev.name && !(row.summary || '').startsWith(r.ev.name)) return;
        if (r.ev.typed !== undefined && TYPED_ROW.test(row.summary || '') !== r.ev.typed && r.ev.expect === 'skill-invocation') return;
        const gap = gapOf(row, r.ev);
        if (gap <= MATCH_WINDOW_MS) pairs.push({ r, i, gap });
      });
    }
    pairs.sort((a, b) => a.gap - b.gap || a.r.ev.ln - b.r.ev.ln || a.i - b.i);
    for (const p of pairs) {
      if (p.r.status !== 'MISSING' || usedSet.has(p.i)) continue;
      usedSet.add(p.i);
      Object.assign(p.r, { status, row: list[p.i], gapS: Math.round(p.gap / 1000) });
    }
  };
  assign(pending(), rows, used, 'matched');
  assign(pending().filter((r) => /^unit-/.test(r.ev.expect)), shellRows, usedShell, 'matched-unattributed (row says session "shell")');
  // A hint only: the closest same-trigger row of the session, taken or not.
  for (const r of pending()) {
    let bestGap = Infinity;
    r.nearest = null;
    for (const row of rows) {
      if (row.trigger !== r.ev.expect) continue;
      const gap = gapOf(row, r.ev);
      if (gap < bestGap) { bestGap = gap; r.nearest = row; }
    }
  }
  const orphans = rows.filter((r, i) => !used.has(i));
  return { file, t, rows, results, orphans };
}
function sessionLines(prefix, ctx) {
  const c = compareSession(prefix, ctx);
  const out = [];
  out.push('session ' + prefix + ' transcript=' + c.file.replace(HOME, '~') + ' lines=' + c.t.lines + ' user_msgs=' + c.t.users + ' assistant_msgs=' + c.t.assistants);
  out.push('ledger rows for session (<= period_end): ' + c.rows.length + ' [' + count(c.rows, (r) => r.trigger) + ']');
  out.push('transcript events -> ledger:');
  for (const r of c.results) {
    out.push('  L' + r.ev.ln + ' ' + (r.ev.ts || '').slice(0, 19) + ' ' + r.ev.kind + ' -> ' + (r.ev.expect || '-') + ': ' + r.status +
      (r.row ? ' (row ' + r.row.ts.slice(11, 19) + ', +' + r.gapS + 's)' : '') +
      (r.status === 'MISSING' && r.nearest ? ' (nearest same-trigger row ' + r.nearest.ts.slice(0, 19) + ')' : ''));
  }
  out.push('ledger rows with no transcript event: ' + c.orphans.length);
  for (const r of c.orphans) out.push('  row ' + r.ts.slice(0, 19) + ' ' + r.trigger + ' ' + String(r.summary || '').slice(0, 60).replace(/\n/g, ' '));
  out.push(c.t.stopsKnown === false
    ? 'stop hook summaries: unknown (Codex rollout does not expose stop_hook_summary; final messages are not hook evidence)'
    : 'stop hook summaries: ' + c.t.stops.length + ' [' + count(c.t.stops, (s) => s.cat) + ']');
  if (c.t.malformed) out.push('transcript coverage: ' + c.t.malformed + ' malformed line(s), counts may be incomplete');
  out.push('loop send-backs (re-entry directives injected as user lines): ' + c.t.reentries.length +
    (c.t.reentries.length ? ' at L' + c.t.reentries.map((r) => r.ln).join(',L') : ''));
  const missing = c.results.filter((r) => r.status === 'MISSING').length;
  out.push('summary: events=' + c.results.length + ' matched=' + c.results.filter((r) => r.status === 'matched').length +
    ' matched_unattributed=' + c.results.filter((r) => r.status.startsWith('matched-unattributed')).length +
    ' refused=' + c.results.filter((r) => r.status.startsWith('refused')).length +
    ' mentions=' + c.results.filter((r) => r.status.startsWith('not an invocation')).length +
    ' missing=' + missing + ' orphan_rows=' + c.orphans.length);
  return { lines: out, c };
}

// ---- sample candidates ----
function sessionsLines(ctx, limit) {
  const field = fieldOf(loadRows(ctx.periodEnd), ctx);
  const by = new Map();
  for (const r of field) {
    const id = String(r.session_id || '');
    if (!id || id === 'shell') continue;
    const ts = r.ts || '';
    let s = by.get(id);
    if (!s) { s = { id, project: r.project, first: ts, last: ts, rows: 0, passed: new Set() }; by.set(id, s); }
    s.rows += 1;
    if (ts < s.first) s.first = ts;
    if (ts >= s.last) { s.last = ts; s.project = r.project; }
    if (r.trigger === 'done-declaration' && r.gate === 'passed' && r.contract) s.passed.add(r.contract);
  }
  return [...by.values()]
    .sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
    .slice(0, limit)
    .map((s) => 'session=' + s.id + ' project=' + (s.project || 'unknown') + ' first=' + s.first + ' last=' + s.last +
      ' rows=' + s.rows + ' completions=' + s.passed.size + ' transcript=' + (transcriptsFor(s.id).length ? 'yes' : 'no'));
}

// ---- checks ----
function checkSummary(reportPath, ctx) {
  const report = fs.readFileSync(reportPath, 'utf8');
  const m = /```[^\n]*\n(period_end=[\s\S]*?)```/.exec(report);
  if (!m) { console.error('check-summary: no fenced block starting with period_end= in ' + reportPath); return 1; }
  const written = m[1].trim().split('\n');
  const periodEnd = normalizePeriodEnd(written[0].slice('period_end='.length));
  let now;
  if ((written[1] || '').startsWith('excluded_projects=')) {
    const value = written[1].slice('excluded_projects='.length).trim();
    const exclude = value === 'none' ? [] : canonicalExclude(value.split(','));
    now = summaryLines({ periodEnd, exclude });
  } else {
    // A block written before the excluded_projects line existed (audit-1):
    // the exclusions come from the --exclude flags and line 2 is not compared.
    now = summaryLines({ periodEnd, exclude: ctx.exclude });
    now.splice(1, 1);
  }
  let diff = 0;
  const max = Math.max(written.length, now.length);
  for (let i = 0; i < max; i += 1) {
    if ((written[i] || '') !== (now[i] || '')) { diff += 1; console.error('DIFF line ' + (i + 1) + '\n  report: ' + (written[i] || '') + '\n  now:    ' + (now[i] || '')); }
  }
  console.log(diff ? 'check-summary: ' + diff + ' line(s) differ' : 'check-summary: block reproduces (' + now.length + ' lines, period_end ' + periodEnd + ')');
  return diff ? 1 : 0;
}
function checkSession(prefix, ctx) {
  const c = compareSession(prefix, ctx);
  const verdicts = c.t.events.filter((e) => e.kind === 'verdict-text' || e.kind === 'marker AMBER_SKIP');
  const skipRows = c.rows.filter((r) => r.trigger === 'skip');
  const lost = verdicts.length >= 1 && skipRows.length === 0;
  console.log('check-session ' + prefix + ': opening-verdict texts in transcript=' + verdicts.length + ' (lines ' + verdicts.map((e) => e.ln).join(',') + '), skip rows in ledger=' + skipRows.length + ' -> ' + (lost ? 'LOSS DETECTED' : 'no loss'));
  return lost ? 0 : 1;
}

// ---- main ----
function main(argv) {
  const opts = parseArgs(argv);
  const [cmd, arg] = opts.positional;
  const ctx = { periodEnd: normalizePeriodEnd(opts.periodEnd), exclude: canonicalExclude(opts.exclude) };
  if (cmd === 'summary') { console.log(summaryLines(ctx).join('\n')); return 0; }
  if (cmd === 'dead') { console.log(deadLines(ctx).join('\n')); return 0; }
  if (cmd === 'sessions') {
    const limit = arg === undefined ? 20 : Number(arg);
    if (!Number.isInteger(limit) || limit < 1) throw new UsageError('sessions takes a positive count, got ' + JSON.stringify(arg));
    const lines = sessionsLines(ctx, limit);
    if (lines.length) console.log(lines.join('\n'));
    return 0;
  }
  if (cmd === 'session' && arg) { console.log(sessionLines(arg, ctx).lines.join('\n')); return 0; }
  if (cmd === 'check-summary' && arg) return checkSummary(arg, ctx);
  if (cmd === 'check-session' && arg) return checkSession(arg, ctx);
  throw new UsageError(cmd ? 'unknown or incomplete command: ' + opts.positional.join(' ') : 'no command');
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    console.error('error: ' + e.message + '\n' + USAGE);
    process.exitCode = 2;
  } else {
    console.error('error: ' + e.message);
    process.exitCode = 1;
  }
}
