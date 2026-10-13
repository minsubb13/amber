// .amber/progress.json on disk: where it lives, reading it, and writing it
// atomically. The rules for what is in it live in progress-model.

import fs = require('node:fs');
import path = require('node:path');

import guards = require('./guards.cjs');
import model = require('./progress-model.cjs');
import plan = require('./plan.cjs');
import type { BrokenProgress, Clock, Progress } from './types.cjs';

function progressPath(root: string): string {
  return path.join(root, '.amber', 'progress.json');
}

/**
 * The read check is deliberately the original's: the file must hold an
 * object whose `units` is an object (null passes, as it always has), and the
 * rest is trusted as the plugin wrote it. A stricter check would turn files
 * the plugin accepts today into broken ones. So a unit value is typed as a
 * Unit although a hand-edited file can hold null or a non-object there; the
 * model reads such a value the original's way where it meets it (isOpen and
 * unitByAgent throw on null, a non-object reads as having no fields).
 */
function isProgress(value: unknown): value is Progress {
  return guards.isObject(value) && typeof value['units'] === 'object';
}

/** The text an error contributes to a broken-file report. */
function errorText(err: unknown): string {
  const message = guards.isObject(err) ? err['message'] : undefined;
  return String(message || err);
}

/** The run state, null when there is none, or a broken-file report. */
function loadProgress(root: string): Progress | BrokenProgress | null {
  const file = progressPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isProgress(p)) throw new Error('no units object');
    return p;
  } catch (err) {
    return { broken: true, error: errorText(err), file };
  }
}

/** Stamps updated_at and replaces the file atomically (owner-only). */
function saveProgress(root: string, p: Progress, now: Clock): void {
  const file = progressPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  p.updated_at = now();
  const tmp = file + '.tmp-' + String(process.pid);
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Seeds the run state from the plan's unit rows and saves it. */
function initProgress(
  root: string,
  planRel: string,
  contractFile: string | null | undefined,
  force: boolean,
  preexisting: unknown,
  now: Clock,
): Progress {
  const file = progressPath(root);
  if (fs.existsSync(file) && !force) {
    throw new Error(
      file + ' already exists; pass --force to rebuild it from the plan',
    );
  }
  const planAbs = path.resolve(root, planRel);
  const units = plan.parsePlanUnits(fs.readFileSync(planAbs, 'utf8'));
  if (units.length === 0) {
    throw new Error('no [unit: ...] rows found in ' + planRel);
  }
  const p = model.newProgress(
    units,
    contractFile || null,
    path.relative(root, planAbs).split(path.sep).join('/'),
    Array.isArray(preexisting) ? preexisting : [],
    now,
  );
  saveProgress(root, p, now);
  return p;
}

export = { progressPath, loadProgress, saveProgress, initProgress };
