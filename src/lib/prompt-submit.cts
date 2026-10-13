// S1 (UserPromptSubmit): record typed /amber:planning, $amber:planning,
// /amber:init, $amber:init and the typed audit call; brief the session once
// per boundary file when a contract became active after session start (S0
// briefs only at startup); name a completion signal waiting for another
// session on every prompt while it applies. Everything else stays silent.

import briefing = require('./briefing.cjs');
import contracts = require('./contract.cjs');
import guards = require('./guards.cjs');
import ledger = require('./ledger.cjs');
import state = require('./state-store.cjs');
import text = require('./hook-text.cjs');
import type { HookInput, HookOutput } from './types.cjs';

const PLANNING_CALL = /^(?:\/|\$)amber:planning\b/;
// A typed init call is recorded as a bare skill-invocation row (time and place
// come from the row); a typed status call is not recorded at all.
const INIT_CALL = /^(?:\/|\$)amber:init\b/;
// A typed audit call is recorded the same way; its arguments stay out.
const AUDIT_CALL = /^(?:\/|\$)amber:audit\b/;

function runS1(input: HookInput): HookOutput {
  state.touchSessionState(input.session_id);
  const prompt = guards.toText(input.prompt || '').trim();
  if (PLANNING_CALL.test(prompt)) {
    ledger.appendRecord(input, prompt, null, 'planning-invocation');
  }
  if (INIT_CALL.test(prompt)) {
    ledger.appendRecord(input, 'amber:init (typed)', null, 'skill-invocation');
  }
  if (AUDIT_CALL.test(prompt)) {
    ledger.appendRecord(input, 'amber:audit (typed)', null, 'skill-invocation');
  }
  const contract = contracts.loadContract(input.cwd);
  if (!contract) return null;
  const waiting = briefing.waitingSignalContextFor(contract, input.session_id);
  const key = contract.boundaryFile || 'broken';
  const stateFile = state.sessionStatePath(input.session_id);
  const sessionState = state.readJsonOrEmpty(stateFile);
  if (guards.readField(sessionState, 'briefed') === key) {
    return waiting ? text.contextOutput('UserPromptSubmit', waiting) : null;
  }
  guards.writeField(sessionState, 'briefed', key);
  state.ensureDirs();
  state.writeStateAtomic(stateFile, sessionState);
  return text.contextOutput(
    'UserPromptSubmit',
    [
      briefing.contractContextFor(contract),
      briefing.progressContextFor(contract),
      briefing.ownershipContextFor(contract, input.session_id),
      waiting,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

export = { runS1 };
