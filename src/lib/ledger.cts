// The operator-global ledger: one JSON row per recorded event appended to
// <AMBER_HOME>/runs.jsonl. A row longer than MAX_LINE_BYTES is dropped rather
// than truncated.

import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');

import clock = require('./clock.cjs');
import guards = require('./guards.cjs');
import state = require('./state-store.cjs');
import zone = require('./zone.cjs');
import type { RecordSource } from './types.cjs';

const SUMMARY_MAX = 200;
const MAX_LINE_BYTES = 4096;

/** The installed plugin's version, or 'unknown'. */
function pluginVersion(): unknown {
  try {
    const manifest = path.join(
      __dirname,
      '..',
      '.claude-plugin',
      'plugin.json',
    );
    const version = guards.readField(
      JSON.parse(fs.readFileSync(manifest, 'utf8')),
      'version',
    );
    return version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Appends one row: the source's session and place, the session's model (from
 * its state file), the plugin version, the trigger, the summary (capped), and
 * then the trigger's own fields in their order.
 */
function appendRecord(
  source: RecordSource,
  summary: string,
  fields: Readonly<Record<string, unknown>> | null,
  trigger?: string,
): void {
  state.ensureDirs();
  let model: unknown = null;
  try {
    model =
      guards.readField(
        JSON.parse(
          fs.readFileSync(state.sessionStatePath(source.session_id), 'utf8'),
        ),
        'model',
      ) || null;
  } catch {
    // No state file: the model stays unknown.
  }
  const record: Record<string, unknown> = {
    v: 1,
    ts: clock.isoNow(),
    session_id: source.session_id || 'unknown',
    cwd: source.cwd || '',
    project: zone.projectKey(source.cwd),
    host: os.hostname(),
    model: model || 'unknown',
    plugin_version: pluginVersion(),
    trigger: trigger || 'done-declaration',
    summary: summary.slice(0, SUMMARY_MAX),
  };
  if (fields) Object.assign(record, fields);
  const line = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) {
    fs.appendFileSync(state.RUNS_FILE, line, { mode: 0o600 });
  }
}

export = { SUMMARY_MAX, appendRecord };
