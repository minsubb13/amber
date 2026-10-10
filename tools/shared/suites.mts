// The plugin's test suites and how to run them against any plugin directory.
// The legacy suites stay CommonJS under plugin/tests: run-tests.cjs is a
// standalone runner, every other *-tests.cjs file is a node:test file.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const RUNNER_SUITE = 'tests/run-tests.cjs';

/** The node:test files of a plugin directory, relative to it, sorted. */
export function nodeTestFiles(pluginDir: string): string[] {
  return readdirSync(join(pluginDir, 'tests'))
    .filter((name) => name.endsWith('-tests.cjs') && name !== 'run-tests.cjs')
    .sort()
    .map((name) => `tests/${name}`);
}

export interface SuiteRun {
  readonly suite: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SuiteOptions {
  /** Extra environment for every suite process. */
  readonly env?: NodeJS.ProcessEnv;
  /** Stream suite output to this process instead of capturing it. */
  readonly inherit?: boolean;
}

function finish(suite: string, result: SpawnSyncReturns<string>): SuiteRun {
  return {
    suite,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Runs run-tests.cjs, then every node:test file in one serial `node --test`
 * process, inside pluginDir. Serial order keeps the product invocations of a
 * run reproducible.
 */
export function runSuites(
  pluginDir: string,
  options: SuiteOptions = {},
): SuiteRun[] {
  const env = { ...process.env, ...options.env };
  const stdio = options.inherit === true ? 'inherit' : 'pipe';
  const runner = spawnSync(process.execPath, [RUNNER_SUITE], {
    cwd: pluginDir,
    env,
    encoding: 'utf8',
    stdio,
    maxBuffer: 256 * 1024 * 1024,
  });
  const nodeTests = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...nodeTestFiles(pluginDir)],
    {
      cwd: pluginDir,
      env,
      encoding: 'utf8',
      stdio,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return [finish(RUNNER_SUITE, runner), finish('node --test', nodeTests)];
}
