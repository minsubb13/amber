// Amber loop body state: the per-run progress file (.amber/progress.json at the
// zone root) that the plan's unit rows seed and the unit commands, E1, S2, S3
// update. Shared by amber-hook.cjs and scripts/record.cjs; requires neither.
//
// This module keeps the interface those CommonJS callers use. The rules live
// in lib/progress-model (pure), the file handling in lib/progress-store, the
// plan rows in lib/plan and the globs in lib/glob; here the clock is bound.

import clock = require('../lib/clock.cjs');
import glob = require('../lib/glob.cjs');
import plan = require('../lib/plan.cjs');
import model = require('../lib/progress-model.cjs');
import store = require('../lib/progress-store.cjs');
import type { EventExtra, Progress } from '../lib/types.cjs';

function saveProgress(root: string, p: Progress): void {
  store.saveProgress(root, p, clock.isoNow);
}

function initProgress(
  root: string,
  planRel: string,
  contractFile: string | null | undefined,
  force: boolean,
  preexisting: unknown,
): Progress {
  return store.initProgress(
    root,
    planRel,
    contractFile,
    force,
    preexisting,
    clock.isoNow,
  );
}

function applyEvent(
  p: Progress,
  event: string,
  id: string | null,
  extra?: EventExtra,
): Progress {
  return model.applyEvent(p, event, id, extra, clock.isoNow);
}

export = {
  REENTRY_LIMIT: model.REENTRY_LIMIT,
  globToRegExp: glob.globToRegExp,
  inScopes: glob.inScopes,
  parsePlanUnits: plan.parsePlanUnits,
  progressPath: store.progressPath,
  loadProgress: store.loadProgress,
  saveProgress,
  initProgress,
  openUnits: model.openUnits,
  focusUnit: model.focusUnit,
  readyUnits: model.readyUnits,
  applyEvent,
  unitByAgent: model.unitByAgent,
  summary: model.summary,
  holdKind: model.holdKind,
};
