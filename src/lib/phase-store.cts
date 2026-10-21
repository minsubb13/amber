// The session phase's I/O: entered on a planning or set record (S3, S1 - on
// both hosts, since the Codex recorder runs S3), read for the gate (E1) and
// the briefing (S0), cleared on a release - a skip record (S3), the pointer
// found by E1 (approval), the contract released by S2 - with a phase-exit
// ledger row naming the paths changed meanwhile by means the gate does not
// see. The rules live in phase.cjs.

import clock = require('./clock.cjs');
import git = require('./git.cjs');
import guards = require('./guards.cjs');
import ledger = require('./ledger.cjs');
import phase = require('./phase.cjs');
import scope = require('./scope.cjs');
import state = require('./state-store.cjs');
import zone = require('./zone.cjs');
import type {
  PhaseExit,
  PhaseState,
  RecordSource,
  SessionPhase,
} from './types.cjs';

/**
 * The zone's `git status --porcelain` paths with every untracked file named
 * (an untracked directory would otherwise hide the artifacts inside it, as
 * the scope check reads it), or null when git fails (no repository, a
 * timeout) or the list is longer than SNAPSHOT_MAX.
 */
function statusPaths(root: string): string[] | null {
  try {
    const paths = scope.statusPaths(
      git.git(root, ['status', '--porcelain', '-z', '--untracked-files=all']),
    );
    return paths.length > phase.SNAPSHOT_MAX ? null : paths;
  } catch {
    return null;
  }
}

/** The session's phase, or null without a sound one. */
function phaseOf(sessionId: unknown): SessionPhase | null {
  const sessionState = state.readSessionState(sessionId);
  return phase.readPhase(
    guards.isObject(sessionState) ? sessionState['phase'] : undefined,
  );
}

/**
 * Enters `next` for the session in the zone of its cwd. A phase already open
 * in that zone keeps its start and snapshot (set follows planning; a
 * repeated planning record does not hide what the first one saw); otherwise
 * the snapshot is taken now.
 */
function enter(source: RecordSource, next: PhaseState): void {
  const root = zone.zoneRoot(source.cwd);
  const current = phaseOf(source.session_id);
  const open = current && current.zone === root ? current : null;
  const entered: SessionPhase = {
    state: next,
    zone: root,
    since: open ? open.since : clock.isoNow(),
    snapshot: open ? open.snapshot : statusPaths(root),
  };
  const stateFile = state.sessionStatePath(source.session_id);
  const sessionState = state.readJsonOrEmpty(stateFile);
  guards.writeField(sessionState, 'phase', entered);
  state.ensureDirs();
  state.writeStateAtomic(stateFile, sessionState);
}

/**
 * Clears the session's phase when it is open in `root` and records the
 * phase-exit row: how it ended and the paths changed since the entry outside
 * planning artifacts (CHANGED_MAX of them, the count beside), or null when
 * unknown. Nothing happens, and false is returned, without such a phase.
 */
function exit(source: RecordSource, root: string, how: PhaseExit): boolean {
  const current = phaseOf(source.session_id);
  if (!current || current.zone !== root) return false;
  const stateFile = state.sessionStatePath(source.session_id);
  const sessionState = state.readJsonOrEmpty(stateFile);
  guards.deleteField(sessionState, 'phase');
  state.writeStateAtomic(stateFile, sessionState);
  const changed = phase.changedSince(current.snapshot, statusPaths(root));
  ledger.appendRecord(
    source,
    phase.exitSummary(current, how, changed),
    {
      phase: current.state,
      since: current.since,
      exit: how,
      changed: changed === null ? null : changed.slice(0, phase.CHANGED_MAX),
      changed_count: changed === null ? null : changed.length,
    },
    'phase-exit',
  );
  return true;
}

export = { phaseOf, enter, exit };
