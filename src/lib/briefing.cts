// The context lines S0 and S1 assemble: each reads the state it describes
// and hands the text to lib/hook-text.

import fs = require('node:fs');

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
 * Waiting-signal briefing: S2 leaves a completion signal alone when the
 * session does not drive the run, so S0 and S1 say that one is waiting.
 * Existence only - the signal is never consumed here.
 */
function waitingSignalContextFor(
  contract: Contract | null,
  sessionId: string | undefined,
): string | null {
  if (!contract || contract.broken) return null;
  if (!fs.existsSync(done.donePath(contract.root))) return null;
  if (ownership.ownsRun(sessionId, contract)) return null;
  return text.WAITING_SIGNAL;
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
  linkedWorktreeContextFor,
};
