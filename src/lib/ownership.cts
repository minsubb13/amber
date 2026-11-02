// Session binding: a run belongs to the sessions that drive it. The recorder
// registers the session its environment names when that session runs a unit
// command or the completion signal in a zone; the loop body and the
// completion gate act only for registered sessions, so a sibling session in
// the same zone (a discussion, another task) is neither sent back nor allowed
// to close the run. Boundary enforcement stays zone-wide. The registration
// lives in the session state (source of truth): `runs` maps each zone root
// the session drives to that zone's boundary file and the time of the
// session's last unit or done command there, so one session can drive its
// own zone and a linked worktree outside it. It is mirrored into
// progress.json's session_ids for the briefing.

import fs = require('node:fs');
import path = require('node:path');

import clock = require('./clock.cjs');
import guards = require('./guards.cjs');
import model = require('./progress-model.cjs');
import store = require('./progress-store.cjs');
import state = require('./state-store.cjs');
import type { ActiveContract, Contract, RunRegistration } from './types.cjs';

/** A zone root as a `runs` key: absolute, symbolic links left unresolved. */
function runKey(root: string): string {
  return path.resolve(root);
}

/** Whether the session drives the run; without a sound contract, every session does. */
function ownsRun(
  sessionId: string | undefined,
  contract: Contract | null,
): boolean {
  if (!contract || contract.broken) return true;
  const sessionState = state.readSessionState(sessionId);
  const runs = guards.readField(sessionState, 'runs');
  if (guards.isObject(runs)) {
    const entry = runs[runKey(contract.root)];
    return guards.isObject(entry) && entry['run'] === contract.boundaryFile;
  }
  // A state file written before `runs` existed names one boundary file and
  // no zone, so it owns any run with that file. It is never written again
  // and lapses with the state file, 48 hours after the session's last use.
  return guards.readField(sessionState, 'run') === contract.boundaryFile;
}

/**
 * Registers the session as a driver of the zone's run: records the boundary
 * file and the current time under the zone root in the session's `runs`, and
 * mirrors the session into progress.json's session_ids. The recorder calls
 * it once a unit or done command has passed its own checks.
 */
function registerSession(
  sessionId: string,
  contract: Pick<ActiveContract, 'root' | 'boundaryFile'>,
): void {
  const sessionState = state.readSessionState(sessionId);
  const found = guards.readField(sessionState, 'runs');
  const runs: Record<string, unknown> = guards.isObject(found) ? found : {};
  const entry: RunRegistration = {
    run: contract.boundaryFile,
    at: clock.isoNow(),
  };
  runs[runKey(contract.root)] = entry;
  guards.writeField(sessionState, 'runs', runs);
  state.ensureDirs();
  state.writeStateAtomic(state.sessionStatePath(sessionId), sessionState);
  const p = store.loadProgress(contract.root);
  if (p && !model.isBroken(p)) {
    const sessions = Array.isArray(p.session_ids) ? p.session_ids : [];
    p.session_ids = sessions;
    if (!sessions.includes(sessionId)) {
      sessions.push(sessionId);
      store.saveProgress(contract.root, p, clock.isoNow);
    }
  }
}

/**
 * The zones the session's `runs` registers, newest `at` first: each zone
 * root with the boundary file and time recorded there. A zone whose .amber
 * directory is gone (a removed worktree) is left out; a pre-upgrade single
 * `run` names no zone and is not listed.
 */
function registeredRuns(
  sessionId: string | undefined,
): { root: string; run: string; at: string }[] {
  const runs = guards.readField(state.readSessionState(sessionId), 'runs');
  if (!guards.isObject(runs)) return [];
  const out: { root: string; run: string; at: string }[] = [];
  for (const [root, entry] of Object.entries(runs)) {
    if (!guards.isObject(entry)) continue;
    const run = entry['run'];
    if (typeof run !== 'string' || !run) continue;
    if (!fs.existsSync(path.join(root, '.amber'))) continue;
    const at = entry['at'];
    out.push({ root, run, at: typeof at === 'string' ? at : '' });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export = { ownsRun, registerSession, registeredRuns };
