// Preloaded into every node process of a parity run through
// NODE_OPTIONS=--require. The suites name their temporary directories with
// fs.mkdtempSync, whose random suffix would make two runs of the same build
// look different. While $AMBER_PARITY_DETERMINISTIC is set, mkdtempSync gets a
// suffix derived from the running script's file name and a per-process
// counter instead, so the same suite creates the same names on both sides.
// Each side runs with its own TMPDIR, so the names never collide; if one does
// exist, the original random behavior is used.

import crypto = require('node:crypto');
import fs = require('node:fs');
import path = require('node:path');

function install(): void {
  const original = fs.mkdtempSync.bind(fs);
  const script = path.basename(process.argv[1] ?? 'node');
  const tag = crypto
    .createHash('sha1')
    .update(script)
    .digest('hex')
    .slice(0, 2);
  let counter = 0;
  Object.defineProperty(fs, 'mkdtempSync', {
    configurable: true,
    writable: true,
    value: (prefix: string, options?: unknown): unknown => {
      counter += 1;
      const dir = `${prefix}${tag}${String(counter).padStart(4, '0')}`;
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
        return dir;
      } catch {
        return Reflect.apply(original, fs, [prefix, options]);
      }
    },
  });
}

if (process.env['AMBER_PARITY_DETERMINISTIC'] !== undefined) install();
