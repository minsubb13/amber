// Real-record parity: the reference and candidate builds run the same cases
// built from this machine's records, in scratch zones and scratch Amber homes.
// The real ledger and transcripts are only read.
//   audit  - every audit.cjs command over a snapshot of the real ledger
//   e1     - real tool calls replayed through E1 under each zone's contracts
//   s0     - the S0 briefing for every contract
//   plans  - `record.cjs unit init` for every plan with unit rows

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

import {
  stableHash,
  ZONE_PLACEHOLDER,
  type ToolCall,
  type Zone,
} from './corpus.mjs';
import { isRecord } from '../../shared/guards.mjs';
import { pool, runProcess, type ProcessResult } from '../../shared/proc.mjs';
import type { CaptureRecord } from '../capture.cjs';
import { makeNormalizer } from '../normalize.mjs';

export interface Builds {
  readonly reference: string;
  readonly candidate: string;
}

export interface Difference {
  readonly kind: string;
  readonly summary: string;
  readonly reference: string;
  readonly candidate: string;
}

export interface Tally {
  cases: number;
  /** Cases whose reference wrote something to stdout (a decision, a briefing). */
  answered: number;
  differences: Difference[];
  unstable: number;
}

function newTally(): Tally {
  return { cases: 0, answered: 0, differences: [], unstable: 0 };
}

const CONCURRENCY = 8;

