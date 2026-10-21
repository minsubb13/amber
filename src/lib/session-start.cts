// S0 (SessionStart): record the session's model and start time, sweep state
// files idle past the TTL, and brief the session - the active contract with
// its progress, ownership and waiting signal, or the arming note with the
// completion procedure (its index on a startup or clear, its full text on a
// compaction or resume) when there is none - plus any sensor failures.

import fs = require('node:fs');
import path = require('node:path');

import briefing = require('./briefing.cjs');
import clock = require('./clock.cjs');
import contracts = require('./contract.cjs');
import guards = require('./guards.cjs');
import phase = require('./phase.cjs');
import state = require('./state-store.cjs');
import text = require('./hook-text.cjs');
import zone = require('./zone.cjs');
import type { HookInput, HookOutput, SessionState } from './types.cjs';

const STATE_TTL_MS = 48 * 60 * 60 * 1000;

function sweepIdleState(): void {
  for (const name of fs.readdirSync(state.STATE_DIR)) {
    if (
      !name.startsWith('session-') &&
      !name.startsWith('gate-') &&
      !name.startsWith('loop-')
    ) {
      continue;
    }
    const file = path.join(state.STATE_DIR, name);
    try {
      if (clock.nowMs() - fs.statSync(file).mtimeMs > STATE_TTL_MS) {
        fs.unlinkSync(file);
      }
    } catch {
      // Gone already, or not removable (a directory): left alone.
    }
  }
}

function sensorFailureCount(): number {
  try {
    return fs
      .readFileSync(state.FAILURES_FILE, 'utf8')
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Whether a contract-less session gets the full completion procedure or only
 * its index. A compaction or resume lost the planning skill's copy (or never
 * had it), so it gets the full text; a startup or clear gets the index, since
 * planning loads the procedure when work begins. Without a source field, a
 * state file already present for this session stands in for a resume.
 */
function briefsFullProcedure(
  source: string | undefined,
  hadState: boolean,
): boolean {
  if (source === 'compact' || source === 'resume') return true;
  if (source === 'startup' || source === 'clear') return false;
  return hadState;
}

function runS0(input: HookInput): HookOutput {
  state.ensureDirs();
  const contract = contracts.loadContract(input.cwd);
  const statePath = state.sessionStatePath(input.session_id);
  const hadState = fs.existsSync(statePath);
  const sessionState: SessionState = {
    model: input.model || null,
    started_at: clock.isoNow(),
  };
  // Briefed flag keyed to the boundary file: S1 re-briefs only when a
  // contract appears (or changes) after this session's opening.
  if (contract) sessionState.briefed = contract.boundaryFile || 'broken';
  // A resumed or compacted session keeps driving its run, and keeps the
  // phase it opened: the gate outlives the context that opened it.
  const previous = state.readSessionState(input.session_id);
  const previousRun = guards.readField(previous, 'run');
  if (previousRun) sessionState.run = previousRun;
  const previousPhase = guards.readField(previous, 'phase');
  if (previousPhase) sessionState.phase = previousPhase;
  state.writeStateAtomic(statePath, sessionState);
  sweepIdleState();
  const failures = sensorFailureCount();
  const parts: string[] = [];
  const contractCtx = briefing.contractContextFor(contract);
  if (contractCtx) {
    parts.push(contractCtx);
    const progressCtx = briefing.progressContextFor(contract);
    if (progressCtx) parts.push(progressCtx);
    const ownerCtx = briefing.ownershipContextFor(contract, input.session_id);
    if (ownerCtx) parts.push(ownerCtx);
    const waitingCtx = briefing.waitingSignalContextFor(
      contract,
      input.session_id,
    );
    if (waitingCtx) parts.push(waitingCtx);
  } else {
    parts.push(text.NO_CONTRACT);
    const worktreeCtx = briefing.linkedWorktreeContextFor(input.cwd);
    if (worktreeCtx) parts.push(worktreeCtx);
    const openPhase = phase.readPhase(previousPhase);
    if (openPhase && openPhase.zone === zone.zoneRoot(input.cwd)) {
      parts.push(phase.briefLine(openPhase));
    }
    parts.push(
      briefsFullProcedure(input.source, hadState)
        ? text.noContractGuidance()
        : text.NO_CONTRACT_INDEX,
    );
  }
  if (failures > 0) {
    parts.push(text.sensorFailures(failures, state.FAILURES_FILE));
  }
  return text.contextOutput('SessionStart', parts.join('\n\n'));
}

export = { runS0 };
