// The plugin's domain types for the run state (.amber/progress.json), the
// plan's unit rows, and the post-hoc scope check. Types only; the values
// live in the modules that use them.
//
// The shapes describe what the plugin writes. Where the original code read a
// field defensively (a unit without `after`, a non-array `session_ids` or
// `preexisting`), the field is optional or unknown here, so the code that
// reads it has to keep that defense.

/** A unit's state. Open units are pending, running and failed. */
export type UnitStatus =
  'pending' | 'running' | 'verified' | 'failed' | 'limit';

/** A transition of a unit, or a hold, as `record.cjs unit` and the hooks apply it. */
export type UnitEvent =
  'hold' | 'start' | 'claim' | 'verified' | 'failed' | 'limit';

/** A hold whose reason starts with `external:` waits on an external job. */
export type HoldKind = 'external';

/** One `- [ ] U<n> <title> [unit: ...]` row of a plan. */
export interface PlanUnit {
  readonly id: string;
  readonly title: string;
  readonly scope: string[];
  readonly after: string[];
  readonly oracle: string;
}

export interface HistoryEntry {
  ts: string;
  event: UnitEvent;
  by: string;
  note?: string;
  out_of_scope?: unknown;
}

export interface Unit {
  title: string;
  scope: string[];
  after?: string[];
  oracle: string;
  status: UnitStatus;
  agent_id: string | null;
  reentries: number;
  history: HistoryEntry[];
}

export interface Hold {
  unit: string | null;
  reason: string;
  by: string;
  ts: string;
  kind?: HoldKind;
}

/**
 * .amber/progress.json. The CommonJS hook and recorder mutate the object they
 * get back (re-entry counts, registered sessions), so the fields stay
 * writable.
 */
export interface Progress {
  v: number;
  contract: string | null;
  plan: string;
  created_at: string;
  current: string | null;
  hold: Hold | null;
  blocks: number;
  session_ids?: unknown;
  preexisting: unknown[];
  units: Record<string, Unit>;
  updated_at?: string;
}

/** What loadProgress returns for a file it cannot use. */
export interface BrokenProgress {
  readonly broken: true;
  readonly error: string;
  readonly file: string;
}

/** Optional fields of a transition, as the callers pass them. */
export interface EventExtra {
  readonly by?: string;
  readonly reason?: string;
  readonly agent_id?: string;
  readonly evidence?: string;
  readonly out_of_scope?: unknown;
}

/** Returns the current time as an ISO string. */
export type Clock = () => string;

/** One `--out-of-scope <path>=<reason>` declaration. */
export interface Declaration {
  readonly path: string;
  readonly reason: string;
}

export type ChangeKind = 'committed' | 'working-tree';

export interface ChangedPath {
  readonly path: string;
  readonly kind: ChangeKind;
}

export interface DeclaredPath {
  readonly path: string;
  readonly reason: string;
}

export interface ScopeResult {
  readonly baseline: string | null;
  readonly changed: ChangedPath[];
  readonly outside: ChangedPath[];
  readonly declared: DeclaredPath[];
  readonly undeclared: ChangedPath[];
}

export interface ScopeCheckOptions {
  readonly cwd: string;
  readonly writeScopes: string[];
  readonly boundaryRel?: string | null;
  readonly preexisting?: unknown[] | null;
  readonly declarations?: Declaration[];
}
