// A session's pre-approval phase - planning or set - and the gate it puts on
// file-tool writes in its zone, without I/O: the phase read from a state
// file, the planning artifacts the gate lets through, the verdict on one
// write target, the paths a phase changed by other means, and the texts.
// phase-store enters, reads and clears the phase for the hooks. Borrowed from
// pi's plan mode, which removes the write tools while a plan is open; a host
// plugin cannot remove tools, so the same state refuses the calls instead.

import path = require('node:path');

import glob = require('./glob.cjs');
import guards = require('./guards.cjs');
import type { PhaseExit, PhaseState, SessionPhase } from './types.cjs';

/**
 * What planning and set write: contracts, plans, check scripts, review
 * verdicts and mission documents, anywhere in the zone. Matched by file name
 * so a project's own docs/ or contracts/ layout needs no configuration.
 */
const ARTIFACT_PATTERNS: readonly string[] = [
  '**/*-contract.md',
  '**/*-plan.md',
  '**/*-check.sh',
  '**/*-review*.md',
  '**/missions/*.md',
];

/** More status paths than this and the snapshot is null: changes unknown. */
const SNAPSHOT_MAX = 2000;
/**
 * What a phase-exit row lists of the changed paths: at most CHANGED_MAX of
 * them and at most CHANGED_BYTES as a JSON array, so the row stays well
 * inside the ledger's line cap (4096 bytes, past which a row is dropped)
 * beside its cwd and summary; changed_count keeps the total.
 */
const CHANGED_MAX = 50;
const CHANGED_BYTES = 1500;

/** The verdict on one write target while a phase is open. */
type Verdict = 'allow' | 'state' | 'deny';

function phaseStateOf(value: unknown): PhaseState | null {
  return value === 'planning' || value === 'set' ? value : null;
}

/** The phase a state file's `phase` field holds, or null when it is not one. */
function readPhase(value: unknown): SessionPhase | null {
  if (!guards.isObject(value)) return null;
  const state = phaseStateOf(value['state']);
  const zone = value['zone'];
  const since = value['since'];
  if (!state || typeof zone !== 'string' || typeof since !== 'string') {
    return null;
  }
  const snapshot = value['snapshot'];
  return {
    state,
    zone,
    since,
    snapshot: Array.isArray(snapshot)
      ? snapshot.filter((p): p is string => typeof p === 'string')
      : null,
  };
}

/** Whether a zone-relative path is a planning artifact. */
function isArtifact(rel: string): boolean {
  return glob.inScopes(rel, ARTIFACT_PATTERNS);
}

/**
 * The gate's verdict on one zone-relative write target, in this order: a
 * path outside the zone passes (the gate guards this zone only); .amber/ is
 * the run's state and refused, as under a contract, before the artifact
 * patterns can match a draft kept there; a planning artifact passes; any
 * other path in the zone is refused.
 */
function verdict(rel: string): Verdict {
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'allow';
  if (rel === '.amber' || rel.startsWith('.amber/')) return 'state';
  if (isArtifact(rel)) return 'allow';
  return 'deny';
}

/**
 * The paths a phase changed by means the gate does not see (shell writes):
 * the zone's status paths at the exit minus those at the entry, minus
 * planning artifacts and the run's own .amber/ state, sorted. Null when
 * either side is unknown.
 */
function changedSince(
  snapshot: readonly string[] | null,
  now: readonly string[] | null,
): string[] | null {
  if (!snapshot || !now) return null;
  const before = new Set(snapshot);
  return now
    .filter(
      (p) =>
        !before.has(p) &&
        !isArtifact(p) &&
        p !== '.amber' &&
        !p.startsWith('.amber/'),
    )
    .sort();
}

/**
 * The prefix of the sorted changed paths a phase-exit row lists: CHANGED_MAX
 * paths at most, and no more than fit CHANGED_BYTES as a JSON array.
 */
function fitChanged(changed: readonly string[]): string[] {
  const listed: string[] = [];
  let bytes = 2; // the brackets
  for (const p of changed.slice(0, CHANGED_MAX)) {
    const item = Buffer.byteLength(JSON.stringify(p)) + (listed.length ? 1 : 0);
    if (bytes + item > CHANGED_BYTES) break;
    bytes += item;
    listed.push(p);
  }
  return listed;
}

function artifactList(): string {
  return ARTIFACT_PATTERNS.join(', ');
}

/** The two ways out of an open phase, closing every refusal. */
function waysOut(recordCli: string): string {
  return (
    'To close the cycle: record the no-contract verdict with the amber:mark ' +
    'skill (`skip - opening verdict - no contract: <reason>`; on Codex and pi `node ' +
    recordCli +
    " mark skip 'opening verdict - no contract: <reason>'`), or finish set " +
    "and wait for the operator's approval - the pointer it creates releases " +
    'this gate.'
  );
}

/** The refusal of a write outside planning artifacts while a phase is open. */
function denyText(phase: SessionPhase, rel: string, recordCli: string): string {
  return (
    phase.state +
    ' phase open since ' +
    phase.since +
    ': write target ' +
    rel +
    ' is not a planning artifact (' +
    artifactList() +
    '). Until the cycle closes, file tools write only those in this zone. ' +
    waysOut(recordCli)
  );
}

/** The refusal of a write under .amber/ while a phase is open. */
function stateDenyText(
  phase: SessionPhase,
  rel: string,
  recordCli: string,
): string {
  return (
    phase.state +
    ' phase open since ' +
    phase.since +
    ': ' +
    rel +
    " is the run's state under .amber/, written only by `node " +
    recordCli +
    '` and the hooks. ' +
    waysOut(recordCli)
  );
}

/** S0's line for a phase carried into a resumed session of the same zone. */
function briefLine(phase: SessionPhase): string {
  return (
    'amber: ' +
    phase.state +
    ' phase since ' +
    phase.since +
    ' is still open in this zone: file writes outside planning artifacts (' +
    artifactList() +
    ') stay blocked until a skip record (amber:mark) or an approved ' +
    'contract closes it.'
  );
}

/** The phase-exit row's summary. */
function exitSummary(
  phase: SessionPhase,
  exit: PhaseExit,
  changed: readonly string[] | null,
): string {
  return (
    phase.state +
    ' phase exit (' +
    exit +
    '): ' +
    (changed === null
      ? 'changes unknown'
      : String(changed.length) + ' path(s) changed outside planning artifacts')
  );
}

export = {
  ARTIFACT_PATTERNS,
  SNAPSHOT_MAX,
  CHANGED_MAX,
  CHANGED_BYTES,
  readPhase,
  isArtifact,
  verdict,
  changedSince,
  fitChanged,
  denyText,
  stateDenyText,
  briefLine,
  exitSummary,
};
