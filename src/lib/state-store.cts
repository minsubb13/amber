// Amber's home: the ledger file and the per-session state files under
// $AMBER_HOME (default ~/.amber), resolved once when the plugin loads. State
// files are small JSON objects replaced atomically; reading one that is
// missing or unreadable gives {}.

import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');

import clock = require('./clock.cjs');
import guards = require('./guards.cjs');

const AMBER_HOME =
  process.env['AMBER_HOME'] || path.join(os.homedir(), '.amber');
const STATE_DIR = path.join(AMBER_HOME, 'state');
const RUNS_FILE = path.join(AMBER_HOME, 'runs.jsonl');
const FAILURES_FILE = path.join(STATE_DIR, 'sensor-failures.log');

/** A session id reduced to a safe file-name part. */
function safeId(id: unknown): string {
  const cleaned = guards
    .toText(id || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);
  return cleaned || 'unknown';
}

function ensureDirs(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function sessionStatePath(sessionId: unknown): string {
  return path.join(STATE_DIR, 'session-' + safeId(sessionId) + '.json');
}

function loopStatePath(sessionId: unknown): string {
  return path.join(STATE_DIR, 'loop-' + safeId(sessionId) + '.json');
}

function gateStatePath(sessionId: unknown): string {
  return path.join(STATE_DIR, 'gate-' + safeId(sessionId) + '.json');
}

function writeStateAtomic(file: string, value: unknown): void {
  const tmp = file + '.tmp-' + String(process.pid);
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function tryUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/**
 * Refresh the session state file's mtime so the S0 TTL sweep measures
 * inactivity, not age: a session alive past the TTL would otherwise lose its
 * state (and with it the ledger's model field) to another session's sweep.
 * Touch only - never creates a file or a record.
 */
function touchSessionState(sessionId: unknown): void {
  const now = clock.currentDate();
  try {
    fs.utimesSync(sessionStatePath(sessionId), now, now);
  } catch {
    // No state file yet.
  }
}

/** A JSON file's value, or {} when it is missing or unreadable. */
function readJsonOrEmpty(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** The session's state as found (any JSON value), or {} without one. */
function readSessionState(sessionId: unknown): unknown {
  return readJsonOrEmpty(sessionStatePath(sessionId));
}

export = {
  STATE_DIR,
  RUNS_FILE,
  FAILURES_FILE,
  safeId,
  ensureDirs,
  sessionStatePath,
  loopStatePath,
  gateStatePath,
  writeStateAtomic,
  tryUnlink,
  touchSessionState,
  readJsonOrEmpty,
  readSessionState,
};
