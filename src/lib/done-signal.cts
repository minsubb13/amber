// Completion signal: the model runs `record.cjs done` as its last tool call,
// which writes <zone>/.amber/done.json; S2 consumes that file instead of
// parsing the final message, so no marker line reaches the operator. The file
// is single-use and short-lived.

import fs = require('node:fs');
import path = require('node:path');

import clock = require('./clock.cjs');
import guards = require('./guards.cjs');
import state = require('./state-store.cjs');
import type { DoneSignal } from './types.cjs';

// A signal older than this is a leftover of a turn that never stopped and
// must not close a later one.
const DONE_TTL_MS = 60 * 60 * 1000;

function donePath(root: string): string {
  return path.join(root, '.amber', 'done.json');
}

function writeDoneSignal(
  root: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  fs.mkdirSync(path.join(root, '.amber'), { recursive: true });
  state.writeStateAtomic(donePath(root), {
    v: 1,
    ts: clock.isoNow(),
    ...fields,
  });
}

/** A parsed signal that carries the summary and review strings. */
function isDoneSignal(value: unknown): value is DoneSignal {
  return (
    !!value &&
    typeof guards.readField(value, 'summary') === 'string' &&
    typeof guards.readField(value, 'review') === 'string'
  );
}

/**
 * Reads and consumes the zone's completion signal. Consumed on every path so
 * a rejected signal never fires twice; a malformed or stale one is dropped.
 */
function takeDoneSignal(root: string): DoneSignal | null {
  const file = donePath(root);
  if (!fs.existsSync(file)) return null;
  let signal: unknown = null;
  try {
    signal = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A corrupt signal is dropped below.
  }
  state.tryUnlink(file);
  if (!isDoneSignal(signal)) return null;
  const age = clock.nowMs() - Date.parse(guards.toText(signal.ts || 0));
  if (!(age <= DONE_TTL_MS)) return null;
  return signal;
}

export = { donePath, writeDoneSignal, takeDoneSignal };
