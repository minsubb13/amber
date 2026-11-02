// S1 (UserPromptSubmit): record typed /amber:planning, $amber:planning,
// /amber:init, $amber:init and the typed audit call; brief the session once
// per boundary file when a contract became active after session start (S0
// briefs only at startup); name a completion signal waiting for another
// session on every prompt while it applies; name the runs the session drives
// in other zones once per change of their set. Everything else stays silent.

import briefing = require('./briefing.cjs');
import contracts = require('./contract.cjs');
import guards = require('./guards.cjs');
import ledger = require('./ledger.cjs');
import phaseStore = require('./phase-store.cjs');
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
    // The typed call opens the phase as the Skill record does (lib/phase).
    phaseStore.enter(input, 'planning');
  }
  if (INIT_CALL.test(prompt)) {
    ledger.appendRecord(input, 'amber:init (typed)', null, 'skill-invocation');
  }
  if (AUDIT_CALL.test(prompt)) {
    ledger.appendRecord(input, 'amber:audit (typed)', null, 'skill-invocation');
  }
  const stateFile = state.sessionStatePath(input.session_id);
  const sessionState = state.readSessionState(input.session_id);
  let changed = false;
  const parts: (string | null)[] = [];
  const contract = contracts.loadContract(input.cwd);
  if (contract) {
    const waiting = briefing.waitingSignalContextFor(
      contract,
      input.session_id,
    );
    const key = contract.boundaryFile || 'broken';
    if (sessionState['briefed'] === key) {
      parts.push(waiting);
    } else {
      sessionState['briefed'] = key;
      changed = true;
      parts.push(
        briefing.contractContextFor(contract),
        briefing.progressContextFor(contract),
        briefing.ownershipContextFor(contract, input.session_id),
        waiting,
      );
    }
  }
  // The other zones the session drives, announced once per change of their
  // set whatever the cwd zone's briefing did (S0 records the set it named).
  const driven = briefing.drivenZonesFor(input.cwd, input.session_id);
  const drivenKey = briefing.drivenKey(driven);
  const announced = sessionState['driven_briefed'];
  const before = Array.isArray(announced) ? announced : [];
  if (JSON.stringify(before) !== JSON.stringify(drivenKey)) {
    sessionState['driven_briefed'] = drivenKey;
    changed = true;
    parts.push(driven.map((z) => z.line).join('\n'));
  }
  if (changed) {
    state.ensureDirs();
    state.writeStateAtomic(stateFile, sessionState);
  }
  const context = parts.filter(Boolean).join('\n\n');
  return context ? text.contextOutput('UserPromptSubmit', context) : null;
}

export = { runS1 };
