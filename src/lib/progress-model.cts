// The run state's rules without I/O: which units are open, which comes next,
// how a transition or a hold changes the state, and the summary line set the
// hooks print. The caller supplies the clock and saves the result.
//
// Unit statuses: pending | running | verified | failed | limit. Open units are
// pending, running, and failed. A plain hold is a one-shot pass consumed by
// S2; an external hold (reason starting with `external:`, kind 'external')
// stands until the held unit's next transition or a newer hold.

import type {
  Clock,
  EventExtra,
  HistoryEntry,
  Hold,
  HoldKind,
  PlanUnit,
  Progress,
  Unit,
  UnitEvent,
  UnitStatus,
} from './types.cjs';

const REENTRY_LIMIT = 10;
const HISTORY_LIMIT = 50;
// Every status is classified once, so a new status does not compile until
// it is: whether it is open, and whether the summary line lists it (in this
// order).
const OPEN: Readonly<Record<UnitStatus, boolean>> = {
  pending: true,
  running: true,
  verified: false,
  failed: true,
  limit: false,
};
const LISTED: Readonly<Record<UnitStatus, boolean>> = {
  verified: true,
  running: true,
  failed: true,
  limit: true,
  pending: false,
};
// "waiting on an external job" hold: the one place both recording paths
// (mark via S3, record.cjs unit hold) classify a reason.
const EXTERNAL_HOLD = /^\s*external:/i;

/** A transition other than a hold. */
type Transition = Exclude<UnitEvent, 'hold'>;

function holdKind(reason: string | null | undefined): HoldKind | null {
  return EXTERNAL_HOLD.test(reason || '') ? 'external' : null;
}

/** The transition an event name stands for, or null for an unknown name. */
function transitionOf(event: string): Transition | null {
  switch (event) {
    case 'start':
    case 'claim':
    case 'verified':
    case 'failed':
    case 'limit':
      return event;
    default:
      return null;
  }
}

/** A fresh state for the plan's units, before anything has run. */
function newProgress(
  units: readonly PlanUnit[],
  contract: string | null,
  plan: string,
  preexisting: unknown[],
  now: Clock,
): Progress {
  const p: Progress = {
    v: 1,
    contract,
    plan,
    created_at: now(),
    current: null,
    hold: null,
    blocks: 0,
    session_ids: [],
    // Paths already dirty when the run began (scope-check excludes them).
    preexisting,
    units: {},
  };
  for (const u of units) {
    p.units[u.id] = {
      title: u.title,
      scope: u.scope,
      after: u.after,
      oracle: u.oracle,
      status: 'pending',
      agent_id: null,
      reentries: 0,
      history: [],
    };
  }
  return p;
}

// Membership is tested on a Set, which compares values as they are: a status
// in a hand-edited file that is not one of these strings (an array that
// prints like one, an object, a number) is not open, as before.
const OPEN_STATUSES: ReadonlySet<string> = new Set(
  Object.entries(OPEN)
    .filter(([, open]) => open)
    .map(([status]) => status),
);

function isOpen(unit: Unit): boolean {
  return OPEN_STATUSES.has(unit.status);
}

function openUnits(p: Progress): string[] {
  return Object.keys(p.units).filter((id) => {
    const unit = p.units[id];
    return unit !== undefined && isOpen(unit);
  });
}

function depsMet(p: Progress, id: string): boolean {
  return (p.units[id]?.after || []).every(
    (dep) => p.units[dep]?.status === 'verified',
  );
}

/**
 * The unit S2 counts a re-entry against: the current unit while it is open,
 * otherwise the first open unit whose dependencies are met, otherwise the
 * first open unit at all.
 */
function focusUnit(p: Progress): string | null {
  const current = p.current ? p.units[p.current] : undefined;
  if (p.current && current && isOpen(current)) return p.current;
  const open = openUnits(p);
  return open.find((id) => depsMet(p, id)) || open[0] || null;
}

function readyUnits(p: Progress): string[] {
  return openUnits(p).filter(
    (id) => p.units[id]?.status !== 'running' && depsMet(p, id),
  );
}

function pushHistory(
  unit: Unit,
  entry: Omit<HistoryEntry, 'ts'>,
  now: Clock,
): void {
  unit.history.push({ ts: now(), ...entry });
  if (unit.history.length > HISTORY_LIMIT) {
    unit.history.splice(0, unit.history.length - HISTORY_LIMIT);
  }
}

function requireUnit(p: Progress, id: string): Unit {
  const unit = p.units[id];
  if (!unit) {
    throw new Error(
      'unknown unit ' +
        id +
        ' (known: ' +
        Object.keys(p.units).join(', ') +
        ')',
    );
  }
  return unit;
}

/** Applies a hold, plain or external; a new hold replaces the previous one. */
function applyHold(
  p: Progress,
  id: string | null,
  extra: EventExtra | undefined,
  by: string,
  now: Clock,
): Progress {
  const unit = id ? requireUnit(p, id) : null;
  const reason = extra?.reason || '';
  const hold: Hold = {
    unit: unit ? id : null,
    reason,
    by,
    ts: now(),
  };
  p.hold = hold;
  const kind = holdKind(reason);
  if (kind) hold.kind = kind;
  if (unit) pushHistory(unit, { event: 'hold', by, note: hold.reason }, now);
  return p;
}

