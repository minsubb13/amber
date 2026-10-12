// Amber sensors and enforcers, dispatched by argv:
//   S0 (SessionStart)     - pass the model id forward, report sensor failures;
//                           inject contract awareness (standing obligations,
//                           completion-signal and mark conventions) when a
//                           contract is active, or the one-line cycle arming
//                           note when none is
//   S1 (UserPromptSubmit) - record typed /amber:planning, $amber:planning, /amber:init
//                           or $amber:init; brief the session once when a
//                           contract became active after session start (S0
//                           briefs only at startup); S0 and S1 both name a
//                           completion signal waiting for another session
//   S2 (Stop)             - consume the completion signal the model wrote with
//                           `record.cjs done`; under a contract, accept it only
//                           when the pointer is sound, the signal names that
//                           contract, and no unit worktree remains (max 3
//                           rejections), then release the contract; with open
//                           plan units and no signal, send the stop back
//   S3 (PreToolUse Skill) - record model-invoked amber skills and amber:mark
//                           calls; sensor only, never a permission decision
//   E1 (PreToolUse)       - deny tool calls that cross the active contract's
//                           machine rules; register the session as a driver of
//                           the run when it runs a unit command or the
//                           completion signal
// No active contract (no .amber/active.json at the zone root) means every
// enforcement path is silent. Unexpected hook crashes fail open and leave a
// breadcrumb in sensor-failures.log; broken contract state fails closed with
// an actionable reason.
//
// This entry reads stdin, picks the handler and writes its answer; the
// handlers live in lib/ (session-start, prompt-submit, stop-gate,
// skill-recorder, enforcer). scripts/record.cjs requires the five functions
// exported below.

import fs = require('node:fs');

import clock = require('../lib/clock.cjs');
import contracts = require('../lib/contract.cjs');
import done = require('../lib/done-signal.cjs');
import enforcer = require('../lib/enforcer.cjs');
import guards = require('../lib/guards.cjs');
import inputs = require('../lib/hook-input.cjs');
import ledger = require('../lib/ledger.cjs');
import ownership = require('../lib/ownership.cjs');
import promptSubmit = require('../lib/prompt-submit.cjs');
import sessionStart = require('../lib/session-start.cjs');
import skillRecorder = require('../lib/skill-recorder.cjs');
import state = require('../lib/state-store.cjs');
import stopGate = require('../lib/stop-gate.cjs');
import type { HookEvent, HookInput, HookOutput } from '../lib/types.cjs';

function handle(event: HookEvent, input: HookInput): HookOutput {
  switch (event) {
    case 'S0':
      return sessionStart.runS0(input);
    case 'S1':
      return promptSubmit.runS1(input);
    case 'S2':
      return stopGate.runS2(input);
    case 'S3':
      return skillRecorder.runS3(input);
    case 'E1':
      return enforcer.runE1(input);
  }
}

/** Leaves a crash breadcrumb; a crash that cannot be recorded stays silent. */
function recordCrash(eventName: unknown, err: unknown): void {
  try {
    state.ensureDirs();
    const message = guards.isObject(err) ? err['message'] : undefined;
    fs.appendFileSync(
      state.FAILURES_FILE,
      clock.isoNow() +
        ' hook-crash event=' +
        guards.toText(eventName) +
        ' ' +
        guards.toText(message || err).slice(0, 200) +
        '\n',
      { mode: 0o600 },
    );
  } catch {
    // Nowhere to record it.
  }
}

function main(): void {
  const eventName = process.argv[2];
  let raw = '';
  process.stdin.on('data', (chunk: Buffer) => {
    raw += chunk.toString();
  });
  process.stdin.on('end', () => {
    let output: HookOutput = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      const event = inputs.hookEvent(eventName);
      if (event) output = handle(event, inputs.hookInput(parsed, event));
    } catch (err) {
      recordCrash(eventName, err);
    }
    if (output) process.stdout.write(JSON.stringify(output));
    process.exit(0);
  });
}

/** S3 for record.cjs, which records Codex skill calls through it. */
function runS3(input: unknown): HookOutput {
  return skillRecorder.runS3(inputs.hookInput(input, 'S3'));
}

/** Unit events recorded by scripts/record.cjs (both hosts' shell path). */
function recordUnitEvent(
  sessionId: string | null | undefined,
  cwd: string | null | undefined,
  event: string,
  summaryText: string,
  fields?: Readonly<Record<string, unknown>> | null,
): void {
  ledger.appendRecord(
    { session_id: sessionId, cwd },
    summaryText,
    fields || null,
    'unit-' + event,
  );
}

export = {
  runS3,
  recordUnitEvent,
  contractInfo: contracts.contractInfo,
  writeDoneSignal: done.writeDoneSignal,
  driverOfRun: ownership.driverOfRun,
};

if (require.main === module) main();
