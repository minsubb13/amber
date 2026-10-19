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
  /**
   * The HEAD when the run began, when the tree had one: the scope-check
   * baseline for a contract file that was never committed.
   */
  baseline_commit?: string;
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
  /** progress.json's baseline_commit, the baseline when no commit added the contract file. */
  readonly baselineCommit?: string | null;
  readonly declarations?: Declaration[];
}

/** The hook events hooks.json passes to the entry. */
export type HookEvent = 'S0' | 'S1' | 'S2' | 'S3' | 'E1';

/**
 * The fields of a hook input Amber reads, after the boundary check. The host
 * protocols send session_id, cwd and model as strings; a value of another
 * type is read as absent. Fields the original converted with String() stay
 * as found (`prompt`, `tool_input` members) and are converted where read.
 */
export interface HookInput {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly prompt?: unknown;
  readonly tool_name?: unknown;
  /** The tool's own input; an absent or non-object value reads as {}. */
  readonly tool_input: Readonly<Record<string, unknown>>;
  readonly agent_id?: unknown;
  readonly stop_hook_active?: unknown;
}

/** The two identities a ledger row and the state files are keyed by. */
export interface RecordSource {
  readonly session_id?: string | null | undefined;
  readonly cwd?: string | null | undefined;
}

/** A hook's JSON answer on stdout; null means no output. */
export type HookOutput =
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: 'SessionStart' | 'UserPromptSubmit';
        readonly additionalContext: string;
      };
    }
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: 'PreToolUse';
        readonly permissionDecision: 'deny';
        readonly permissionDecisionReason: string;
      };
    }
  | { readonly decision: 'block'; readonly reason: string }
  | null;

/** The contract the zone's pointer names, read and found sound. */
export interface ActiveContract {
  readonly root: string;
  readonly pointerPath: string;
  readonly boundaryPath: string;
  readonly boundaryFile: string;
  /** As the pointer wrote it; 'unknown' when absent. */
  readonly ratifiedBy: unknown;
  readonly ratifiedAt: unknown;
  readonly text: string;
  readonly broken: false;
}

/** A pointer whose target cannot be used; enforcement fails closed. */
export interface BrokenContract {
  readonly root: string;
  readonly pointerPath: string;
  readonly boundaryPath: null;
  readonly boundaryFile: null;
  readonly text: '';
  readonly broken: true;
  readonly error: string;
}

export type Contract = ActiveContract | BrokenContract;

/** The machine-enforced rows of a boundary document. */
export interface MachineRules {
  readonly writeScopes: string[];
  readonly bashDeny: string[];
}

/** A session's state file under <AMBER_HOME>/state/, as written. */
export interface SessionState {
  model?: unknown;
  started_at?: unknown;
  /** The boundary file this session was briefed about, or 'broken'. */
  briefed?: unknown;
  /** The boundary file of the run this session drives. */
  run?: unknown;
}

/** The completion signal `record.cjs done` writes to <zone>/.amber/done.json. */
export interface DoneSignal {
  readonly v?: unknown;
  readonly ts?: unknown;
  readonly target?: unknown;
  readonly summary: string;
  readonly review: string;
  readonly goal?: unknown;
  readonly out_of_scope?: unknown;
  readonly out_of_scope_count?: unknown;
}

/** The newest session registered to a run (record.cjs reads it back). */
export interface RunDriver {
  readonly sessionId: string;
  readonly model: unknown;
  readonly mtime: number;
}

/** A `record.cjs unit` command as a transcript shows it. */
export type UnitCall =
  'init' | 'start' | 'verified' | 'failed' | 'hold' | 'claim';

/** The cycle-event kinds of amber:mark. */
export type MarkKind = 'skip' | 'finding' | 'hold';

/**
 * The skills `record.cjs invoke` records for a host without the S3 hook
 * (Codex); mark goes through `record.cjs mark`.
 */
export type InvokedSkill = 'planning' | 'set' | 'init' | 'status' | 'audit';

/** The marker lines of the older declaration form. */
export type Marker =
  'AMBER_SKIP' | 'AMBER_DONE' | 'AMBER_GOAL' | 'AMBER_REVIEW';

/** The skills an operator can type that the ledger records. */
export type TypedSkill = 'planning' | 'init' | 'audit';

/** How a recorder call fared in the output a transcript kept. */
export type CallResult = 'accepted' | 'refused' | 'mention' | 'unobserved';

/** The ledger trigger an event should have produced. */
export type Expectation =
  | 'skill-invocation'
  | 'planning-invocation'
  | 'unit-hold'
  | 'skip'
  | 'finding'
  | `unit-${Exclude<UnitCall, 'claim'>}`
  | 'done-declaration';

/**
 * What a transcript event is, from either host's adapter. Every kind is a
 * closed set except the skill name after `skill amber:`, which stays open:
 * the Claude adapter records any amber: skill a transcript shows, as the
 * original did, so a skill added later is still counted.
 */
export type AuditEventKind =
  | `skill amber:${string}`
  | `typed amber:${TypedSkill}`
  | `mark ${MarkKind | 'malformed'}`
  | `cmd unit ${UnitCall}`
  | 'cmd done'
  | `marker ${Marker}`
  | 'verdict-text';

/**
 * An event a transcript shows that the ledger is supposed to mirror, from
 * either host's adapter. ts is the line's timestamp as the host wrote it.
 */
export interface AuditEvent {
  readonly ln: number;
  readonly ts: unknown;
  readonly kind: AuditEventKind;
  readonly expect: Expectation | null;
  readonly name?: string;
  readonly typed?: boolean;
  /** How the tool result showed a record.cjs call; set after the call. */
  result?: CallResult;
  readonly toolId?: unknown;
}

export interface ClaudeTranscript {
  readonly events: AuditEvent[];
  readonly users: number;
  readonly assistants: number;
  readonly lines: number;
  readonly cwd: unknown;
  readonly stops: {
    readonly ln: number;
    readonly ts: unknown;
    readonly cat: string;
  }[];
  readonly reentries: { readonly ln: number; readonly ts: unknown }[];
}

/** What the audit reads from a transcript of either host. */
export interface AuditTranscript {
  readonly events: readonly AuditEvent[];
  readonly users: number;
  readonly assistants: number;
  readonly lines: number;
  readonly cwd: unknown;
  readonly stops: readonly { readonly cat: string }[];
  readonly reentries: readonly { readonly ln: number }[];
  /** false for Codex rollouts, which keep no stop-hook summaries. */
  readonly stopsKnown?: boolean;
  readonly malformed?: number;
}

/** The period and exclusions every audit count is bounded by. */
export interface AuditContext {
  readonly periodEnd: string;
  readonly exclude: readonly string[];
}
