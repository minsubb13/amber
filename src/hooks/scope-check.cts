// Amber post-hoc scope check: at `unit verified` and `done`, the
// files git reports as changed in the tree the command runs in are compared
// with the contract's write-scope rows. E1 checks file-tool writes before they
// happen; writes through the shell (sed, redirection, scripts) never reach it,
// so this check establishes after the fact which files changed outside every
// write-scope. The machine settles only that fact - whether an out-of-scope
// change was legitimate stays with the model's declaration
// (--out-of-scope <path>=<reason>) and the operator reading the record.
//
// Changed set = (baseline..HEAD commits) ∪ ((working tree ∪ untracked) −
// preexisting). The baseline is the commit that added the contract file (set
// commits contract and plan before approval); preexisting is the dirty path
// list `unit init` stored in progress.json. `.amber/` and the contract file
// itself are never compared. Any git failure refuses (fail closed).
//
// This module runs git and keeps the interface scripts/record.cjs uses; the
// rules live in lib/scope.

import git = require('../lib/git.cjs');
import scope = require('../lib/scope.cjs');
import type { ScopeCheckOptions, ScopeResult } from '../lib/types.cjs';

function toplevel(cwd: string): string {
  try {
    return git.git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch (err) {
    throw new Error(
      cwd +
        ' is not inside a git repository, so changed files cannot be compared ' +
        'with the write-scope (Amber runs live in git): ' +
        git.firstLine(err),
      { cause: err },
    );
  }
}

function dirtyPaths(top: string): string[] {
  return scope.statusPaths(
    git.git(top, ['status', '--porcelain', '-z', '--untracked-files=all']),
  );
}

/**
 * The commit that added the contract file, or null when it was never committed
 * (or the repository has no commits yet).
 */
function baselineCommit(
  top: string,
  boundaryRel: string | null | undefined,
): string | null {
  if (!boundaryRel) return null;
  try {
    return (
      git
        .git(top, [
          'log',
          '--diff-filter=A',
          '--format=%H',
          '-1',
          '--',
          boundaryRel,
        ])
        .trim() || null
    );
  } catch {
    return null;
  }
}

function committedPaths(top: string, baseline: string | null): string[] {
  if (!baseline) return [];
  return git
    .git(top, ['diff', '--name-only', baseline, 'HEAD'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The dirty path list `unit init` stores as progress.json `preexisting`; best
 * effort, because the refusal point is verified/done, not init.
 */
function snapshot(cwd: string): string[] {
  try {
    return dirtyPaths(toplevel(cwd));
  } catch {
    return [];
  }
}

function check(opts: ScopeCheckOptions): ScopeResult {
  const { cwd, writeScopes, boundaryRel } = opts;
  const top = toplevel(cwd);
  const baseline = baselineCommit(top, boundaryRel);
  const skip = new Set(opts.preexisting || []);
  const committed = committedPaths(top, baseline);
  const workingTree = dirtyPaths(top).filter((p) => !skip.has(p));
  return scope.classify(
    baseline,
    [
      ['committed', committed],
      ['working-tree', workingTree],
    ],
    writeScopes,
    boundaryRel,
    opts.declarations || [],
  );
}

export = {
  OUT_OF_SCOPE_MAX: scope.OUT_OF_SCOPE_MAX,
  snapshot,
  parseDeclarations: scope.parseDeclarations,
  check,
  refusal: scope.refusal,
  recordFields: scope.recordFields,
};
