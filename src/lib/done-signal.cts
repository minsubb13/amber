// Completion signal: the model runs `record.cjs done` as its last tool call,
// which writes <zone>/.amber/done.json; S2 consumes that file instead of
// parsing the final message, so no marker line reaches the operator. The file
// is single-use and short-lived, and names the session that wrote it: only
// that session's Stop consumes it.

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

/** The session a parsed signal names; null for one that names none. */
function signalSession(value: unknown): string | null {
  // An unreadable signal parses to null, which names no session.
  const id = guards.isObject(value) ? value['session_id'] : undefined;
  return typeof id === 'string' && id ? id : null;
}

/** A signal file's parsed value, or null when it cannot be parsed. */
function readSignalFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Who the zone's waiting signal belongs to, without consuming it: null when
 * there is no signal file, else the session it names (null inside for a
 * signal from an older recorder that names none, or an unreadable one).
 */
function peekSignalSession(root: string): { sessionId: string | null } | null {
  const file = donePath(root);
  if (!fs.existsSync(file)) return null;
  return { sessionId: signalSession(readSignalFile(file)) };
}

/** Whether `file` is still the very file `seen` was taken from. */
function sameFile(file: string, seen: fs.Stats): boolean {
  try {
    const now = fs.statSync(file);
    return (
      now.dev === seen.dev &&
      now.ino === seen.ino &&
      now.size === seen.size &&
      now.mtimeMs === seen.mtimeMs
    );
  } catch {
    return false;
  }
}

/**
 * Reads the zone's completion signal and consumes it when `accepts` claims
 * it, given the session the signal names (null when it names none). A signal
 * the caller does not claim stays in place untouched. A claimed one is
 * consumed on every path so a rejected signal never fires twice, and a
 * malformed or stale one is dropped. `taken` says whether the file was
 * consumed.
 *
 * The file is read through one descriptor and unlinked only while the path
 * still names that file: a recorder that replaced it in the meantime (an
 * atomic rename, so a new inode) leaves the replacement for its own session,
 * and the signal read here still counts as taken. The window left is the
 * moment between that last check and the unlink.
 */
function takeDoneSignal(
  root: string,
  accepts: (sessionId: string | null) => boolean = () => true,
): { taken: boolean; signal: DoneSignal | null } {
  const file = donePath(root);
  if (!fs.existsSync(file)) return { taken: false, signal: null };
  let seen: fs.Stats | null = null;
  let signal: unknown = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      seen = fs.fstatSync(fd);
      signal = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Unreadable or not JSON: signal stays null, which names no session.
  }
  if (!accepts(signalSession(signal))) return { taken: false, signal: null };
  if (!seen || sameFile(file, seen)) state.tryUnlink(file);
  if (!isDoneSignal(signal)) return { taken: true, signal: null };
  const age = clock.nowMs() - Date.parse(guards.toText(signal.ts || 0));
  if (!(age <= DONE_TTL_MS)) return { taken: true, signal: null };
  return { taken: true, signal };
}

export = { donePath, writeDoneSignal, peekSignalSession, takeDoneSignal };
