// The context lines S0 and S1 assemble: each reads the state it describes
// and hands the text to lib/hook-text.

import path = require('node:path');

import done = require('./done-signal.cjs');
import contracts = require('./contract.cjs');
import model = require('./progress-model.cjs');
import store = require('./progress-store.cjs');
import ownership = require('./ownership.cjs');
import text = require('./hook-text.cjs');
import zone = require('./zone.cjs');
import type { Contract } from './types.cjs';

function contractContextFor(contract: Contract | null): string | null {
  return contract ? text.contractContext(contract) : null;
}

function progressContextFor(contract: Contract | null): string | null {
  if (!contract || contract.broken) return null;
  const p = store.loadProgress(contract.root);
  return p ? text.progressContext(p) : null;
}

function ownershipContextFor(
  contract: Contract | null,
  sessionId: string | undefined,
): string | null {
  if (!contract || contract.broken) return null;
  const p = store.loadProgress(contract.root);
  const registered =
    p && !model.isBroken(p) && Array.isArray(p.session_ids)
      ? p.session_ids.length
      : 0;
  return text.ownershipContext(
    ownership.ownsRun(sessionId, contract),
    registered,
  );
}

/**
 * Waiting-signal briefing: S2 leaves a completion signal alone when it names
 * another session (or, from an older recorder, names none and the session
 * does not drive the run), so S0 and S1 say that one is waiting. Read only -
 * the signal is never consumed here.
 */
function waitingSignalContextFor(
  contract: Contract | null,
  sessionId: string | undefined,
): string | null {
  if (!contract || contract.broken) return null;
  const owner = done.peekSignalSession(contract.root);
  if (!owner) return null;
  if (owner.sessionId !== null) {
    return owner.sessionId === sessionId
      ? null
      : text.WAITING_OTHER_SESSION_SIGNAL;
  }
  if (ownership.ownsRun(sessionId, contract)) return null;
  return text.WAITING_SIGNAL;
}

/**
 * The runs the session drives in zones other than the cwd's (a linked
 * worktree outside it), newest registration first, each with its briefing
 * line: its stops and completion signal follow that zone. Only
 * registrations that still name the zone's active contract count; a removed
 * zone is skipped.
 */
function drivenZonesFor(
  cwd: string | undefined,
  sessionId: string | undefined,
): { root: string; boundaryFile: string; line: string }[] {
  const runs = ownership.registeredRuns(sessionId);
  if (runs.length === 0) return [];
  const cwdRoot = path.resolve(zone.zoneRoot(cwd));
  const out: { root: string; boundaryFile: string; line: string }[] = [];
  for (const r of runs) {
    if (r.root === cwdRoot) continue;
    const contract = contracts.loadContract(r.root);
    if (!contract || contract.broken) continue;
    if (!ownership.ownsRun(sessionId, contract)) continue;
    out.push({
      root: r.root,
      boundaryFile: contract.boundaryFile,
      line: text.drivenZoneLine(contract.boundaryFile, r.root),
    });
  }
  return out;
}

/**
 * The key S0 and S1 keep in the session state as `driven_briefed`: the
 * other driven zones last announced, each as `<root>=<boundary file>`,
 * sorted, so the lines are sent once per change of that set and again when
 * a zone's contract is replaced by another.
 */
function drivenKey(
  zones: readonly { root: string; boundaryFile: string }[],
): string[] {
  return zones.map((z) => z.root + '=' + z.boundaryFile).sort();
}

function linkedWorktreeContextFor(cwd: string | undefined): string | null {
  const main = zone.linkedWorktreeMain(cwd);
  if (!main) return null;
  return text.linkedWorktreeContext(main, contracts.loadContract(main));
}

export = {
  contractContextFor,
  progressContextFor,
  ownershipContextFor,
  waitingSignalContextFor,
  drivenZonesFor,
  drivenKey,
  linkedWorktreeContextFor,
};
