// Capture of product processes for the test-driven parity run.
//
// In each plugin copy under comparison, every product entry point
// (ENTRY_POINTS) is moved to <name>.parity-real.cjs and replaced by a small
// wrapper (wrapperSource). Run as a program, the wrapper starts the real entry
// as a child process with piped stdin, stdout and stderr, so everything the
// product writes to file descriptors 1 and 2 - through streams, fs, native
// code, or a grandchild that inherits them - passes through the pipes and is
// recorded. It then forwards the output and exit code unchanged, and writes
// one CaptureRecord into $AMBER_PARITY_CAPTURE_DIR: argv, cwd, stdin, stdout,
// stderr, exit code, the ledger bytes appended, the state files changed, and
// the zone's .amber files afterwards. Required as a module (record.cjs
// requires the hook), the wrapper hands back the real module.

import childProcess = require('node:child_process');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');

import type { CaptureRecord } from './record-types.cjs';

/** Product files that hosts and tests run as programs. */
const ENTRY_POINTS = [
  'hooks/amber-hook.cjs',
  'scripts/record.cjs',
  'scripts/audit.cjs',
];

const REAL_SUFFIX = '.parity-real.cjs';

const ZONE_FILES = ['active.json', 'progress.json', 'done.json'];

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function stamp(dir: string): Map<string, string> {
  const stamps = new Map<string, string>();
  for (const name of listDir(dir)) {
    try {
      const st = fs.statSync(path.join(dir, name));
      stamps.set(name, `${String(st.mtimeMs)}:${String(st.size)}`);
    } catch {
      // Removed while listing; the exit-time stamp will show it.
    }
  }
  return stamps;
}

function zoneRoot(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.amber'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readStdin(): Buffer {
  if (process.stdin.isTTY) return Buffer.alloc(0);
  try {
    return fs.readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
}

/** Runs the real entry as a child, forwards its output, records the run. */
function runWrapped(entry: string, real: string): void {
  const captureDir = process.env['AMBER_PARITY_CAPTURE_DIR'] ?? os.tmpdir();
  const home = process.env['AMBER_HOME'] ?? path.join(os.homedir(), '.amber');
  const ledgerFile = path.join(home, 'runs.jsonl');
  const stateDir = path.join(home, 'state');
  const ledgerStart = sizeOf(ledgerFile);
  const stateStart = stamp(stateDir);
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const stdin = readStdin();

  const child = childProcess.spawnSync(process.execPath, [real, ...args], {
    input: stdin,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  const exitCode = child.status ?? 1;

  const ledgerNow = readOrNull(ledgerFile) ?? '';
  const stateNow = stamp(stateDir);
  const changed = new Set<string>();
  for (const [name, value] of stateNow) {
    if (stateStart.get(name) !== value) changed.add(name);
  }
  for (const name of stateStart.keys()) {
    if (!stateNow.has(name)) changed.add(name);
  }
  const root = zoneRoot(cwd);
  const record: CaptureRecord = {
    entry,
    args,
    cwd,
    stdin: stdin.toString('utf8'),
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    exitCode,
    ledger: Buffer.from(ledgerNow, 'utf8')
      .subarray(ledgerStart)
      .toString('utf8'),
    state: [...changed].sort().map((name) => ({
      path: `state/${name}`,
      content: readOrNull(path.join(stateDir, name)),
    })),
    zone:
      root === null
        ? []
        : ZONE_FILES.map((name) => ({
            path: `.amber/${name}`,
            content: readOrNull(path.join(root, '.amber', name)),
          })),
  };
  fs.writeFileSync(
    path.join(
      captureDir,
      `${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2)}.json`,
    ),
    JSON.stringify(record),
  );
  if (stdout.length > 0) fs.writeSync(1, stdout);
  if (stderr.length > 0) fs.writeSync(2, stderr);
  process.exitCode = exitCode;
}

/** Source of the wrapper that takes the place of `entry` in a copy. */
function wrapperSource(entry: string): string {
  const real = `${path.basename(entry, '.cjs')}${REAL_SUFFIX}`;
  const runtime = path.join(__dirname, 'capture.cjs');
  return [
    "'use strict';",
    '// Parity capture wrapper (tools/parity/capture.cts); not part of Amber.',
    `const real = require('node:path').join(__dirname, ${JSON.stringify(real)});`,
    'if (require.main === module) {',
    `  require(${JSON.stringify(runtime)}).runWrapped(${JSON.stringify(entry)}, real);`,
    '} else {',
    '  module.exports = require(real);',
    '}',
    '',
  ].join('\n');
}

/** Replaces every entry point of a plugin copy with its wrapper. */
function installWrappers(pluginDir: string): void {
  for (const entry of ENTRY_POINTS) {
    const file = path.join(pluginDir, entry);
    const real = path.join(
      path.dirname(file),
      `${path.basename(entry, '.cjs')}${REAL_SUFFIX}`,
    );
    fs.renameSync(file, real);
    // A shebang entry stays executable as a program.
    fs.writeFileSync(file, wrapperSource(entry), {
      mode: fs.statSync(real).mode,
    });
  }
}

export = {
  ENTRY_POINTS,
  REAL_SUFFIX,
  runWrapped,
  wrapperSource,
  installWrappers,
};
