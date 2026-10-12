// Preloaded into every node process of a parity run through
// NODE_OPTIONS=--require. In a product process - a script directly under
// $AMBER_PARITY_PLUGIN/hooks or /scripts - it records the invocation and every
// effect Amber shows to the outside into $AMBER_PARITY_CAPTURE_DIR. In any
// other process it records the calls the process makes into plugin modules
// it requires (see recordCalls).
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
//
// Besides argv, cwd and stdin, a product record holds the product's other
// inputs: the environment variables Amber reads and what it finds before it
// runs (the zone's .amber files, the contract they name, Amber's state files).
// In any other process - a test suite - a plugin module the suite requires
// itself is handed back behind a proxy that records each call of an export
// with its arguments, so two suites that drive the plugin alike leave the
// same records whether they start processes or call modules.

import childProcess = require('node:child_process');
import fs = require('node:fs');
import Module = require('node:module');
import os = require('node:os');
import path = require('node:path');

import type { CaptureRecord, FileEffect } from './record-types.cjs';

const ZONE_FILES = ['active.json', 'progress.json', 'done.json'];
const INNER_ENV = 'AMBER_PARITY_INNER_RECORD';
// What src/ reads from the environment, and HOME, under which it finds
// ~/.amber, ~/.claude and ~/.codex when the variables are unset.
const ENV_KEYS = [
  'AMBER_HOME',
  'AMBER_SESSION_ID',
  'AMBER_TRANSCRIPTS',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_HOME',
  'CODEX_THREAD_ID',
  'HOME',
];
const PLUGIN_MODULE = /^(hooks|scripts|lib)\/[^/]+\.cjs$/;

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

function amberEnv(): Record<string, string | null> {
  const env: Record<string, string | null> = {};
  for (const key of ENV_KEYS) env[key] = process.env[key] ?? null;
  return env;
}

/** The zone's .amber files, the contract active.json names, the state files. */
function snapshotBefore(root: string | null, stateDir: string): FileEffect[] {
  const before: FileEffect[] = [];
  if (root !== null) {
    for (const name of ZONE_FILES) {
      before.push({
        path: `.amber/${name}`,
        content: readOrNull(path.join(root, '.amber', name)),
      });
    }
    let boundary: unknown;
    try {
      const pointer: unknown = JSON.parse(
        readOrNull(path.join(root, '.amber', 'active.json')) ?? '',
      );
      boundary =
        typeof pointer === 'object' && pointer !== null
          ? Reflect.get(pointer, 'boundary')
          : undefined;
    } catch {
      boundary = undefined;
    }
    if (typeof boundary === 'string') {
      before.push({
        path: `contract/${boundary}`,
        content: readOrNull(path.join(root, boundary)),
      });
    }
  }
  for (const name of listDir(stateDir).sort()) {
    before.push({
      path: `state/${name}`,
      content: readOrNull(path.join(stateDir, name)),
    });
  }
  return before;
}

/** JSON text of call arguments, with the values JSON has no text for named. */
function serializeArgs(values: readonly unknown[]): string {
  try {
    return JSON.stringify(values, (_key: string, value: unknown): unknown => {
      if (value === undefined) return '<undefined>';
      if (typeof value === 'function') return '<function>';
      if (typeof value === 'bigint' || typeof value === 'symbol') {
        return `<${typeof value}>`;
      }
      return value;
    });
  } catch {
    return '<unserializable>';
  }
}

function inside(dir: string, file: string): string | null {
  const rel = path.relative(dir, file);
  return rel.startsWith('..') || path.isAbsolute(rel)
    ? null
    : rel.split(path.sep).join('/');
}

/**
 * Suite side: a plugin module required by anything but another plugin module
 * (a suite in test/, or a legacy one in plugin/tests) comes back behind a
 * proxy whose exported functions record each call, with the arguments as
 * passed, into a per-process file of records. Plugin modules requiring each
 * other get the module itself, so the plugin's own calls are not recorded.
 * Reads, writes and `in` reach the module unchanged.
 */
