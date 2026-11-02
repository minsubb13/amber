// S2 (Stop): consume the completion signal the model wrote with `record.cjs
// done` (its semantic-review attestation rides in the signal; the final
// message is never read). The signal names the session that wrote it, and a
// stop takes only its own: from the hook cwd's zone or from any zone the
// session registered (a linked worktree outside the zone it stands in).
// Under that zone's contract, accept it only when the pointer is sound, the
// signal names that contract, and no unit worktree remains (at most three
// rejections), then release the contract. With open plan units and no
// signal, send the stop back (the loop body) for the one zone the session
// drove last: a plain hold passes once, an external hold passes every stop
// until the held unit's next transition.

import fs = require('node:fs');
import path = require('node:path');

import clock = require('./clock.cjs');
import contracts = require('./contract.cjs');
import done = require('./done-signal.cjs');
import guards = require('./guards.cjs');
import ledger = require('./ledger.cjs');
import model = require('./progress-model.cjs');
import ownership = require('./ownership.cjs');
import phaseStore = require('./phase-store.cjs');
import store = require('./progress-store.cjs');
import state = require('./state-store.cjs');
import text = require('./hook-text.cjs');
import zone = require('./zone.cjs');
import type {
  ActiveContract,
  Contract,
  DoneSignal,
  HookInput,
  HookOutput,
  Progress,
} from './types.cjs';

const REQUEST_REVIEW_TARGET = 'request';

/**
 * Release on a passed completion: the pointer and progress file go, the
 * session forgets its briefing so a re-approved contract briefs again, and a
 * phase still open here (a set record never followed by a tool call that
 * found the pointer) is closed with its phase-exit row.
 */
function releaseContract(
  contract: ActiveContract,
  sessionId: string | undefined,
): void {
  state.tryUnlink(contract.pointerPath);
  state.tryUnlink(store.progressPath(contract.root));
  phaseStore.exit(
    { session_id: sessionId, cwd: contract.root },
    contract.root,
    'release',
  );
  const stateFile = state.sessionStatePath(sessionId);
  try {
    const sessionState: unknown = JSON.parse(
      fs.readFileSync(stateFile, 'utf8'),
    );
    guards.deleteField(sessionState, 'briefed');
    state.writeStateAtomic(stateFile, sessionState);
  } catch {
    // No state file to update.
  }
}

/**
 * The zone the loop body sends a stop back for: among the zones the session
 * registered (newest `at` first) and then the hook cwd's zone, the first
 * whose sound contract the session drives and whose progress has open units.
 */
function continuationZone(
  input: HookInput,
  cwdRoot: string,
): { contract: ActiveContract; p: Progress } | null {
  const roots = ownership.registeredRuns(input.session_id).map((r) => r.root);
  if (!roots.includes(cwdRoot)) roots.push(cwdRoot);
  for (const root of roots) {
    // Progress first: a file read, before the contract's git queries.
    const p = store.loadProgress(root);
    if (!p || model.isBroken(p)) continue;
    if (model.openUnits(p).length === 0) continue;
    const contract = contracts.loadContract(root);
    if (!contract || contract.broken) continue;
    if (!ownership.ownsRun(input.session_id, contract)) continue;
    return { contract, p };
  }
  return null;
}

/**
 * Loop body: a plain stop under a contract with open units is sent back with
 * the next unit, up to REENTRY_LIMIT re-entries per unit; a recorded hold
 * passes once, an external hold passes every stop until the held unit's next
 * transition; reaching the limit records it and lets the stop through. One
 * zone only - the one continuationZone picks; none means no continuation.
 */
function continuation(input: HookInput, cwdRoot: string): HookOutput {
  const loopFile = state.loopStatePath(input.session_id);
  const release = (): null => {
    state.tryUnlink(loopFile);
    return null;
  };
  const target = continuationZone(input, cwdRoot);
  if (!target) return release();
  const { contract, p } = target;
  if (p.hold) {
    if (p.hold.kind === 'external') return release();
    p.hold = null;
    store.saveProgress(contract.root, p, clock.isoNow);
    return release();
  }
  const id = model.focusUnit(p);
  if (!id) return release();
  const unit = p.units[id];
  if (!unit) return release();
  if (unit.reentries >= model.REENTRY_LIMIT) {
    model.applyEvent(
      p,
      'limit',
      id,
      { by: input.session_id || 'stop' },
      clock.isoNow,
    );
    store.saveProgress(contract.root, p, clock.isoNow);
    ledger.appendRecord(
      input,
      id + ' reached the re-entry limit',
      { contract: contract.boundaryFile, unit: id, reentries: unit.reentries },
      'unit-limit',
    );
    return release();
  }
  unit.reentries += 1;
  p.blocks = (p.blocks || 0) + 1;
  store.saveProgress(contract.root, p, clock.isoNow);
  state.ensureDirs();
  state.writeStateAtomic(loopFile, { blocked_at: clock.isoNow(), unit: id });
  return text.blockOutput(
    text.continuationDirective(contract.boundaryFile, p, id, unit.reentries),
  );
}

