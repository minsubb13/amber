// Matching a session's transcript events with its ledger rows, and the
// session and check reports, without I/O.

import audit = require('./audit-report.cjs');
import guards = require('./guards.cjs');
import type { AuditEvent, AuditTranscript, CallResult } from './types.cjs';

/** What the comparison found for an event. */
type MatchStatus =
  | 'MISSING'
  | 'matched'
  | 'matched-unattributed (row says session "shell")'
  | 'unobservable (command outcome absent or ambiguous)'
  | 'not an invocation (command text only mentions record.cjs)'
  | 'refused by the command (no row by design)'
  | 'n/a (no row by design)';

const { readField: field, toText } = guards;

const MATCH_WINDOW_MS = 15 * 60 * 1000;
const TYPED_ROW = / \(typed\)$/;

/** A transcript event and what the comparison found for it. */
interface EventResult {
  readonly ev: AuditEvent;
  status: MatchStatus;
  row?: unknown;
  gapS?: number;
  nearest?: unknown;
}

interface SessionComparison {
  readonly t: AuditTranscript;
  readonly rows: readonly unknown[];
  readonly results: readonly EventResult[];
  readonly orphans: readonly unknown[];
}

/**
 * `value.slice(start, end)` for a field that should hold text: a missing
 * value fails with the engine's TypeError, as the original's report did. A
 * non-string value, which no writer produces, is read as its text where the
 * original failed calling slice on it (coverage document, known differences).
 */
function sliceText(value: unknown, start: number, end: number): string {
  if (value === null || value === undefined) guards.readField(value, 'slice');
  return toText(value).slice(start, end);
}

function gapOf(row: unknown, ev: AuditEvent): number {
  return Math.abs(
    (Date.parse(toText(field(row, 'ts'))) || 0) -
      (Date.parse(toText(ev.ts || '')) || 0),
  );
}

function initialStatus(ev: AuditEvent): MatchStatus {
  const result: CallResult | undefined = ev.result;
  switch (result) {
    case 'unobserved':
      return 'unobservable (command outcome absent or ambiguous)';
    case 'mention':
      return 'not an invocation (command text only mentions record.cjs)';
    case 'refused':
      // A refused command wrote no row, so it must not take the row of the
      // accepted call that followed it.
      return 'refused by the command (no row by design)';
    case 'accepted':
    case undefined:
      return ev.expect ? 'MISSING' : 'n/a (no row by design)';
  }
}

/**
 * Closest pairs first (same trigger, inside the window), so an earlier call
 * cannot take the row that a later, closer call produced.
 */
function assign(
  candidates: readonly EventResult[],
  list: readonly unknown[],
  used: Set<number>,
  status: MatchStatus,
): void {
  const pairs: { r: EventResult; i: number; gap: number }[] = [];
  for (const r of candidates) {
    list.forEach((row, i) => {
      if (used.has(i) || field(row, 'trigger') !== r.ev.expect) return;
      const summary = toText(field(row, 'summary') || '');
      if (r.ev.name && !summary.startsWith(r.ev.name)) return;
      if (
        r.ev.typed !== undefined &&
        TYPED_ROW.test(summary) !== r.ev.typed &&
        r.ev.expect === 'skill-invocation'
      ) {
        return;
      }
      const gap = gapOf(row, r.ev);
      if (gap <= MATCH_WINDOW_MS) pairs.push({ r, i, gap });
    });
  }
  pairs.sort((a, b) => a.gap - b.gap || a.r.ev.ln - b.r.ev.ln || a.i - b.i);
  for (const p of pairs) {
    if (p.r.status !== 'MISSING' || used.has(p.i)) continue;
    used.add(p.i);
    Object.assign(p.r, {
      status,
      row: list[p.i],
      gapS: Math.round(p.gap / 1000),
    });
  }
}

/**
 * The session's events against its rows. Unit rows written from a shell
 * without a session id carry session "shell"; they are matched by zone and
 * time instead, and reported as unattributed.
 */
function compareSession(
  t: AuditTranscript,
  rows: readonly unknown[],
  shellRows: readonly unknown[],
): SessionComparison {
  const used = new Set<number>();
  const usedShell = new Set<number>();
  const results: EventResult[] = t.events.map((ev) => ({
    ev,
    status: initialStatus(ev),
  }));
  const pending = (): EventResult[] =>
    results.filter((r) => r.status === 'MISSING');
  assign(pending(), rows, used, 'matched');
  assign(
    pending().filter((r) => /^unit-/.test(toText(r.ev.expect))),
    shellRows,
    usedShell,
    'matched-unattributed (row says session "shell")',
  );
  // A hint only: the closest same-trigger row of the session, taken or not.
  for (const r of pending()) {
    let bestGap = Infinity;
    r.nearest = null;
    for (const row of rows) {
      if (field(row, 'trigger') !== r.ev.expect) continue;
      const gap = gapOf(row, r.ev);
      if (gap < bestGap) {
        bestGap = gap;
        r.nearest = row;
      }
    }
  }
  const orphans = rows.filter((_r, i) => !used.has(i));
  return { t, rows, results, orphans };
}

