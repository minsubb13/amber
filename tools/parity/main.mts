// Entry point of the parity harness.
//   suites   [--ref <rev>]  test-driven comparison, reference vs working tree
//   selftest [--ref <rev>]  every mutation in selftest.mts must be detected,
//                           and the E1 mutation also by the real-record replay
//   real     [--ref <rev>]  comparison over the real ledger and transcripts
// The last line of each command is the machine-readable verdict; progress and
// difference reports go to stderr.

import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  discoverZones,
  harvestCalls,
  sampleCalls,
  type ToolCall,
  type Zone,
} from './real/corpus.mjs';
import {
  makeScratch,
  runAuditCases,
  runE1Cases,
  runPlanCases,
  runS0Cases,
  type Builds,
  type Tally,
} from './real/run.mjs';
import { CONTROLS, MUTATIONS, PROBES } from './selftest.mjs';
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
/** Real tool calls replayed per zone in `real`, and in the self-test. */
const PER_ZONE = 600;
const PER_ZONE_SELFTEST = 80;

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

interface Corpus {
  readonly zones: readonly Zone[];
  readonly calls: ReadonlyMap<string, ToolCall>;
}

async function loadCorpus(): Promise<Corpus> {
  const started = Date.now();
  const home = homedir();
  const codexHome = process.env['CODEX_HOME'] ?? join(home, '.codex');
  const zones = discoverZones(home);
  const calls = await harvestCalls(zones, {
    claudeProjects: join(home, '.claude', 'projects'),
    codexDirs: [
      join(codexHome, 'sessions'),
      join(codexHome, 'archived_sessions'),
    ],
  });
  log(
    `real: ${String(zones.length)} zones, ` +
      `${String(zones.reduce((n, z) => n + z.contracts.length, 0))} contracts, ` +
      `${String(zones.reduce((n, z) => n + z.plans.length, 0))} plans, ` +
      `${String(calls.size)} unique tool calls ` +
      `(${String(Math.round((Date.now() - started) / 1000))}s)`,
  );
  return { zones, calls };
}

function reportTally(name: string, tally: Tally, limit: number): void {
  log(
    `real ${name}: cases=${String(tally.cases)} ` +
      `answered=${String(tally.answered)} ` +
      `differences=${String(tally.differences.length)} ` +
      `unstable=${String(tally.unstable)}`,
  );
  for (const diff of tally.differences.slice(0, limit)) {
    let at = 0;
    while (
      at < diff.reference.length &&
      diff.reference[at] === diff.candidate[at]
    ) {
      at += 1;
    }
    log(`- ${diff.kind} ${diff.summary} (first difference at ${String(at)})`);
    log(`  reference: ${JSON.stringify(diff.reference.slice(at, at + 100))}`);
    log(`  candidate: ${JSON.stringify(diff.candidate.slice(at, at + 100))}`);
  }
}

async function real(workdir: string, commit: string): Promise<number> {
  const started = Date.now();
  const builds: Builds = {
    reference: extractReference(REPO, commit, join(workdir, 'reference')),
    candidate: copyCandidate(REPO, join(workdir, 'candidate')),
  };
  const scratch = makeScratch(workdir);
  const corpus = await loadCorpus();
  const sample = sampleCalls(corpus.calls, PER_ZONE);
  const byTool = new Map<string, number>();
  for (const call of sample) {
    const key = `${call.host}/${call.tool}`;
    byTool.set(key, (byTool.get(key) ?? 0) + 1);
  }
  log(`real: sample by host/tool ${JSON.stringify([...byTool].sort())}`);
  const periodEnd = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const limit = Number(values.limit);
  const audit = await runAuditCases(builds, scratch, periodEnd);
  reportTally('audit', audit, limit);
  const e1 = await runE1Cases(builds, scratch, corpus.zones, sample);
  reportTally('e1', e1, limit);
  const s0 = await runS0Cases(builds, scratch, corpus.zones);
  reportTally('s0', s0, limit);
  const plans = await runPlanCases(builds, scratch, corpus.zones);
  reportTally('plans', plans, limit);
  const differences = [audit, e1, s0, plans].reduce(
    (n, tally) => n + tally.differences.length,
    0,
  );
  log(
    `real: e1 evaluations=${String(e1.cases)}, elapsed ` +
      `${String(Math.round((Date.now() - started) / 1000))}s`,
  );
  console.log(
    `REAL audit=${String(audit.cases)} e1=${String(sample.length)} ` +
      `s0=${String(s0.cases)} plans=${String(plans.cases)} ` +
      `differences=${String(differences)}`,
  );
  return differences === 0 && audit.unstable === 0 ? 0 : 1;
}