function recordCalls(captureDir: string, pluginDir: string): void {
  const load: unknown = Reflect.get(Module, '_load');
  const resolveFilename: unknown = Reflect.get(Module, '_resolveFilename');
  if (typeof load !== 'function' || typeof resolveFilename !== 'function') {
    return;
  }
  const file = path.join(
    captureDir,
    `calls-${String(process.pid)}-${String(Math.random()).slice(2)}.jsonl`,
  );
  const proxies = new WeakMap<object, object>();
  const record = (rel: string, name: string, args: unknown[]): void => {
    const call: CaptureRecord = {
      entry: `call ${rel}#${name}`,
      args: [serializeArgs(args)],
      cwd: process.cwd(),
      env: amberEnv(),
      before: [],
      stdin: '',
      stdout: '',
      stderr: '',
      exitCode: 0,
      signal: null,
      ledger: '',
      state: [],
      zone: [],
    };
    fs.appendFileSync(file, `${JSON.stringify(call)}\n`);
  };
  const proxyFor = (exports: object, rel: string): object => {
    const known = proxies.get(exports);
    if (known !== undefined) return known;
    const wrappers = new Map<string, unknown>();
    const proxy = new Proxy(exports, {
      get: (target, key, receiver): unknown => {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== 'function' || typeof key !== 'string') {
          return value;
        }
        let wrapper = wrappers.get(key);
        if (wrapper === undefined) {
          wrapper = (...args: unknown[]): unknown => {
            record(rel, key, args);
            const result: unknown = Reflect.apply(value, target, args);
            return result;
          };
          wrappers.set(key, wrapper);
        }
        return wrapper;
      },
    });
    proxies.set(exports, proxy);
    return proxy;
  };
  Object.defineProperty(Module, '_load', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]): unknown => {
      const loaded: unknown = Reflect.apply(load, Module, args);
      const [request, parent] = args;
      const parentFile: unknown =
        typeof parent === 'object' && parent !== null
          ? Reflect.get(parent, 'filename')
          : undefined;
      const parentRel =
        typeof parentFile === 'string' ? inside(pluginDir, parentFile) : null;
      if (
        typeof request !== 'string' ||
        typeof loaded !== 'object' ||
        loaded === null ||
        (parentRel !== null && PLUGIN_MODULE.test(parentRel))
      ) {
        return loaded;
      }
      let filename: unknown;
      try {
        filename = Reflect.apply(resolveFilename, Module, args.slice(0, 3));
      } catch {
        return loaded;
      }
      const rel =
        typeof filename === 'string' ? inside(pluginDir, filename) : null;
      return rel !== null && PLUGIN_MODULE.test(rel)
        ? proxyFor(loaded, rel)
        : loaded;
    },
  });
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return '';
}

function toBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.alloc(0);
}

/**
 * Child side. The marker variable is removed before the product starts, so
 * neither the product nor any process it starts sees it. What the product
 * reads from stdin is recorded whatever API it uses: bytes enter
 * process.stdin through push() (data events, readable/read(), async
 * iteration), and fs reads of fd 0, of the paths that name it, and of
 * descriptors opened on those paths are recorded too.
 */
