// Loading the records capture.cts wrote, with every field checked.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CaptureRecord, FileEffect, InputRead } from './record-types.cjs';
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

function parseReads(value: unknown): InputRead[] | null {
  if (!Array.isArray(value)) return null;
  const reads: InputRead[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { op, target, result } = item;
    if (
      typeof op !== 'string' ||
      typeof target !== 'string' ||
      typeof result !== 'string'
    ) {
      return null;
    }
    reads.push({ op, target, result });
  }
  return reads;
}

function parseEnv(value: unknown): Record<string, string | null> | null {
  if (!isRecord(value)) return null;
  const env: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isStringOrNull(item)) return null;
    env[key] = item;
  }
  return env;
}

export function parseRecord(value: unknown): CaptureRecord | null {
  if (!isRecord(value)) return null;
  const { entry, args, cwd, stdin, stdout, stderr, exitCode, signal, ledger } =
    value;
  const env = parseEnv(value['env']);
  const reads = parseReads(value['reads']);
  const state = parseEffects(value['state']);
  const zone = parseEffects(value['zone']);
  if (
    typeof entry !== 'string' ||
    !isStringArray(args) ||
    typeof cwd !== 'string' ||
    env === null ||
    reads === null ||
    typeof stdin !== 'string' ||
    typeof stdout !== 'string' ||
    typeof stderr !== 'string' ||
    !(exitCode === null || typeof exitCode === 'number') ||
    !isStringOrNull(signal) ||
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
    env,
    reads,
    stdin,
    stdout,
    stderr,
    exitCode,
    signal,
    ledger,
    state,
    zone,
  };
}

/**
 * Reads every record in dir: one per product process (*.json) and one per
 * line of each suite process's direct calls (*.jsonl). A malformed record is
 * an error, never skipped.
 */
export function loadRecords(dir: string): CaptureRecord[] {
  const texts = readdirSync(dir)
    .sort()
    .flatMap((name) => {
      if (name.endsWith('.json')) {
        return [{ name, text: readFileSync(join(dir, name), 'utf8') }];
      }
      if (name.endsWith('.jsonl')) {
        return readFileSync(join(dir, name), 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((text, index) => ({
            name: `${name}:${String(index + 1)}`,
            text,
          }));
      }
      return [];
    });
  return texts.map(({ name, text }) => {
    const parsed = parseRecord(JSON.parse(text));
    if (parsed === null) throw new Error(`malformed capture record ${name}`);
    return parsed;
  });
}
