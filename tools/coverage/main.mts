// `npm run coverage`: line coverage of the plugin's product files under every
// test suite, child processes included (NODE_V8_COVERAGE is inherited by each
// node process the suites spawn), reported through c8.
//   --plugin <dir>  measure another plugin copy (default: plugin/)
// Prints one COVERAGE line per product file with its uncovered line ranges,
// then the total as the last line.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isRecord } from '../shared/guards.mjs';
import { runSuites } from '../shared/suites.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PRODUCT_GLOBS = ['hooks/*.cjs', 'scripts/*.cjs'];

const { values } = parseArgs({
  options: { plugin: { type: 'string', default: join(REPO, 'plugin') } },
});

interface FileCoverage {
  readonly file: string;
  readonly total: number;
  readonly uncovered: readonly number[];
}

/** Uncovered lines from an istanbul coverage-final.json entry. */
function fileCoverage(file: string, entry: unknown): FileCoverage | null {
  if (!isRecord(entry)) return null;
  const { statementMap, s } = entry;
  if (!isRecord(statementMap) || !isRecord(s)) return null;
  const lines = new Map<number, boolean>();
  for (const [id, location] of Object.entries(statementMap)) {
    if (!isRecord(location)) continue;
    const start = location['start'];
    if (!isRecord(start) || typeof start['line'] !== 'number') continue;
    const count = s[id];
    const line = start['line'];
    const hit = typeof count === 'number' && count > 0;
    lines.set(line, (lines.get(line) ?? false) || hit);
  }
  const uncovered = [...lines]
    .filter(([, hit]) => !hit)
    .map(([line]) => line)
    .sort((a, b) => a - b);
  return { file, total: lines.size, uncovered };
}

function ranges(lines: readonly number[]): string {
  const parts: string[] = [];
  let start: number | null = null;
  let prev = 0;
  for (const line of lines) {
    if (start === null) {
      start = line;
    } else if (line !== prev + 1) {
      parts.push(
        start === prev ? String(start) : `${String(start)}-${String(prev)}`,
      );
      start = line;
    }
    prev = line;
  }
  if (start !== null) {
    parts.push(
      start === prev ? String(start) : `${String(start)}-${String(prev)}`,
    );
  }
  return parts.join(',');
}

function main(): number {
  const pluginDir = resolve(values.plugin);
  const rawDir = mkdtempSync(join(tmpdir(), 'amber-coverage-'));
  const reportDir = join(REPO, 'build', 'coverage');
  try {
    const suites = runSuites(pluginDir, {
      env: { NODE_V8_COVERAGE: rawDir },
    });
    for (const run of suites) {
      if (run.status !== 0) {
        process.stderr.write(`coverage: suite failed: ${run.suite}\n`);
        return 1;
      }
    }
    const report = spawnSync(
      process.execPath,
      [
        join(REPO, 'node_modules', 'c8', 'bin', 'c8.js'),
        'report',
        '--temp-directory',
        rawDir,
        '--reports-dir',
        reportDir,
        '--reporter',
        'json',
        '--exclude-node-modules',
        ...PRODUCT_GLOBS.flatMap((glob) => ['--include', glob]),
      ],
      { cwd: pluginDir, encoding: 'utf8' },
    );
    if (report.status !== 0) {
      process.stderr.write(`coverage: c8 report failed\n${report.stderr}`);
      return 1;
    }
    const final: unknown = JSON.parse(
      readFileSync(join(reportDir, 'coverage-final.json'), 'utf8'),
    );
    if (!isRecord(final)) throw new Error('unexpected c8 output');
    let total = 0;
    let covered = 0;
    for (const file of Object.keys(final).sort()) {
      const coverage = fileCoverage(relative(pluginDir, file), final[file]);
      if (coverage === null) continue;
      total += coverage.total;
      covered += coverage.total - coverage.uncovered.length;
      console.log(
        `COVERAGE ${coverage.file} lines=${String(coverage.total - coverage.uncovered.length)}/` +
          `${String(coverage.total)} uncovered=${ranges(coverage.uncovered) || '-'}`,
      );
    }
    console.log(`COVERAGE total lines=${String(covered)}/${String(total)}`);
    return 0;
  } finally {
    rmSync(rawDir, { recursive: true, force: true });
  }
}

process.exitCode = main();