function recordStdin(innerFile: string): void {
  Reflect.deleteProperty(process.env, INNER_ENV);
  const stdin: string[] = [];
  const stream = process.stdin;
  const push = stream.push.bind(stream);
  Object.defineProperty(stream, 'push', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]): unknown => {
      stdin.push(chunkText(args[0]));
      return Reflect.apply(push, stream, args);
    },
  });
  // fd 0, the paths that name it, and descriptors opened on those paths.
  const stdinPaths = new Set(['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);
  const stdinFds = new Set([0]);
  const isStdin = (target: unknown): boolean =>
    (typeof target === 'number' && stdinFds.has(target)) ||
    (typeof target === 'string' && stdinPaths.has(target));
  const openSync: unknown = Reflect.get(fs, 'openSync');
  if (typeof openSync === 'function') {
    Object.defineProperty(fs, 'openSync', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const fd: unknown = Reflect.apply(openSync, fs, args);
        if (typeof fd === 'number' && isStdin(args[0])) stdinFds.add(fd);
        return fd;
      },
    });
  }
  const closeSync: unknown = Reflect.get(fs, 'closeSync');
  if (typeof closeSync === 'function') {
    Object.defineProperty(fs, 'closeSync', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(closeSync, fs, args);
        if (typeof args[0] === 'number') stdinFds.delete(args[0]);
        return result;
      },
    });
  }
  const readFileSync: unknown = Reflect.get(fs, 'readFileSync');
  if (typeof readFileSync === 'function') {
    Object.defineProperty(fs, 'readFileSync', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(readFileSync, fs, args);
        if (isStdin(args[0])) stdin.push(chunkText(result));
        return result;
      },
    });
  }
  const readSync: unknown = Reflect.get(fs, 'readSync');
  if (typeof readSync === 'function') {
    Object.defineProperty(fs, 'readSync', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(readSync, fs, args);
        const buffer = args[1];
        if (
          isStdin(args[0]) &&
          typeof result === 'number' &&
          buffer instanceof Uint8Array
        ) {
          const offset = typeof args[2] === 'number' ? args[2] : 0;
          stdin.push(chunkText(buffer.subarray(offset, offset + result)));
        }
        return result;
      },
    });
  }
  // Asynchronous reads of fd 0 or /dev/stdin: the callback forms of
  // fs.readFile and fs.read, and fs.promises.readFile.
  const readFile: unknown = Reflect.get(fs, 'readFile');
  if (typeof readFile === 'function') {
    Object.defineProperty(fs, 'readFile', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const callback = args[args.length - 1];
        if (isStdin(args[0]) && typeof callback === 'function') {
          args[args.length - 1] = (...results: unknown[]): unknown => {
            if (results[0] === null) stdin.push(chunkText(results[1]));
            const value: unknown = Reflect.apply(callback, undefined, results);
            return value;
          };
        }
        return Reflect.apply(readFile, fs, args);
      },
    });
  }
  const read: unknown = Reflect.get(fs, 'read');
  if (typeof read === 'function') {
    Object.defineProperty(fs, 'read', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const callback = args[args.length - 1];
        if (isStdin(args[0]) && typeof callback === 'function') {
          const offset = typeof args[2] === 'number' ? args[2] : 0;
          args[args.length - 1] = (...results: unknown[]): unknown => {
            const [err, count, buffer] = results;
            if (
              err === null &&
              typeof count === 'number' &&
              buffer instanceof Uint8Array
            ) {
              stdin.push(chunkText(buffer.subarray(offset, offset + count)));
            }
            const value: unknown = Reflect.apply(callback, undefined, results);
            return value;
          };
        }
        return Reflect.apply(read, fs, args);
      },
    });
  }
  const promises: unknown = Reflect.get(fs, 'promises');
  const promiseReadFile: unknown =
    typeof promises === 'object' && promises !== null
      ? Reflect.get(promises, 'readFile')
      : undefined;
  if (typeof promiseReadFile === 'function') {
    Object.defineProperty(promises, 'readFile', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(promiseReadFile, promises, args);
        if (isStdin(args[0]) && result instanceof Promise) {
          return result.then((data: unknown) => {
            stdin.push(chunkText(data));
            return data;
          });
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
  const env = amberEnv();
  const before = snapshotBefore(zoneRoot(cwd), stateDir);
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
    env,
    before,
    stdin: readOrNull(innerFile) ?? '',
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    exitCode: child.status,
    signal,
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
  process.exit(child.status ?? 1);
}

const entry = productEntry();
if (entry !== null) {
  const innerFile = process.env[INNER_ENV];
  if (innerFile === undefined) runOuter(entry);
  else recordStdin(innerFile);
} else {
  const captureDir = process.env['AMBER_PARITY_CAPTURE_DIR'];
  const pluginDir = process.env['AMBER_PARITY_PLUGIN'];
  if (captureDir !== undefined && pluginDir !== undefined) {
    recordCalls(captureDir, pluginDir);
  }
}
