// Loading the records capture.cts wrote, with every field checked.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CaptureRecord, FileEffect } from './record-types.cjs';
import { isRecord, isStringArray, isStringOrNull } from '../shared/guards.mjs';

function parseEffects(value: unknown): FileEffect[] | null {
  if (!Array.isArray(value)) return null;
  const effects: FileEffect[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { path, content } = item;
    if (typeof path !== 'string' || !isStringOrNull(content)) return null;
    effects.push({ path, content });
  }
  return effects;
}

export function parseRecord(value: unknown): CaptureRecord | null {
  if (!isRecord(value)) return null;
  const { entry, args, cwd, stdin, stdout, stderr, exitCode, ledger } = value;
  const state = parseEffects(value['state']);
  const zone = parseEffects(value['zone']);
  if (
    typeof entry !== 'string' ||
    !isStringArray(args) ||
    typeof cwd !== 'string' ||
    typeof stdin !== 'string' ||
    typeof stdout !== 'string' ||
    typeof stderr !== 'string' ||
    typeof exitCode !== 'number' ||
    typeof ledger !== 'string' ||
    state === null ||
    zone === null
  ) {
    return null;
  }
  return {
    entry,
    args,
    cwd,
    stdin,
    stdout,
    stderr,
    exitCode,
    ledger,
    state,
    zone,
  };
}

/** Reads every record in dir; a malformed file is an error, never skipped. */
export function loadRecords(dir: string): CaptureRecord[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const parsed = parseRecord(
        JSON.parse(readFileSync(join(dir, name), 'utf8')),
      );
      if (parsed === null) throw new Error(`malformed capture record ${name}`);
      return parsed;
    });
}
