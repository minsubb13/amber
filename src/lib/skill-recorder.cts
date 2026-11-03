// S3 (PreToolUse Skill): record model-invoked amber skills (the judged
// cycle-opening path S1 cannot see) and amber:mark calls (cycle events - the
// call itself is the record). Sensor only: no permission decision, silence on
// everything that is not an amber skill. A planning or set record opens the
// session's phase and a skip record closes it (lib/phase-store); the Codex
// recorder's invoke and mark run this too.

import clock = require('./clock.cjs');
import contracts = require('./contract.cjs');
import guards = require('./guards.cjs');
import ledger = require('./ledger.cjs');
import model = require('./progress-model.cjs');
import ownership = require('./ownership.cjs');
import phaseStore = require('./phase-store.cjs');
import store = require('./progress-store.cjs');
import recordArgs = require('./record-args.cjs');
import zone = require('./zone.cjs');
import type { Contract, HookInput, HookOutput } from './types.cjs';

// Model-invoked amber skills arrive as Skill tool calls; match the likely
// fields defensively (with or without the plugin prefix).
const AMBER_SKILL = /^(?:amber:)?(planning|set|status|init|mark|audit)$/;
// mark arguments: "<kind> - <text>", read after record-args prepared the
// text (separator and unit-id variants folded). Anything else falls back to
// a plain skill-invocation row, so no call ever vanishes unrecorded.
const MARK_ARGS = /^(skip|finding|hold)\s*[-:]\s*([\s\S]+)$/;
const HOLD_TEXT = /^(U\d+)\s*[-:]\s*([\s\S]*)$/;

/**
 * The run a hold goes to. A Skill call (Claude Code's S3): the newest
 * registration of the session whose zone still holds that run (the run the
 * session drove last), with that zone as the ledger row's cwd; without one,
 * the hook cwd's zone contract. The recorder's `mark hold` (Codex, pi) runs
 * in the run's directory, like its unit commands, and takes that zone's.
 */
function holdTarget(
  input: HookInput,
  atCwd: boolean,
): {
  contract: Contract | null;
  source: HookInput;
} {
  const registrations = atCwd ? [] : ownership.registeredRuns(input.session_id);
  for (const registered of registrations) {
    const contract = contracts.loadContractAt(registered.root);
    if (
      contract &&
      !contract.broken &&
      contract.boundaryFile === registered.run
    ) {
      return { contract, source: { ...input, cwd: contract.root } };
    }
  }
  return { contract: contracts.loadContract(input.cwd), source: input };
}

/**
 * A hold recorded through mark: `hold - U<n> - <reason>`. Sets the pass in
 * progress.json of the run the session drove last (holdTarget), when that
 * zone has one - one-shot, or standing when the reason starts with
 * `external:` - and always leaves a ledger row whose summary is the text as
 * written; the unit field carries the prepared id.
 */
function recordHold(
  input: HookInput,
  rawText: string,
  holdText: string,
  atCwd: boolean,
): HookOutput {
  const m = HOLD_TEXT.exec(holdText);
  const unitId = m ? (m[1] ?? null) : null;
  const reason = m ? (m[2] ?? '').trim() : holdText;
  const { contract, source } = holdTarget(input, atCwd);
  const fields: Record<string, unknown> = {
    unit: unitId,
    reason: reason.slice(0, ledger.SUMMARY_MAX),
  };
  const kind = model.holdKind(reason);
  if (kind) fields['kind'] = kind;
  if (contract && !contract.broken) {
    fields['contract'] = contract.boundaryFile;
    const p = store.loadProgress(contract.root);
    if (p && !model.isBroken(p)) {
      try {
        // units is read as found: a null units object fails here and the
        // hold is not set, as before.
        const held = unitId && p.units[unitId] ? unitId : null;
        model.applyEvent(
          p,
          'hold',
          held,
          { reason, by: input.session_id || 'model' },
          clock.isoNow,
        );
        store.saveProgress(contract.root, p, clock.isoNow);
      } catch {
        // The ledger row below still records the hold.
      }
    }
  }
  ledger.appendRecord(source, rawText, fields, 'unit-hold');
  return null;
}

/**
 * `holdAtCwd`: the recorder's mark hold (Codex, pi) goes to the run of the
 * directory it runs in; a Skill call's goes to the run the session drove
 * last.
 */
function runS3(input: HookInput, holdAtCwd = false): HookOutput {
  const toolInput = input.tool_input;
  const name = guards
    .toText(toolInput['skill'] || toolInput['name'] || '')
    .trim();
  const m = AMBER_SKILL.exec(name);
  if (!m) return null;
  const args = guards.toText(toolInput['args'] || '').trim();
  if (m[1] === 'mark') {
    const ev = MARK_ARGS.exec(recordArgs.prepareMarkText(args));
    if (ev) {
      const [, kind = '', eventText = ''] = ev;
      if (kind === 'hold') {
        return recordHold(
          input,
          recordArgs.markText(args) ?? eventText.trim(),
          eventText.trim(),
          holdAtCwd,
        );
      }
      ledger.appendRecord(input, eventText.trim(), null, kind);
      // Every skip closes the cycle: the declined opening and the no-contract
      // verdict alike release the phase gate of this zone.
      if (kind === 'skip') {
        phaseStore.exit(input, zone.zoneRoot(input.cwd), 'skip');
      }
      return null;
    }
  }
  ledger.appendRecord(
    input,
    name + (args ? ' ' + args : ''),
    null,
    'skill-invocation',
  );
  if (m[1] === 'planning' || m[1] === 'set') phaseStore.enter(input, m[1]);
  return null;
}

export = { runS3 };
