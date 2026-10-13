// Read-only audit helper. It reads the operator-global ledger, Claude Code /
// Codex session transcripts and an audit report, and writes nothing. Every
// count is bounded by --period-end so a live run elsewhere cannot change a
// number after it was written into a report; --exclude drops a project (for
// example the zone where Amber develops itself) from the field rows.
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
// default none). Inputs: ${AMBER_HOME:-~/.amber}/runs.jsonl and the explicit
// transcript root AMBER_TRANSCRIPTS, or both hosts' default roots. A missing
// ledger is zero rows; a missing transcript is an error (exit 1).
//
// This entry does the reading; the counts, matching and report lines live in
// lib/audit-report, lib/audit-match and the two transcript adapters.

import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');

import audit = require('../lib/audit-report.cjs');
import claude = require('../lib/claude-transcript.cjs');
import clock = require('../lib/clock.cjs');
import guards = require('../lib/guards.cjs');
import match = require('../lib/audit-match.cjs');
import codex = require('./audit-codex.cjs');
import type { AuditContext, AuditTranscript } from '../lib/types.cjs';

const HOME = os.homedir();
const AMBER_HOME = process.env['AMBER_HOME'] || path.join(HOME, '.amber');
const LEDGER = path.join(AMBER_HOME, 'runs.jsonl');
const CODEX_HOME = process.env['CODEX_HOME'] || path.join(HOME, '.codex');
const TRANSCRIPT_ROOTS = process.env['AMBER_TRANSCRIPTS']
  ? [process.env['AMBER_TRANSCRIPTS']]
  : [
      path.join(HOME, '.claude', 'projects'),
      path.join(CODEX_HOME, 'sessions'),
      path.join(CODEX_HOME, 'archived_sessions'),
    ];
const PROJECTS = TRANSCRIPT_ROOTS.join(', ');
const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const ROLLOUT_NAME = /^rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i;

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

/** A command line the audit cannot run; exit code 2 with the usage. */
class UsageError extends Error {}

interface Options {
  periodEnd: string | null;
  readonly exclude: string[];
  readonly positional: string[];
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { periodEnd: null, exclude: [], positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '--period-end' || a === '--exclude') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(a + ' needs a value');
      }
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

/** The period end as a millisecond ISO instant; now when not given. */
function normalizePeriodEnd(value: string | null | undefined): string {
  const ms =
    value === null || value === undefined ? clock.nowMs() : Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new UsageError(
      '--period-end needs an ISO date-time, got ' + JSON.stringify(value),
    );
  }
  return new Date(ms).toISOString();
}

/** The ledger's rows up to the period end; a missing ledger is zero rows. */
function loadRows(periodEnd: string): unknown[] {
  let text: string;
  try {
    text = fs.readFileSync(LEDGER, 'utf8');
  } catch (err) {
    if (guards.readField(err, 'code') === 'ENOENT') return [];
    throw err;
  }
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A malformed line is a finding, counted by the summary.
      rows.push({ malformed: true });
    }
  }
  return audit.inPeriod(rows, periodEnd);
}

function skillNames(): string[] {
  try {
    return fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function failuresFilePresent(): boolean {
  return fs.existsSync(path.join(AMBER_HOME, 'state', 'sensor-failures.log'));
}

/** Transcript files whose session id starts with prefix, under every root. */
function transcriptsFor(prefix: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('-tmp-')) walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const rollout = ROLLOUT_NAME.exec(entry.name);
        const id = rollout ? (rollout[1] ?? '') : entry.name.slice(0, -6);
        if (id.startsWith(prefix)) hits.push(full);
      }
    }
  };
  for (const root of TRANSCRIPT_ROOTS) walk(root);
  return [...new Set(hits)];
}

function findTranscript(prefix: string): string {
  const hits = transcriptsFor(prefix);
  const [only] = hits;
  if (hits.length === 1 && only !== undefined) return only;
  if (hits.length === 0) {
    throw new Error(
      'transcript for ' +
        prefix +
        ': no <id>*.jsonl under ' +
        PROJECTS +
        ' (no Claude Code or Codex transcript on this machine for that session; set AMBER_TRANSCRIPTS to another root)',
    );
  }
  throw new Error(
    'transcript for ' +
      prefix +
      ': ' +
      String(hits.length) +
      ' candidates ' +
      hits.join(', ') +
      ' - use a longer prefix',
  );
}

function transcriptEvents(file: string): AuditTranscript {
  if (path.basename(file).startsWith('rollout-'))
    return codex.codexEvents(file);
  return claude.parseClaudeTranscript(fs.readFileSync(file, 'utf8'));
}