function readTree(dir: string): [string, string][] {
  const out: [string, string][] = [];
  const list = (current: string): string[] => {
    try {
      return readdirSync(current).sort();
    } catch {
      return [];
    }
  };
  const walk = (current: string): void => {
    for (const name of list(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push([relative(dir, path), readFileSync(path, 'utf8')]);
    }
  };
  walk(dir);
  return out;
}

class Scratch {
  private count = 0;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  dir(prefix: string): string {
    this.count += 1;
    const dir = join(this.root, `${prefix}${String(this.count)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  home(): string {
    mkdirSync(join(this.root, 'homes'), { recursive: true });
    return mkdtempSync(join(this.root, 'homes', 'h-'));
  }
}

/** A git-initialized scratch zone holding copies of files under docs/. */
function makeZone(
  dir: string,
  files: readonly string[],
  contract: string | null,
): string {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  spawnSync('git', ['init', '-q', dir]);
  for (const file of files) {
    copyFileSync(file, join(dir, 'docs', basename(file)));
  }
  if (contract !== null) {
    mkdirSync(join(dir, '.amber'), { recursive: true });
    writeFileSync(
      join(dir, '.amber', 'active.json'),
      JSON.stringify({
        v: 1,
        boundary: `docs/${basename(contract)}`,
        ratified_by: 'parity',
        ratified_at: '2026-01-01',
      }),
    );
  }
  return dir;
}

function baseEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { AMBER_HOME: home, LANG: 'C.UTF-8' };
  for (const key of ['PATH', 'HOME', 'USER']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function record(
  entry: string,
  args: readonly string[],
  cwd: string,
  input: string,
  result: ProcessResult,
  home: string,
  extra: readonly [string, string][],
): CaptureRecord {
  return {
    entry,
    args,
    cwd,
    stdin: input,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? -1,
    ledger: '',
    state: readTree(home).map(([path, content]) => ({ path, content })),
    zone: extra.map(([path, content]) => ({ path, content })),
  };
}

interface SideRun {
  readonly record: CaptureRecord;
  readonly home: string;
}

async function runBoth(
  builds: Builds,
  scratch: Scratch,
  entry: string,
  args: readonly string[],
  cwd: string,
  input: string,
  extraEnv: NodeJS.ProcessEnv,
  after?: (side: 'reference' | 'candidate') => [string, string][],
): Promise<{ reference: SideRun; candidate: SideRun }> {
  const run = async (side: 'reference' | 'candidate'): Promise<SideRun> => {
    const home = scratch.home();
    const plugin = side === 'reference' ? builds.reference : builds.candidate;
    const result = await runProcess(
      process.execPath,
      [join(plugin, entry), ...args],
      { cwd, env: { ...baseEnv(home), ...extraEnv }, input },
    );
    const extra = after === undefined ? [] : after(side);
    return {
      record: record(entry, args, cwd, input, result, home, extra),
      home,
    };
  };
  const reference = await run('reference');
  const candidate = await run('candidate');
  return { reference, candidate };
}

function judge(
  builds: Builds,
  tally: Tally,
  kind: string,
  summary: string,
  pair: { reference: SideRun; candidate: SideRun },
): void {
  const normalize = makeNormalizer(
    [
      { text: builds.reference, label: 'PLUGIN' },
      { text: builds.candidate, label: 'PLUGIN' },
      { text: pair.reference.home, label: 'HOME' },
      { text: pair.candidate.home, label: 'HOME' },
    ],
    tmpdir(),
  );
  const ref = normalize(pair.reference.record);
  const cand = normalize(pair.candidate.record);
  tally.cases += 1;
  if (pair.reference.record.stdout.trim() !== '') tally.answered += 1;
  if (ref.input !== cand.input || ref.output !== cand.output) {
    tally.differences.push({
      kind,
      summary,
      reference: ref.output,
      candidate: cand.output,
    });
  }
}

// ---- E1 and S0 ----

class ContractZones {
  private readonly zones = new Map<string, string>();
  constructor(private readonly scratch: Scratch) {}

  get(contract: string): string {
    let dir = this.zones.get(contract);
    if (dir === undefined) {
      dir = makeZone(this.scratch.dir('contract-'), [contract], contract);
      this.zones.set(contract, dir);
    }
    return dir;
  }
}

function contractsFor(call: ToolCall, zones: readonly Zone[]): string[] {
  const zone = zones.find((z) => z.root === call.zone);
  if (zone === undefined || zone.contracts.length === 0) return [];
  // Two contracts per call, chosen by hash so every contract gets calls.
  const start = parseInt(stableHash(JSON.stringify(call)).slice(0, 8), 16);
  const picks = new Set<string>();
  for (let i = 0; i < Math.min(2, zone.contracts.length); i += 1) {
    const contract = zone.contracts[(start + i) % zone.contracts.length];
    if (contract !== undefined) picks.add(contract);
  }
  return [...picks];
}

function e1Input(call: ToolCall, root: string): string {
  const toolInput: Record<string, string> = {};
  for (const [key, value] of Object.entries(call.input)) {
    toolInput[key] = value.split(ZONE_PLACEHOLDER).join(root);
  }
  const cwd = call.cwd === '' ? root : join(root, call.cwd);
  mkdirSync(cwd, { recursive: true });
  return JSON.stringify({
    session_id: 'parity-e1',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: call.tool,
    tool_input: toolInput,
  });
}

export async function runE1Cases(
  builds: Builds,
  scratch: Scratch,
  zones: readonly Zone[],
  calls: readonly ToolCall[],
): Promise<Tally> {
  const tally = newTally();
  const contractZones = new ContractZones(scratch);
  const jobs = calls.flatMap((call) =>
    contractsFor(call, zones).map((contract) => ({ call, contract })),
  );
  await pool(jobs, CONCURRENCY, async ({ call, contract }) => {
    const root = contractZones.get(contract);
    const input = e1Input(call, root);
    const parsed: unknown = JSON.parse(input);
    const cwd =
      isRecord(parsed) && typeof parsed['cwd'] === 'string'
        ? parsed['cwd']
        : root;
    const pair = await runBoth(
      builds,
      scratch,
      'hooks/amber-hook.cjs',
      ['E1'],
      cwd,
      input,
      {},
    );
    judge(
      builds,
      tally,
      'e1',
      `${basename(call.zone)} ${call.host} ${call.tool} vs ${basename(contract)}`,
      pair,
    );
  });
  return tally;
}

export async function runS0Cases(
  builds: Builds,
  scratch: Scratch,
  zones: readonly Zone[],
): Promise<Tally> {
  const tally = newTally();
  const contractZones = new ContractZones(scratch);
  const contracts = zones.flatMap((zone) => zone.contracts);
  await pool(contracts, CONCURRENCY, async (contract) => {
    const root = contractZones.get(contract);
    const input = JSON.stringify({
      session_id: 'parity-s0',
      cwd: root,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'parity-model',
    });
    const pair = await runBoth(
      builds,
      scratch,
      'hooks/amber-hook.cjs',
      ['S0'],
      root,
      input,
      {},
    );
    judge(builds, tally, 's0', basename(contract), pair);
  });
  return tally;
}

// ---- plans ----

export async function runPlanCases(
  builds: Builds,
  scratch: Scratch,
  zones: readonly Zone[],
): Promise<Tally> {
  const tally = newTally();
  const plans = zones.flatMap((zone) => zone.plans);
  await pool(plans, CONCURRENCY, async (plan) => {
    const contract = plan.replace(/-plan\.md$/, '-contract.md');
    const hasContract = existsSync(contract);
    const root = makeZone(
      scratch.dir('plan-'),
      hasContract ? [plan, contract] : [plan],
      hasContract ? contract : null,
    );
    const progress = join(root, '.amber', 'progress.json');
    const pair = await runBoth(
      builds,
      scratch,
      'scripts/record.cjs',
      ['unit', 'init', `docs/${basename(plan)}`],
      root,
      '',
      { AMBER_SESSION_ID: 'parity-plan' },
      () => {
        const content = existsSync(progress)
          ? readFileSync(progress, 'utf8')
          : '';
        rmSync(progress, { force: true });
        return [['.amber/progress.json', content]];
      },
    );
    judge(builds, tally, 'plan', basename(plan), pair);
  });
  return tally;
}

// ---- audit ----

function sampleSessions(ledger: string, count: number): string[] {
  const ids = new Set<string>();
  for (const line of ledger.split('\n')) {
    if (line.trim() === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(row) && typeof row['session_id'] === 'string') {
      ids.add(row['session_id']);
    }
  }
  return [...ids]
    .filter((id) => id.length >= 8)
    .sort((a, b) => (stableHash(a) < stableHash(b) ? -1 : 1))
    .slice(0, count)
    .map((id) => id.slice(0, 8));
}

export async function runAuditCases(
  builds: Builds,
  scratch: Scratch,
  periodEnd: string,
): Promise<Tally> {
  const tally = newTally();
  const realHome = process.env['AMBER_HOME'] ?? join(homedir(), '.amber');
  const ledgerText = readFileSync(join(realHome, 'runs.jsonl'), 'utf8');
  const snapshot = scratch.dir('audit-home-');
  writeFileSync(join(snapshot, 'runs.jsonl'), ledgerText);
  const commands: string[][] = [
    ['summary'],
    ['dead'],
    ['sessions'],
    ['sessions', '200'],
  ];
  for (const prefix of sampleSessions(ledgerText, 30)) {
    commands.push(['session', prefix], ['check-session', prefix]);
  }
  const env = { ...baseEnv(snapshot), AMBER_HOME: snapshot };
  // check-summary reads a report: one built from the reference's own summary
  // block (it reproduces) and a copy with one line changed (it does not).
  const summary = await runProcess(
    process.execPath,
    [
      join(builds.reference, 'scripts/audit.cjs'),
      'summary',
      '--period-end',
      periodEnd,
    ],
    { cwd: snapshot, env, timeoutMs: 600_000 },
  );
  const fence = '```';
  const report = join(snapshot, 'report.md');
  writeFileSync(report, `# report\n\n${fence}\n${summary.stdout}${fence}\n`);
  const lines = summary.stdout.split('\n');
  lines[2] = `${lines[2] ?? ''} changed`;
  const changed = join(snapshot, 'report-changed.md');
  writeFileSync(changed, `# report\n\n${fence}\n${lines.join('\n')}${fence}\n`);
  commands.push(['check-summary', report], ['check-summary', changed]);
  for (const command of commands) {
    const args = [...command, '--period-end', periodEnd];
    const once = (plugin: string): Promise<ProcessResult> =>
      runProcess(
        process.execPath,
        [join(plugin, 'scripts/audit.cjs'), ...args],
        {
          cwd: snapshot,
          env,
          timeoutMs: 600_000,
        },
      );
    // Transcripts of running sessions can grow between two runs; a case
    // counts only when the reference gives the same output twice around the
    // candidate.
    let settled = false;
    for (let attempt = 0; attempt < 3 && !settled; attempt += 1) {
      const ref1 = await once(builds.reference);
      const cand = await once(builds.candidate);
      const ref2 = await once(builds.reference);
      const same = (a: ProcessResult, b: ProcessResult): boolean =>
        a.status === b.status && a.stdout === b.stdout && a.stderr === b.stderr;
      if (!same(ref1, ref2)) continue;
      settled = true;
      const toRecord = (r: ProcessResult): CaptureRecord =>
        record('scripts/audit.cjs', args, snapshot, '', r, snapshot, []);
      judge(builds, tally, 'audit', command.join(' '), {
        reference: { record: toRecord(ref1), home: snapshot },
        candidate: { record: toRecord(cand), home: snapshot },
      });
    }
    if (!settled) tally.unstable += 1;
  }
  return tally;
}

export function makeScratch(workdir: string): Scratch {
  return new Scratch(join(workdir, 'real'));
}

export type { Scratch };
