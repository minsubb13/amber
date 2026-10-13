// Session binding: a run belongs to the sessions that drive it. E1 registers
// a session when it runs a unit command or the completion signal itself; the
// loop body and the completion gate act only for registered sessions, so a
// sibling session in the same zone (a discussion, another task) is neither
// sent back nor allowed to close the run. Boundary enforcement stays
// zone-wide. The registration lives in the session state (source of truth,
// keyed to the boundary file) and is mirrored into progress.json's
// session_ids for the briefing.

import fs = require('node:fs');
import path = require('node:path');

import clock = require('./clock.cjs');
import guards = require('./guards.cjs');
import model = require('./progress-model.cjs');
import store = require('./progress-store.cjs');
import state = require('./state-store.cjs');
import type { ActiveContract, Contract, RunDriver } from './types.cjs';

/** Whether the session drives the run; without a sound contract, every session does. */
function ownsRun(
  sessionId: string | undefined,
  contract: Contract | null,
): boolean {
  if (!contract || contract.broken) return true;
  return (
    guards.readField(state.readSessionState(sessionId), 'run') ===
    contract.boundaryFile
  );
}

function registerSession(
  sessionIdOrNone: string | undefined,
  contract: ActiveContract,
): void {
  const sessionId = sessionIdOrNone || 'unknown';
  const sessionState = state.readSessionState(sessionId);
  if (guards.readField(sessionState, 'run') !== contract.boundaryFile) {
    guards.writeField(sessionState, 'run', contract.boundaryFile);
    state.ensureDirs();
    state.writeStateAtomic(state.sessionStatePath(sessionId), sessionState);
  }
  // Every unit command touches the registration, so the recorder that runs
  // right after this hook finds the issuing session as the newest driver.
  state.touchSessionState(sessionId);
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
 * The session behind a shell unit command. The model shell on Claude Code may
 * carry no session id, which would leave unit rows attributed to session
 * "shell" and model "unknown". E1 registers and touches the driving session
 * just before the command runs, so the recorder reads that registration back:
 * the most recently touched state file registered to this run. Read-only.
 */
function driverOfRun(boundaryFile: unknown): RunDriver | null {
  if (!boundaryFile) return null;
  let names: string[];
  try {
    names = fs.readdirSync(state.STATE_DIR);
  } catch {
    return null;
  }
  let best: RunDriver | null = null;
  for (const name of names) {
    const m = /^session-(.+)\.json$/.exec(name);
    if (!m) continue;
    const file = path.join(state.STATE_DIR, name);
    let sessionState: unknown;
    let mtime: number;
    try {
      sessionState = JSON.parse(fs.readFileSync(file, 'utf8'));
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (guards.readField(sessionState, 'run') !== boundaryFile) continue;
    if (!best || mtime > best.mtime) {
      best = {
        sessionId: m[1] ?? '',
        model: guards.readField(sessionState, 'model') || null,
        mtime,
      };
    }
  }
  return best;
}

export = { ownsRun, registerSession, driverOfRun };