/** The gate's rejection counter for this session; a non-number reads as 0. */
function gateAttempts(gateFile: string): number {
  try {
    const attempts = guards.readField(
      JSON.parse(fs.readFileSync(gateFile, 'utf8')),
      'attempts',
    );
    return typeof attempts === 'number' ? attempts : 0;
  } catch {
    return 0;
  }
}

/**
 * The session's own completion signal and the zone that held it. The hook
 * cwd's zone is looked at first, then every zone the session registered,
 * newest `at` first; the first signal claimed is consumed and the search
 * ends there, even when it turns out stale or malformed. A signal is claimed
 * when it names this session; one that names no session (an older recorder)
 * when the session drives that zone's run, as before signals named one.
 */
function takeOwnSignal(
  input: HookInput,
  cwdRoot: string,
): { root: string; signal: DoneSignal | null } | null {
  const roots = [cwdRoot];
  for (const r of ownership.registeredRuns(input.session_id)) {
    if (!roots.includes(r.root)) roots.push(r.root);
  }
  for (const root of roots) {
    const { taken, signal } = done.takeDoneSignal(root, (sessionId) => {
      if (sessionId !== null) return sessionId === input.session_id;
      const contract = contracts.loadContract(root);
      // Outside the cwd's zone only a run the session drives is its own.
      if (!contract && root !== cwdRoot) return false;
      return ownership.ownsRun(input.session_id, contract);
    });
    if (taken) return { root, signal };
  }
  return null;
}

function runS2(input: HookInput): HookOutput {
  state.touchSessionState(input.session_id);
  const cwdRoot = path.resolve(zone.zoneRoot(input.cwd));
  const taken = takeOwnSignal(input, cwdRoot);
  const signal = taken ? taken.signal : null;
  const gateFile = state.gateStatePath(input.session_id);
  let attemptsSoFar = gateAttempts(gateFile);
  const loopFile = state.loopStatePath(input.session_id);
  if (input.stop_hook_active === true) {
    if (attemptsSoFar === 0) {
      // Re-entered stop with no live gate counter: our own continuation or
      // another hook's block. A fresh signal is ours either way - a consumed
      // signal cannot be re-presented, so a foreign re-entry never duplicates.
      if (!signal) return continuation(input, cwdRoot);
      state.tryUnlink(loopFile);
    } else if (!signal) {
      // The model followed the directive's other branch: declaration withdrawn.
      state.tryUnlink(gateFile);
      return null;
    }
  } else {
    if (attemptsSoFar > 0) {
      // Stale counter from an interrupted rejection loop - reclaim it.
      state.tryUnlink(gateFile);
      attemptsSoFar = 0;
    }
    state.tryUnlink(loopFile);
  }
  if (!signal || !taken) return continuation(input, cwdRoot);
  // Judged by the contract of the zone that held the signal; a row for a
  // zone other than the cwd's is recorded there.
  const contract: Contract | null = contracts.loadContract(taken.root);
  const source: HookInput =
    taken.root === cwdRoot ? input : { ...input, cwd: taken.root };
  const reviewFields = {
    review_target:
      contract && !contract.broken
        ? contract.boundaryFile
        : REQUEST_REVIEW_TARGET,
    review: signal.review.slice(0, ledger.SUMMARY_MAX),
  };
  if (!contract) {
    state.tryUnlink(gateFile);
    ledger.appendRecord(source, signal.summary, reviewFields);
    return null;
  }
  let worktrees: string[] = [];
  if (!contract.broken && signal.target === contract.boundaryFile) {
    // Loop body completion condition: every unit worktree merged and gone.
    worktrees = zone.extraWorktrees(contract.root);
    if (worktrees.length === 0) {
      state.tryUnlink(gateFile);
      const outOfScope = signal.out_of_scope;
      ledger.appendRecord(source, signal.summary, {
        contract: contract.boundaryFile,
        goal: guards.toText(signal.goal || '').slice(0, ledger.SUMMARY_MAX),
        gate: 'passed',
        ...reviewFields,
        // Declared out-of-scope files ride in the signal (scope-check).
        ...(Array.isArray(outOfScope) && outOfScope.length > 0
          ? {
              out_of_scope: outOfScope,
              out_of_scope_count:
                signal.out_of_scope_count || outOfScope.length,
            }
          : {}),
      });
      releaseContract(contract, input.session_id);
      return null;
    }
  }
  // Rejection path: broken pointer, a signal for another contract, or a
  // well-formed signal while unit worktrees remain.
  const attempts = attemptsSoFar + 1;
  if (attempts > text.MAX_GATE_ATTEMPTS) {
    state.tryUnlink(gateFile);
    ledger.appendRecord(source, signal.summary, {
      contract: contract.boundaryFile || 'broken',
      goal: null,
      gate: 'exhausted',
    });
    return null;
  }
  state.ensureDirs();
  state.writeStateAtomic(gateFile, { attempts });
  return text.blockOutput(
    worktrees.length > 0 && !contract.broken
      ? text.worktreeDirective(contract.boundaryFile, worktrees, attempts)
      : text.completionDirective(contract, signal.target, attempts),
  );
}

export = { runS2 };