async function selftest(workdir: string, commit: string): Promise<number> {
  const referencePlugin = extractReference(
    REPO,
    commit,
    join(workdir, 'reference'),
  );
  const reference = runReference(referencePlugin, workdir);
  let detected = 0;
  const mutants: string[] = [];
  MUTATIONS.forEach((mutation, index) => {
    const dest = join(workdir, `mutant-${String(index)}`);
    const pluginDir = copyCandidate(REPO, dest);
    applyMutation(pluginDir, mutation);
    mutants.push(pluginDir);
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
  let controlsClean = 0;
  CONTROLS.forEach((control, index) => {
    const dest = join(workdir, `control-${String(index)}`);
    const pluginDir = copyCandidate(REPO, dest);
    applyMutation(pluginDir, control);
    const parity = compareSides(
      reference,
      runSide(pluginDir, join(dest, 'run')),
    );
    if (parity.differences === 0) controlsClean += 1;
    log(
      `CONTROL ${control.name}: differences=${String(parity.differences)} ` +
        `clean=${parity.differences === 0 ? 'yes' : 'no'}`,
    );
  });
  let probesDetected = 0;
  PROBES.forEach((probe, index) => {
    const dest = join(workdir, `probe-${String(index)}`);
    const pluginDir = copyCandidate(REPO, dest);
    applyMutation(pluginDir, probe);
    const parity = compareSides(
      reference,
      runSide(pluginDir, join(dest, 'run')),
    );
    const hit = parity.comparison.differences > 0;
    if (hit) probesDetected += 1;
    log(
      `PROBE ${probe.name}: record-differences=${String(parity.comparison.differences)} ` +
        `failed-suites=${String(parity.failedSuites.length)} ` +
        `detected=${hit ? 'yes' : 'no'}`,
    );
  });
  // The E1 mutation replayed over real tool calls.
  const e1Index = MUTATIONS.findIndex(
    (m) => m.name === 'E1 bash-deny decision',
  );
  const e1Mutant = mutants[e1Index];
  let realE1 = 0;
  if (e1Mutant !== undefined) {
    const corpus = await loadCorpus();
    const tally = await runE1Cases(
      { reference: referencePlugin, candidate: e1Mutant },
      makeScratch(workdir),
      corpus.zones,
      sampleCalls(corpus.calls, PER_ZONE_SELFTEST),
    );
    realE1 = tally.differences.length > 0 ? 1 : 0;
    log(
      `MUTATION E1 bash-deny decision (real calls): cases=${String(tally.cases)} ` +
        `differences=${String(tally.differences.length)}`,
    );
  }
  console.log(
    `SELFTEST mutations=${String(MUTATIONS.length)} ` +
      `detected=${String(detected)} ` +
      `controls-clean=${String(controlsClean)}/${String(CONTROLS.length)} ` +
      `probes-detected=${String(probesDetected)}/${String(PROBES.length)} ` +
      `real-e1=${String(realE1)}`,
  );
  return detected === MUTATIONS.length &&
    realE1 === 1 &&
    controlsClean === CONTROLS.length &&
    probesDetected === PROBES.length
    ? 0
    : 1;
}

async function main(): Promise<number> {
  const command = positionals[0];
  const commit = resolveRev(REPO, values.ref);
  const workdir = makeWorkdir();
  try {
    switch (command) {
      case 'suites':
        return suites(workdir, commit);
      case 'selftest':
        return await selftest(workdir, commit);
      case 'real':
        return await real(workdir, commit);
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

process.exitCode = await main();
