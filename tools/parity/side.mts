// Running the test suites against one plugin copy with capture enabled.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { CaptureRecord } from './record-types.cjs';
import { loadRecords } from './records.mjs';
import {
  runLegacySuites,
  runSuites,
  type SuiteRun,
} from '../shared/suites.mjs';

export interface SideResult {
  readonly pluginDir: string;
  /** The TMPDIR this side's suites ran with. */
  readonly tmpRoot: string;
  readonly records: readonly CaptureRecord[];
  readonly suites: readonly SuiteRun[];
}

const FIXED_GIT_DATE = '2026-01-01T00:00:00Z';

const PRELOADS = ['determinism.cjs', 'capture.cjs'].map((name) =>
  join(import.meta.dirname, name),
);

export interface SideOptions {
  /** Run the legacy suites of pluginDir/tests instead of test/. */
  readonly legacy?: boolean;
  /** The compiled suites of test/ to run; every suite when absent. */
  readonly files?: readonly string[];
}

/**
 * Runs the suites against pluginDir with every product invocation captured
 * into sideDir/capture (see capture.cts) and every temporary directory
 * created under sideDir/tmp. node:test reports in TAP, which names each test.
 */
export function runSide(
  pluginDir: string,
  sideDir: string,
  options: SideOptions = {},
): SideResult {
  const captureDir = join(sideDir, 'capture');
  const tmpRoot = join(sideDir, 'tmp');
  mkdirSync(captureDir, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  const nodeOptions = [
    process.env['NODE_OPTIONS'] ?? '',
    ...PRELOADS.map((file) => `--require=${file}`),
  ]
    .join(' ')
    .trim();
  const run = options.legacy === true ? runLegacySuites : runSuites;
  const suites = run(pluginDir, {
    tap: true,
    ...(options.files === undefined ? {} : { files: options.files }),
    env: {
      NODE_OPTIONS: nodeOptions,
      TMPDIR: tmpRoot,
      // Commits the suites create get the same ids on both sides.
      GIT_AUTHOR_DATE: FIXED_GIT_DATE,
      GIT_COMMITTER_DATE: FIXED_GIT_DATE,
      AMBER_PARITY_DETERMINISTIC: '1',
      AMBER_PARITY_CAPTURE_DIR: captureDir,
      AMBER_PARITY_PLUGIN: pluginDir,
    },
  });
  return { pluginDir, tmpRoot, records: loadRecords(captureDir), suites };
}
