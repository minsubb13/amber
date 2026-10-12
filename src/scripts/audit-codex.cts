// Codex rollout adapter. Read-only; returns event metadata, never message bodies.
// This module keeps the interface scripts/audit.cjs uses and reads the file;
// the parsing lives in lib/codex-transcript.

import fs = require('node:fs');

import transcript = require('../lib/codex-transcript.cjs');

/** The events of the Codex rollout at file. */
function codexEvents(
  file: string,
): ReturnType<typeof transcript.parseCodexTranscript> {
  return transcript.parseCodexTranscript(fs.readFileSync(file, 'utf8'), file);
}

export = { codexEvents, commandEvents: transcript.commandEvents };
