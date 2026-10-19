// E1 (PreToolUse): deny tool calls that cross the active contract's machine
// rules (write-scope globs, bash-deny). Monitor runs a shell command like
// Bash and takes the same path. Shell writes escape it, so scope-check
// compares git-changed files with the write-scope at unit verified and done.
// The run's own state under .amber/ is written by record.cjs and the hooks,
// never by a file tool. A subagent writes only inside the unit it claimed; the
// claim and the driving session are registered here, the one party that sees
// the host-assigned ids.

import path = require('node:path');

// The apply_patch parser keeps its stage 2 module at hooks/patch-paths.
import patchPathsModule = require('../hooks/patch-paths.cjs');
import clock = require('./clock.cjs');
import contracts = require('./contract.cjs');
import glob = require('./glob.cjs');
import guards = require('./guards.cjs');
import ledger = require('./ledger.cjs');
import model = require('./progress-model.cjs');
import ownership = require('./ownership.cjs');
import rules = require('./contract-rules.cjs');
import store = require('./progress-store.cjs');
import text = require('./hook-text.cjs');
import zone = require('./zone.cjs');
import type { ActiveContract, HookInput, HookOutput, Unit } from './types.cjs';

const UNIT_CLAIM = /\brecord\.cjs["']?\s+unit\s+claim\s+(U\d+)\b/;
// Any unit command or the completion signal, run by the session itself (no
// agent id): the act that registers the session as a driver of the run.
const UNIT_CMD =
  /\brecord\.cjs["']?\s+(?:unit\s+(?:init|claim|start|verified|failed|hold)|done)\b/;

const deny = text.denyOutput;

function messageOf(err: unknown): string {
  return guards.toText(guards.isObject(err) ? err['message'] : undefined);
}

/**
 * The claim handshake: a subagent's first action names its unit; the hook is
 * the only party that sees the host-assigned agent id, so it records the
 * binding here.
 */
function observeClaim(
  input: HookInput,
  contract: ActiveContract,
  agentId: string,
  unitId: string,
): HookOutput {
  const p = store.loadProgress(contract.root);
  if (!p || model.isBroken(p)) {
    return deny(
      'cannot record the unit claim: ' +
        (p
          ? 'progress.json is broken (' + p.error + ')'
          : 'no progress.json in ' + contract.root),
    );
  }
  try {
    model.applyEvent(p, 'claim', unitId, { agent_id: agentId }, clock.isoNow);
  } catch (err) {
    return deny('unit claim refused: ' + messageOf(err));
  }
  store.saveProgress(contract.root, p, clock.isoNow);
  ledger.appendRecord(
    input,
    unitId + ' claimed by subagent ' + agentId,
    { contract: contract.boundaryFile, unit: unitId, agent_id: agentId },
    'unit-claim',
  );
  return null;
}

function runBash(
  input: HookInput,
  contract: ActiveContract,
  bashDeny: readonly string[],
  agentId: string | null,
): HookOutput {
  const command = guards.toText(input.tool_input['command'] || '');
  for (const pattern of bashDeny) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return deny(
        'contract ' +
          contract.boundaryFile +
          ' has an invalid bash-deny pattern: ' +
          pattern +
          '. Fix the boundary document.',
      );
    }
    if (re.test(command)) {
      return deny(
        'blocked by contract ' +
          contract.boundaryFile +
          ': bash-deny ' +
          pattern,
      );
    }
  }
  if (agentId) {
    const claim = UNIT_CLAIM.exec(command);
    if (claim) return observeClaim(input, contract, agentId, claim[1] ?? '');
  } else if (UNIT_CMD.test(command)) {
    ownership.registerSession(input.session_id, contract);
  }
  return null;
}

