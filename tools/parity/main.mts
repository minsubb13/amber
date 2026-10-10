// Entry point of the parity harness.
//   suites   [--ref <rev>]  test-driven comparison, reference vs working tree
//   selftest [--ref <rev>]  every mutation in selftest.mts must be detected
//   real     [--ref <rev>]  comparison over the real ledger and transcripts
// The last line of each command is the machine-readable verdict.

import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { MUTATIONS } from './selftest.mjs';
import { runSide } from './side.mjs';
import { compareSides, report, runReference } from './suites-parity.mjs';
import {
  applyMutation,
  copyCandidate,
  extractReference,
  makeWorkdir,
  resolveRev,
} from './workspace.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ref: { type: 'string', default: 'origin/main' },
    keep: { type: 'boolean', default: false },
    limit: { type: 'string', default: '10' },
  },
});

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function suites(workdir: string, commit: string): number {
  log(`parity: reference ${commit}, candidate ${join(REPO, 'plugin')}`);
  const reference = runReference(
    extractReference(REPO, commit, join(workdir, 'reference')),
    workdir,
  );
  const candidate = runSide(
    copyCandidate(REPO, join(workdir, 'candidate')),
    join(workdir, 'candidate-run'),
  );
  const parity = compareSides(reference, candidate);
  for (const line of report(parity, Number(values.limit))) log(line);
  console.log(
    `PARITY invocations=${String(parity.comparison.invocations)} ` +
      `differences=${String(parity.differences)}`,
  );
  return parity.differences === 0 ? 0 : 1;
}

function selftest(workdir: string, commit: string): number {
  const reference = runReference(
    extractReference(REPO, commit, join(workdir, 'reference')),
    workdir,
  );
  let detected = 0;
  MUTATIONS.forEach((mutation, index) => {
    const dest = join(workdir, `mutant-${String(index)}`);
    const pluginDir = copyCandidate(REPO, dest);
    applyMutation(pluginDir, mutation);
    const parity = compareSides(
      reference,
      runSide(pluginDir, join(dest, 'run')),
    );
    const hit = parity.differences > 0;
    if (hit) detected += 1;
    log(
      `MUTATION ${mutation.name}: differences=${String(parity.differences)} ` +
        `failed-suites=${String(parity.failedSuites.length)} ` +
        `detected=${hit ? 'yes' : 'no'}`,
    );
  });
  console.log(
    `SELFTEST mutations=${String(MUTATIONS.length)} ` +
      `detected=${String(detected)} real-e1=skipped`,
  );
  return detected === MUTATIONS.length ? 0 : 1;
}

function main(): number {
  const command = positionals[0];
  const commit = resolveRev(REPO, values.ref);
  const workdir = makeWorkdir();
  try {
    switch (command) {
      case 'suites':
        return suites(workdir, commit);
      case 'selftest':
        return selftest(workdir, commit);
      case 'real':
        log('parity real: not implemented yet');
        return 2;
      case undefined:
      default:
        log('usage: main.mjs suites|selftest|real [--ref <rev>] [--keep]');
        return 2;
    }
  } finally {
    if (values.keep) log(`parity: kept ${workdir}`);
    else rmSync(workdir, { recursive: true, force: true });
  }
}

process.exitCode = main();
