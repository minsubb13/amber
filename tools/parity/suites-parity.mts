// Test-driven parity: the same suites against the reference and the candidate
// build, every product invocation captured and compared.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compare, describe, type Comparison } from './compare.mjs';
import { makeNormalizer } from './normalize.mjs';
import { runSide, type SideResult } from './side.mjs';

export interface SuitesParity {
  readonly comparison: Comparison;
  /** Suites that exited non-zero, labelled by side. */
  readonly failedSuites: readonly string[];
  readonly differences: number;
}

export function runReference(pluginDir: string, workdir: string): SideResult {
  return runSide(pluginDir, join(workdir, 'reference-run'));
}

export function compareSides(
  reference: SideResult,
  candidate: SideResult,
): SuitesParity {
  const normalize = makeNormalizer(
    [
      { text: reference.pluginDir, label: 'PLUGIN' },
      { text: candidate.pluginDir, label: 'PLUGIN' },
      { text: reference.tmpRoot, label: 'TMPROOT' },
      { text: candidate.tmpRoot, label: 'TMPROOT' },
    ],
    tmpdir(),
  );
  const comparison = compare(
    reference.records.map(normalize),
    candidate.records.map(normalize),
  );
  const failedSuites = [
    ...reference.suites
      .filter((run) => run.status !== 0)
      .map((run) => `reference ${run.suite}`),
    ...candidate.suites
      .filter((run) => run.status !== 0)
      .map((run) => `candidate ${run.suite}`),
  ];
  return {
    comparison,
    failedSuites,
    differences: comparison.differences + failedSuites.length,
  };
}

export function report(parity: SuitesParity, limit: number): string[] {
  const lines = parity.failedSuites.map((suite) => `suite failed: ${suite}`);
  return [...lines, ...describe(parity.comparison, limit)];
}
