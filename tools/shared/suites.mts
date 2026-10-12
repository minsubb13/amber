// The plugin's test suites and how to run them against any plugin directory.
// The suites are node:test files under test/, compiled to build/test; they
// find the plugin under test through AMBER_PLUGIN_DIR. Revisions before the
// TypeScript suites kept CommonJS suites in plugin/tests (run-tests.cjs, a
// standalone runner, and *-tests.cjs node:test files); runLegacySuites runs
// such a directory, for comparisons against those revisions.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPO } from './paths.mjs';

/** The compiled suites. */
export const TEST_DIR = join(REPO, 'build', 'test');

/** Runs first, where the legacy standalone runner ran. */
const FIRST_SUITE = 'run.test.mjs';

/** The compiled suites in run order, as absolute paths. */
export function testFiles(): string[] {
  const rest = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.mjs') && name !== FIRST_SUITE)
    .sort();
  return [FIRST_SUITE, ...rest].map((name) => join(TEST_DIR, name));
}

/**
 * Suites written after the move to TypeScript rather than ported from a
 * legacy suite: parity:tests compares the legacy suites with their ports only.
 */
const ADDED_AFTER_PORT = new Set(['characterization-final.test.mjs']);

/** The compiled suites that port a legacy suite, in run order. */
export function portedTestFiles(): string[] {
  return testFiles().filter(
    (file) => !ADDED_AFTER_PORT.has(file.slice(TEST_DIR.length + 1)),
  );
}

export const LEGACY_RUNNER = 'tests/run-tests.cjs';

/** The legacy node:test files of a plugin directory, relative to it. */
export function legacyNodeTestFiles(pluginDir: string): string[] {
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
  /** Report node:test results as TAP, whose test lines name each test. */
  readonly tap?: boolean;
  /** The compiled suites to run; every suite when absent. */
  readonly files?: readonly string[];
}

function spawnNode(
  args: readonly string[],
  pluginDir: string,
  options: SuiteOptions,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, {
    cwd: pluginDir,
    env: { ...process.env, ...options.env, AMBER_PLUGIN_DIR: pluginDir },
    encoding: 'utf8',
    stdio: options.inherit === true ? 'inherit' : 'pipe',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function nodeTestArgs(options: SuiteOptions): string[] {
  return [
    '--test',
    '--test-concurrency=1',
    ...(options.tap === true ? ['--test-reporter=tap'] : []),
  ];
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
 * Runs every suite in one serial `node --test` process inside pluginDir.
 * Serial order keeps the product invocations of a run reproducible.
 */
export function runSuites(
  pluginDir: string,
  options: SuiteOptions = {},
): SuiteRun[] {
  const run = spawnNode(
    [...nodeTestArgs(options), ...(options.files ?? testFiles())],
    pluginDir,
    options,
  );
  return [finish('node --test', run)];
}

/**
 * Runs the legacy suites of pluginDir/tests: run-tests.cjs, then every
 * node:test file in one serial `node --test` process, inside pluginDir.
 */
export function runLegacySuites(
  pluginDir: string,
  options: SuiteOptions = {},
): SuiteRun[] {
  const runner = spawnNode([LEGACY_RUNNER], pluginDir, options);
  const nodeTests = spawnNode(
    [...nodeTestArgs(options), ...legacyNodeTestFiles(pluginDir)],
    pluginDir,
    options,
  );
  return [finish(LEGACY_RUNNER, runner), finish('node --test', nodeTests)];
}
