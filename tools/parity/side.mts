// Running the test suites against one plugin copy with capture enabled.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import capture from './capture.cjs';
import type { CaptureRecord } from './record-types.cjs';
import { loadRecords } from './records.mjs';
import { runSuites, type SuiteRun } from '../shared/suites.mjs';

export interface SideResult {
  readonly pluginDir: string;
  /** The TMPDIR this side's suites ran with. */
  readonly tmpRoot: string;
  readonly records: readonly CaptureRecord[];
  readonly suites: readonly SuiteRun[];
}

const FIXED_GIT_DATE = '2026-01-01T00:00:00Z';

const PRELOADS = ['determinism.cjs'].map((name) =>
  join(import.meta.dirname, name),
);

/**
 * Runs the suites of pluginDir with every product invocation captured into
 * sideDir/capture (the entry points of the copy are replaced by capture
 * wrappers first) and every temporary directory created under sideDir/tmp.
 */
export function runSide(pluginDir: string, sideDir: string): SideResult {
  const captureDir = join(sideDir, 'capture');
  const tmpRoot = join(sideDir, 'tmp');
  mkdirSync(captureDir, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  capture.installWrappers(pluginDir);
  const nodeOptions = [
    process.env['NODE_OPTIONS'] ?? '',
    ...PRELOADS.map((file) => `--require=${file}`),
  ]
    .join(' ')
    .trim();
  const suites = runSuites(pluginDir, {
    env: {
      NODE_OPTIONS: nodeOptions,
      TMPDIR: tmpRoot,
      // Commits the suites create get the same ids on both sides.
      GIT_AUTHOR_DATE: FIXED_GIT_DATE,
      GIT_COMMITTER_DATE: FIXED_GIT_DATE,
      AMBER_PARITY_DETERMINISTIC: '1',
      AMBER_PARITY_CAPTURE_DIR: captureDir,
    },
  });
  return { pluginDir, tmpRoot, records: loadRecords(captureDir), suites };
}