function startsWithStatus(
  results: readonly EventResult[],
  prefix: string,
): number {
  return results.filter((r) => r.status.startsWith(prefix)).length;
}

/** The session report; transcriptShown is the transcript path as printed. */
function sessionLines(
  prefix: string,
  transcriptShown: string,
  c: SessionComparison,
): string[] {
  const out: string[] = [];
  out.push(
    'session ' +
      prefix +
      ' transcript=' +
      transcriptShown +
      ' lines=' +
      String(c.t.lines) +
      ' user_msgs=' +
      String(c.t.users) +
      ' assistant_msgs=' +
      String(c.t.assistants),
  );
  out.push(
    'ledger rows for session (<= period_end): ' +
      String(c.rows.length) +
      ' [' +
      audit.count(c.rows, (r) => field(r, 'trigger')) +
      ']',
  );
  out.push('transcript events -> ledger:');
  for (const r of c.results) {
    out.push(
      '  L' +
        String(r.ev.ln) +
        ' ' +
        sliceText(r.ev.ts || '', 0, 19) +
        ' ' +
        r.ev.kind +
        ' -> ' +
        (r.ev.expect || '-') +
        ': ' +
        r.status +
        (r.row
          ? ' (row ' +
            sliceText(field(r.row, 'ts'), 11, 19) +
            ', +' +
            String(r.gapS) +
            's)'
          : '') +
        (r.status === 'MISSING' && r.nearest
          ? ' (nearest same-trigger row ' +
            sliceText(field(r.nearest, 'ts'), 0, 19) +
            ')'
          : ''),
    );
  }
  out.push('ledger rows with no transcript event: ' + String(c.orphans.length));
  for (const r of c.orphans) {
    out.push(
      '  row ' +
        sliceText(field(r, 'ts'), 0, 19) +
        ' ' +
        toText(field(r, 'trigger')) +
        ' ' +
        toText(field(r, 'summary') || '')
          .slice(0, 60)
          .replace(/\n/g, ' '),
    );
  }
  out.push(
    c.t.stopsKnown === false
      ? 'stop hook summaries: unknown (Codex rollout does not expose stop_hook_summary; final messages are not hook evidence)'
      : 'stop hook summaries: ' +
          String(c.t.stops.length) +
          ' [' +
          audit.count(c.t.stops, (s) => field(s, 'cat')) +
          ']',
  );
  if (c.t.malformed) {
    out.push(
      'transcript coverage: ' +
        String(c.t.malformed) +
        ' malformed line(s), counts may be incomplete',
    );
  }
  out.push(
    'loop send-backs (re-entry directives injected as user lines): ' +
      String(c.t.reentries.length) +
      (c.t.reentries.length
        ? ' at L' + c.t.reentries.map((r) => r.ln).join(',L')
        : ''),
  );
  const missing = c.results.filter((r) => r.status === 'MISSING').length;
  out.push(
    'summary: events=' +
      String(c.results.length) +
      ' matched=' +
      String(c.results.filter((r) => r.status === 'matched').length) +
      ' matched_unattributed=' +
      String(startsWithStatus(c.results, 'matched-unattributed')) +
      ' refused=' +
      String(startsWithStatus(c.results, 'refused')) +
      ' mentions=' +
      String(startsWithStatus(c.results, 'not an invocation')) +
      ' missing=' +
      String(missing) +
      ' orphan_rows=' +
      String(c.orphans.length),
  );
  return out;
}

/**
 * check-session: whether an opening verdict the transcript shows has no skip
 * row (a loss), and the line that says so.
 */
function sessionLoss(
  prefix: string,
  c: SessionComparison,
): { lost: boolean; line: string } {
  const verdicts = c.t.events.filter(
    (e) => e.kind === 'verdict-text' || e.kind === 'marker AMBER_SKIP',
  );
  const skipRows = c.rows.filter((r) => field(r, 'trigger') === 'skip');
  const lost = verdicts.length >= 1 && skipRows.length === 0;
  return {
    lost,
    line:
      'check-session ' +
      prefix +
      ': opening-verdict texts in transcript=' +
      String(verdicts.length) +
      ' (lines ' +
      verdicts.map((e) => e.ln).join(',') +
      '), skip rows in ledger=' +
      String(skipRows.length) +
      ' -> ' +
      (lost ? 'LOSS DETECTED' : 'no loss'),
  };
}

/** check-summary: the DIFF messages between the report's block and now. */
function blockDifferences(
  written: readonly string[],
  now: readonly string[],
): string[] {
  const diffs: string[] = [];
  const max = Math.max(written.length, now.length);
  for (let i = 0; i < max; i += 1) {
    const before = written[i] || '';
    const after = now[i] || '';
    if (before !== after) {
      diffs.push(
        'DIFF line ' +
          String(i + 1) +
          '\n  report: ' +
          before +
          '\n  now:    ' +
          after,
      );
    }
  }
  return diffs;
}

export = { compareSession, sessionLines, sessionLoss, blockDifferences };