function compareSession(
  prefix: string,
  ctx: AuditContext,
): { file: string; c: ReturnType<typeof match.compareSession> } {
  const file = findTranscript(prefix);
  const t = transcriptEvents(file);
  const rows = loadRows(ctx.periodEnd).filter(
    (r) =>
      !audit.isMalformed(r) &&
      guards.toText(guards.readField(r, 'session_id') || '').startsWith(prefix),
  );
  const shellRows = loadRows(ctx.periodEnd).filter(
    (r) =>
      !audit.isMalformed(r) &&
      guards.readField(r, 'session_id') === 'shell' &&
      t.cwd &&
      guards.readField(r, 'cwd') === t.cwd,
  );
  return { file, c: match.compareSession(t, rows, shellRows) };
}

function summaryLines(ctx: AuditContext): string[] {
  return audit.summaryLines(loadRows(ctx.periodEnd), ctx);
}

function checkSummary(reportPath: string, ctx: AuditContext): number {
  const report = fs.readFileSync(reportPath, 'utf8');
  const m = /```[^\n]*\n(period_end=[\s\S]*?)```/.exec(report);
  if (!m) {
    console.error(
      'check-summary: no fenced block starting with period_end= in ' +
        reportPath,
    );
    return 1;
  }
  const written = (m[1] ?? '').trim().split('\n');
  const periodEnd = normalizePeriodEnd(
    (written[0] ?? '').slice('period_end='.length),
  );
  let now: string[];
  const second = written[1] || '';
  if (second.startsWith('excluded_projects=')) {
    const value = second.slice('excluded_projects='.length).trim();
    const exclude =
      value === 'none' ? [] : audit.canonicalExclude(value.split(','));
    now = summaryLines({ periodEnd, exclude });
  } else {
    // A block written before the excluded_projects line existed (audit-1):
    // the exclusions come from the --exclude flags and line 2 is not compared.
    now = summaryLines({ periodEnd, exclude: ctx.exclude });
    now.splice(1, 1);
  }
  const diffs = match.blockDifferences(written, now);
  for (const diff of diffs) console.error(diff);
  console.log(
    diffs.length
      ? 'check-summary: ' + String(diffs.length) + ' line(s) differ'
      : 'check-summary: block reproduces (' +
          String(now.length) +
          ' lines, period_end ' +
          periodEnd +
          ')',
  );
  return diffs.length ? 1 : 0;
}

function main(argv: readonly string[]): number {
  const opts = parseArgs(argv);
  const [cmd, arg] = opts.positional;
  const ctx: AuditContext = {
    periodEnd: normalizePeriodEnd(opts.periodEnd),
    exclude: audit.canonicalExclude(opts.exclude),
  };
  if (cmd === 'summary') {
    console.log(summaryLines(ctx).join('\n'));
    return 0;
  }
  if (cmd === 'dead') {
    const rowsInField = audit.fieldOf(loadRows(ctx.periodEnd), ctx);
    console.log(
      audit
        .deadLines(ctx, rowsInField, skillNames(), failuresFilePresent())
        .join('\n'),
    );
    return 0;
  }
  if (cmd === 'sessions') {
    const limit = arg === undefined ? 20 : Number(arg);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new UsageError(
        'sessions takes a positive count, got ' + JSON.stringify(arg),
      );
    }
    const samples = audit.sessionSamples(
      audit.fieldOf(loadRows(ctx.periodEnd), ctx),
      limit,
    );
    const lines = samples.map((s) =>
      audit.sessionSampleLine(s, transcriptsFor(s.id).length > 0),
    );
    if (lines.length) console.log(lines.join('\n'));
    return 0;
  }
  if (cmd === 'session' && arg) {
    const { file, c } = compareSession(arg, ctx);
    console.log(match.sessionLines(arg, file.replace(HOME, '~'), c).join('\n'));
    return 0;
  }
  if (cmd === 'check-summary' && arg) return checkSummary(arg, ctx);
  if (cmd === 'check-session' && arg) {
    const { c } = compareSession(arg, ctx);
    const { lost, line } = match.sessionLoss(arg, c);
    console.log(line);
    return lost ? 0 : 1;
  }
  throw new UsageError(
    cmd
      ? 'unknown or incomplete command: ' + opts.positional.join(' ')
      : 'no command',
  );
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  const message = guards.toText(guards.isObject(e) ? e['message'] : undefined);
  if (e instanceof UsageError) {
    console.error('error: ' + message + '\n' + USAGE);
    process.exitCode = 2;
  } else {
    console.error('error: ' + message);
    process.exitCode = 1;
  }
}
