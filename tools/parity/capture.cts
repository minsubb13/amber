// Preloaded into every node process of a parity run through
// NODE_OPTIONS=--require. In a product process - a script directly under
// $AMBER_PARITY_PLUGIN/hooks or /scripts - it records the invocation and every
// effect Amber shows to the outside into $AMBER_PARITY_CAPTURE_DIR: argv, cwd,
// stdin, stdout, stderr, exit code, the ledger bytes appended, the state
// files changed, and the zone's .amber files after the process. In any other
// process it does nothing.

import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');

export interface FileEffect {
  readonly path: string;
  /** File content after the process, or null when the file is absent. */
  readonly content: string | null;
}

export interface CaptureRecord {
  readonly entry: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly ledger: string;
  readonly state: readonly FileEffect[];
  readonly zone: readonly FileEffect[];
}

const ZONE_FILES = ['active.json', 'progress.json', 'done.json'];

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

// Depth of stream.write calls in progress: a stream backed by a file writes
// through fs.writeSync, which must not be recorded a second time.
let streamDepth = 0;

function tapWrites(stream: NodeJS.WriteStream, sink: string[]): void {
  const original = stream.write.bind(stream);
  Object.defineProperty(stream, 'write', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]): unknown => {
      sink.push(chunkText(args[0]));
      streamDepth += 1;
      try {
        return Reflect.apply(original, stream, args);
      } finally {
        streamDepth -= 1;
      }
    },
  });
}

const STD_PATHS = new Map<unknown, 1 | 2>([
  [1, 1],
  [2, 2],
  ['/dev/stdout', 1],
  ['/dev/stderr', 2],
  ['/dev/fd/1', 1],
  ['/dev/fd/2', 2],
]);

/**
 * Records writes that reach fd 1 or 2 through fs instead of the streams
 * (fs.writeSync, fs.write, fs.writeFileSync, fs.appendFileSync), so a port
 * that changes the output channel is still compared on content.
 */
function tapFsWrites(stdout: string[], stderr: string[]): void {
  const methods: [string, number][] = [
    ['writeSync', 1],
    ['write', 1],
    ['writeFileSync', 1],
    ['appendFileSync', 1],
  ];
  for (const [name, dataIndex] of methods) {
    const original: unknown = Reflect.get(fs, name);
    if (typeof original !== 'function') continue;
    Object.defineProperty(fs, name, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const target = STD_PATHS.get(args[0]);
        if (target !== undefined && streamDepth === 0) {
          (target === 1 ? stdout : stderr).push(chunkText(args[dataIndex]));
        }
        return Reflect.apply(original, fs, args);
      },
    });
  }
}

function install(entry: string): void {
  const captureDir = process.env['AMBER_PARITY_CAPTURE_DIR'] ?? '';
  const home = process.env['AMBER_HOME'] ?? path.join(os.homedir(), '.amber');
  const ledgerFile = path.join(home, 'runs.jsonl');
  const stateDir = path.join(home, 'state');
  const ledgerStart = sizeOf(ledgerFile);
  const stateStart = stamp(stateDir);
  const cwd = process.cwd();
  const stdin: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  if (entry === 'hooks/amber-hook.cjs') {
    // Tap stdin only where the product reads it, so a script that never
    // reads stdin is not kept waiting for its end.
    let tapped = false;
    process.stdin.on('newListener', (event: string | symbol) => {
      if (event !== 'data' || tapped) return;
      tapped = true;
      process.stdin.on('data', (chunk: unknown) => {
        stdin.push(chunkText(chunk));
      });
    });
  }
  tapWrites(process.stdout, stdout);
  tapWrites(process.stderr, stderr);
  tapFsWrites(stdout, stderr);

  process.on('exit', (code: number) => {
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
      args: process.argv.slice(2),
      cwd,
      stdin: stdin.join(''),
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exitCode: code,
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
    const file = path.join(
      captureDir,
      `${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2)}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(record));
  });
}

const entry = productEntry();
if (entry !== null) install(entry);