/** The unit a subagent claimed, or the reason it may not write at all. */
function claimedUnit(
  contract: ActiveContract,
  agentId: string,
): { id: string; unit: Unit } | { denied: HookOutput } {
  const p = store.loadProgress(contract.root);
  if (!p || model.isBroken(p)) {
    return {
      denied: deny(
        'subagent ' +
          agentId +
          ' cannot write under contract ' +
          contract.boundaryFile +
          ': ' +
          (p
            ? 'progress.json is broken (' + p.error + ')'
            : 'no progress.json - the main agent runs `node ' +
              text.RECORD_CLI +
              ' unit init <plan>` first, and each subagent claims its unit'),
      ),
    };
  }
  const id = model.unitByAgent(p, agentId);
  const unit = id ? p.units[id] : undefined;
  if (!id || !unit) {
    return {
      denied: deny(
        'subagent ' +
          agentId +
          ' has not claimed a unit. First run `node ' +
          text.RECORD_CLI +
          " unit claim U<n>` for the unit named in your brief, then write only inside that unit's scope.",
      ),
    };
  }
  return { id, unit };
}

function runE1(input: HookInput): HookOutput {
  const contract = contracts.loadContract(input.cwd);
  if (!contract) return null;
  if (contract.broken) {
    return deny(
      'active contract pointer ' +
        contract.pointerPath +
        ' is broken (' +
        contract.error +
        '). Fix it, or remove the file to release the contract.',
    );
  }
  const { writeScopes, bashDeny } = rules.machineRules(contract.text);
  const agentId = input.agent_id ? guards.toText(input.agent_id) : null;
  if (input.tool_name === 'Bash' || input.tool_name === 'Monitor') {
    return runBash(input, contract, bashDeny, agentId);
  }
  let targets: string[];
  if (input.tool_name === 'apply_patch') {
    try {
      targets = patchPathsModule.patchPaths(input.tool_input['command']);
    } catch (err) {
      return deny(
        'cannot inspect apply_patch under contract ' +
          contract.boundaryFile +
          ': ' +
          messageOf(err) +
          '. Correct the patch and retry.',
      );
    }
  } else {
    const target = guards.toText(
      input.tool_input['file_path'] ||
        input.tool_input['notebook_path'] ||
        input.tool_input['path'] ||
        '',
    );
    targets = target ? [target] : [];
  }
  let claimed: { id: string; unit: Unit } | null = null;
  if (agentId) {
    const result = claimedUnit(contract, agentId);
    if ('denied' in result) return result.denied;
    claimed = result;
  }
  const boundaryRel = contracts.boundaryRel(
    contract.root,
    contract.boundaryPath,
  );
  const resolved = zone.zoneRelativeAll(
    contract.root,
    input.cwd,
    targets.map((target) => path.resolve(input.cwd || contract.root, target)),
  );
  for (const { abs, rel } of resolved) {
    if (
      abs === contract.pointerPath ||
      abs === contract.boundaryPath ||
      rel === boundaryRel ||
      rel === '.amber/active.json'
    ) {
      return deny(
        'the active contract and its pointer are not editable while the contract is active. ' +
          'Release the contract first (remove ' +
          contract.pointerPath +
          ').',
      );
    }
    if (rel === '.amber' || rel.startsWith('.amber/')) {
      return deny(
        'blocked by contract ' +
          contract.boundaryFile +
          ': ' +
          rel +
          " is the run's state under .amber/, written only by `node " +
          text.RECORD_CLI +
          '` and the hooks',
      );
    }
    if (
      writeScopes.length > 0 &&
      (rel.startsWith('..') ||
        path.isAbsolute(rel) ||
        !glob.inScopes(rel, writeScopes))
    ) {
      return deny(
        'blocked by contract ' +
          contract.boundaryFile +
          ': write target ' +
          rel +
          ' is outside every write-scope (' +
          writeScopes.join(', ') +
          ')',
      );
    }
    if (claimed && !glob.inScopes(rel, claimed.unit.scope)) {
      return deny(
        'blocked by unit ' +
          claimed.id +
          ' (claimed by subagent ' +
          String(agentId) +
          '): write target ' +
          rel +
          ' is outside its scope (' +
          claimed.unit.scope.join(', ') +
          '). Stay inside the unit, or report BLOCKED to the main agent.',
      );
    }
  }
  return null;
}

export = { runE1 };
