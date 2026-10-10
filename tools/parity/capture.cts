// Preloaded into every node process of a parity run through
// NODE_OPTIONS=--require. In a product process - a script directly under
// $AMBER_PARITY_PLUGIN/hooks or /scripts - it records the invocation and every
// effect Amber shows to the outside into $AMBER_PARITY_CAPTURE_DIR. In any
// other process it does nothing.
//
// Output is captured at the file descriptor level without touching the
// product: before the product's own module runs, the preload re-runs the same
// command (same node flags, same script path and arguments, same environment,
// the same stdin inherited) as a child with stdout and stderr piped, so every
// write to descriptors 1 and 2 - through streams, fs, native code, or a
// grandchild that inherits them - reaches the pipes. The outer process then
// writes the record, forwards the output, and ends the way the child ended
// (exit code, or the same signal); the product never runs in it. Inside the
// child the preload only records what the product read from stdin.

import childProcess = require('node:child_process');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');

import type { CaptureRecord } from './record-types.cjs';

const ZONE_FILES = ['active.json', 'progress.json', 'done.json'];
const INNER_ENV = 'AMBER_PARITY_INNER_RECORD';

function productEntry(): string | null {
  const captureDir = process.env['AMBER_PARITY_CAPTURE_DIR'];
  const pluginDir = process.env['AMBER_PARITY_PLUGIN'];
  const script = process.argv[1];
  if (
    captureDir === undefined ||
    pluginDir === undefined ||
    script === undefined
  ) {
    return null;
  }
  const rel = path
    .relative(pluginDir, path.resolve(script))
    .split(path.sep)
    .join('/');
  return /^(hooks|scripts)\/[^/]+\.cjs$/.test(rel) ? rel : null;
}

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

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return '';
}

function toBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.alloc(0);
}

/** Child side: record what the product reads from stdin, for the record. */
function recordStdin(innerFile: string): void {
  const stdin: string[] = [];
  let tapped = false;
  process.stdin.on('newListener', (event: string | symbol) => {
    if (event !== 'data' || tapped) return;
    tapped = true;
    process.stdin.on('data', (chunk: unknown) => {
      stdin.push(chunkText(chunk));
    });
  });
  const original: unknown = Reflect.get(fs, 'readFileSync');
  if (typeof original === 'function') {
    Object.defineProperty(fs, 'readFileSync', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(original, fs, args);
        if (args[0] === 0 || args[0] === '/dev/stdin') {
          stdin.push(chunkText(result));
        }
        return result;
      },
    });
  }
  process.on('exit', () => {
    fs.writeFileSync(innerFile, stdin.join(''));
  });
}

/** Outer side: run the command as a child, record, forward, end alike. */
function runOuter(entry: string): never {
  const captureDir = process.env['AMBER_PARITY_CAPTURE_DIR'] ?? os.tmpdir();
  const home = process.env['AMBER_HOME'] ?? path.join(os.homedir(), '.amber');
  const ledgerFile = path.join(home, 'runs.jsonl');
  const stateDir = path.join(home, 'state');
  const ledgerStart = sizeOf(ledgerFile);
  const stateStart = stamp(stateDir);
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const tag = `${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2)}`;
  const innerFile = path.join(captureDir, `${tag}.stdin`);

  const child = childProcess.spawnSync(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, [INNER_ENV]: innerFile },
      maxBuffer: 1024 * 1024 * 1024,
    },
  );
  const stdout = toBuffer(child.stdout);
  const stderr =
    child.error === undefined
      ? toBuffer(child.stderr)
      : Buffer.concat([
          toBuffer(child.stderr),
          Buffer.from(`parity capture: ${child.error.message}\n`),
        ]);
  const signal = child.signal;
  const exitCode =
    child.status ?? (signal === null ? 1 : 128 + os.constants.signals[signal]);

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
    stdin: readOrNull(innerFile) ?? '',
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
  fs.rmSync(innerFile, { force: true });
  fs.writeFileSync(
    path.join(captureDir, `${tag}.json`),
    JSON.stringify(record),
  );
  if (stdout.length > 0) fs.writeSync(1, stdout);
  if (stderr.length > 0) fs.writeSync(2, stderr);
  if (signal !== null) process.kill(process.pid, signal);
  process.exit(exitCode);
}

const entry = productEntry();
if (entry !== null) {
  const innerFile = process.env[INNER_ENV];
  if (innerFile === undefined) runOuter(entry);
  else recordStdin(innerFile);
}