function applyTransition(
  p: Progress,
  transition: Transition,
  id: string,
  unit: Unit,
  extra: EventExtra | undefined,
  by: string,
  now: Clock,
): void {
  switch (transition) {
    case 'start':
      // Re-entries reset only on an explicit restart after the limit; a unit
      // that was merely pending or failed keeps its count (the per-unit
      // counters already give a fresh count whenever the focus unit changes).
      if (unit.status === 'limit') unit.reentries = 0;
      unit.status = 'running';
      p.current = id;
      pushHistory(unit, { event: 'start', by }, now);
      return;
    case 'claim': {
      const agent = extra?.agent_id;
      if (!agent) throw new Error('claim requires an agent id');
      if (unit.agent_id && unit.agent_id !== agent) {
        throw new Error(
          'unit ' + id + ' is already claimed by agent ' + unit.agent_id,
        );
      }
      if (!isOpen(unit)) {
        throw new Error('unit ' + id + ' is ' + unit.status + ', not open');
      }
      unit.agent_id = agent;
      if (unit.status === 'pending') unit.status = 'running';
      pushHistory(unit, { event: 'claim', by: agent }, now);
      return;
    }
    case 'verified':
      unit.status = 'verified';
      unit.agent_id = null;
      pushHistory(
        unit,
        {
          event: 'verified',
          by,
          note: extra?.evidence || '',
          ...(extra?.out_of_scope ? { out_of_scope: extra.out_of_scope } : {}),
        },
        now,
      );
      return;
    case 'failed':
      unit.status = 'failed';
      pushHistory(
        unit,
        { event: 'failed', by, note: extra?.evidence || '' },
        now,
      );
      return;
    case 'limit':
      unit.status = 'limit';
      pushHistory(
        unit,
        {
          event: 'limit',
          by,
          note: 'reentry limit ' + String(REENTRY_LIMIT) + ' reached',
        },
        now,
      );
      return;
    default: {
      const unreachable: never = transition;
      throw new Error('unknown unit event ' + String(unreachable));
    }
  }
}

/** Applies one transition or hold to p and returns it; the caller saves it. */
function applyEvent(
  p: Progress,
  event: string,
  id: string | null,
  extra: EventExtra | undefined,
  now: Clock,
): Progress {
  const by = extra?.by || 'shell';
  if (event === 'hold') return applyHold(p, id, extra, by, now);
  const unit = requireUnit(p, String(id));
  const transition = transitionOf(event);
  // An external hold is released by the held unit's next transition; a plain
  // hold is consumed by S2 instead.
  if (
    p.hold?.kind === 'external' &&
    p.hold.unit === id &&
    (transition === 'start' ||
      transition === 'verified' ||
      transition === 'failed')
  ) {
    p.hold = null;
  }
  if (transition === null) throw new Error('unknown unit event ' + event);
  applyTransition(p, transition, String(id), unit, extra, by, now);
  return p;
}

function unitByAgent(p: Progress, agentId: string): string | null {
  return (
    Object.keys(p.units).find((id) => p.units[id]?.agent_id === agentId) || null
  );
}

/** The progress lines the briefings and the send-back directive print. */
function summary(p: Progress): string {
  const ids = Object.keys(p.units);
  const by = (status: string): string =>
    ids.filter((id) => p.units[id]?.status === status).join(', ') || 'none';
  const open = openUnits(p);
  const focus = focusUnit(p);
  const lines: string[] = [];
  lines.push(
    'amber progress (' +
      (p.plan || 'progress.json') +
      '): ' +
      String(open.length) +
      ' of ' +
      String(ids.length) +
      ' unit(s) open - ' +
      Object.entries(LISTED)
        .filter(([, listed]) => listed)
        .map(([status]) => status + ': ' + by(status))
        .join('; ') +
      '.',
  );
  const u = focus ? p.units[focus] : undefined;
  if (focus && u) {
    lines.push(
      'next: ' +
        focus +
        ' ' +
        u.title +
        ' [scope: ' +
        u.scope.join(', ') +
        (u.oracle ? '; oracle: ' + u.oracle : '') +
        '; re-entries: ' +
        String(u.reentries) +
        '/' +
        String(REENTRY_LIMIT) +
        ']',
    );
  }
  const ready = readyUnits(p).filter((id) => id !== focus);
  if (ready.length) {
    lines.push('also ready (dependencies met): ' + ready.join(', '));
  }
  if (p.hold) {
    lines.push(
      'hold: ' +
        (p.hold.unit || '-') +
        ' - ' +
        (p.hold.kind === 'external'
          ? 'external since ' + p.hold.ts + ' - '
          : '') +
        p.hold.reason,
    );
  }
  const sessions = Array.isArray(p.session_ids) ? p.session_ids : [];
  lines.push(
    'driving sessions: ' +
      (sessions.length ? sessions.join(', ') : 'none registered yet'),
  );
  return lines.join('\n');
}

export = {
  REENTRY_LIMIT,
  holdKind,
  newProgress,
  openUnits,
  focusUnit,
  readyUnits,
  applyEvent,
  unitByAgent,
  summary,
};
