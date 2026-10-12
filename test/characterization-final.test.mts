// Characterization tests added by the final audit: inputs the stage suites did
// not reach where the audit found the port behaving differently, pinned to
// what the original does (they pass on ts-port 21900ce as on the final
// build). These suites are not ports of a legacy suite, so parity:tests
// leaves them out of its name comparison. Every hook process gets its own
// AMBER_HOME, so the real ~/.amber is never touched.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadModule, PLUGIN } from './support/plugin.mjs';

const HOOK = path.join(PLUGIN, 'hooks', 'amber-hook.cjs');
const BASE = fs.mkdtempSync(
  path.join(os.tmpdir(), 'amber-characterization-final-'),
);
after(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});
const progress = loadModule<typeof import('../src/hooks/progress.cjs')>(
  'hooks/progress.cjs',
  ['unitByAgent'],
);

/** A zone under an approved contract whose progress.json holds `units`. */
function zoneWithUnits(name: string, units: unknown): string {
  const zone = path.join(BASE, name);
  fs.mkdirSync(path.join(zone, '.amber'), { recursive: true });
  execFileSync('git', ['-C', zone, 'init', '-q']);
  fs.writeFileSync(
    path.join(zone, 'boundary.md'),
    '# fixture\n- code [machine: write-scope src/**]\n',
  );
  fs.writeFileSync(
    path.join(zone, '.amber', 'active.json'),
    JSON.stringify({
      v: 1,
      boundary: 'boundary.md',
      ratified_by: 'fixture-user',
      ratified_at: '2026-10-12',
    }),
  );
  fs.writeFileSync(
    path.join(zone, '.amber', 'progress.json'),
    JSON.stringify({ v: 1, units }),
  );
  return zone;
}

test('E1 fails open on a null unit while looking up a subagent claim', () => {
  const zone = zoneWithUnits('null-unit', { U1: null });
  const home = path.join(BASE, 'null-unit-home');
  const res = spawnSync('node', [HOOK, 'E1'], {
    input: JSON.stringify({
      session_id: 'main',
      agent_id: 'sub-1',
      cwd: zone,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(zone, 'src', 'x.txt') },
    }),
    env: { ...process.env, AMBER_HOME: home },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  const log = fs.readFileSync(
    path.join(home, 'state', 'sensor-failures.log'),
    'utf8',
  );
  assert.match(
    log,
    /hook-crash event=E1 Cannot read properties of null \(reading 'agent_id'\)/,
  );
});

/**
 * unitByAgent with a progress object its TypeScript type rejects (a unit
 * that is null or not an object), as a hand-edited file can hold.
 */
function unitByAgent(units: unknown, agentId: string): unknown {
  return Reflect.apply(progress.unitByAgent, progress, [{ units }, agentId]);
}

test('unitByAgent reads each unit as an object, throwing on a null one', () => {
  assert.throws(() => unitByAgent({ U1: null }, 'sub-1'), {
    name: 'TypeError',
    message: "Cannot read properties of null (reading 'agent_id')",
  });
  // A non-object unit has no agent_id; a claimed unit before a null one is
  // found first, as Array#find stops there.
  assert.equal(unitByAgent({ U1: 1 }, 'sub-1'), null);
  assert.equal(
    unitByAgent({ U1: { agent_id: 'sub-1' }, U2: null }, 'sub-1'),
    'U1',
  );
});
