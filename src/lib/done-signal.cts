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

/** The prefix of a signal file a Stop has claimed but not yet settled. */
const CLAIM_PREFIX = 'done.json.taking-';

let claimSeq = 0;

/**
 * Removes claimed signal files older than the signal TTL: a foreign signal
 * left behind by a failed restore (see takeDoneSignal) would be stale by then
 * and is never consumed, so leftovers cannot accumulate.
 */
function sweepClaims(root: string): void {
  const dir = path.join(root, '.amber');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(CLAIM_PREFIX)) continue;
    const file = path.join(dir, name);
    try {
      if (clock.nowMs() - fs.statSync(file).mtimeMs > DONE_TTL_MS) {
        state.tryUnlink(file);
      }
    } catch {
      // Gone meanwhile.
    }
  }
}

/** The error code of a failed file operation, if it carries one. */
function errorCode(err: unknown): unknown {
  return guards.isObject(err) ? err['code'] : undefined;
}

/**
 * Reads the zone's completion signal and consumes it when `accepts` claims
 * it, given the session the signal names (null when it names none). A signal
 * the caller does not claim stays in place untouched. A claimed one is
 * consumed on every path so a rejected signal never fires twice, and a
 * malformed or stale one is dropped. `taken` says whether a signal was
 * consumed.
 *
 * Consuming renames done.json to a claim file first. The rename is atomic, so
 * the claim holds exactly one file and a recorder that writes after it lands
 * in a fresh done.json this Stop never touches. The claimed file is then read
 * and judged again: when a replacement slipped in between the first read and
 * the rename it is not this caller's, so it is linked back to done.json and
 * the claim dropped. If yet another signal took done.json before that link
 * (EEXIST), the claimed foreign one is superseded as a plain overwrite would
 * have left it, and it stays as a claim file for sweepClaims to remove once
 * it is older than the TTL. `afterClaim` runs right after the rename; tests
 * use it to write a replacement at that moment.
 */
function takeDoneSignal(
  root: string,
  accepts: (sessionId: string | null) => boolean = () => true,
  afterClaim: () => void = () => {},
): { taken: boolean; signal: DoneSignal | null } {
  sweepClaims(root);
  const file = donePath(root);
  if (!fs.existsSync(file)) return { taken: false, signal: null };
  if (!accepts(signalSession(readSignalFile(file)))) {
    return { taken: false, signal: null };
  }
  claimSeq += 1;
  const claimed = path.join(
    root,
    '.amber',
    CLAIM_PREFIX +
      String(process.pid) +
      '-' +
      String(clock.nowMs()) +
      '-' +
      String(claimSeq),
  );
  try {
    fs.renameSync(file, claimed);
  } catch (err) {
    // Another Stop took it meanwhile.
    if (errorCode(err) === 'ENOENT') return { taken: false, signal: null };
    throw err;
  }
  afterClaim();
  const signal = readSignalFile(claimed);
  if (!accepts(signalSession(signal))) {
    try {
      fs.linkSync(claimed, file);
      state.tryUnlink(claimed);
    } catch {
      // A newer signal holds done.json: the claimed one stays for the sweep.
    }
    return { taken: false, signal: null };
  }
  state.tryUnlink(claimed);
  if (!isDoneSignal(signal)) return { taken: true, signal: null };
  const age = clock.nowMs() - Date.parse(guards.toText(signal.ts || 0));
  if (!(age <= DONE_TTL_MS)) return { taken: true, signal: null };
  return { taken: true, signal };
}

export = { donePath, writeDoneSignal, peekSignalSession, takeDoneSignal };
