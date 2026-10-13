// The post-hoc scope check's rules without I/O: reading `git status -z`,
// the `--out-of-scope` declarations, sorting changed paths into inside,
// declared and undeclared, and the refusal text.

import glob = require('./glob.cjs');
import type {
  ChangedPath,
  ChangeKind,
  Declaration,
  DeclaredPath,
  ScopeResult,
} from './types.cjs';

const OUT_OF_SCOPE_MAX = 20;
const REASON_MAX = 120;

/**
 * Paths of `git status --porcelain -z` output - tracked changes and untracked
 * files - relative to the toplevel; a rename or copy yields its new path.
 */
function statusPaths(output: string): string[] {
  const entries = output.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (entry.startsWith('R') || entry.startsWith('C')) i += 1; // the original path follows
  }
  return paths;
}

/** `--out-of-scope <path>=<reason>`, repeatable; the path may be a glob. */
function parseDeclarations(rest: readonly string[]): Declaration[] {
  const declarations: Declaration[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== '--out-of-scope') continue;
    const value: string[] = [];
    for (let j = i + 1; j < rest.length; j += 1) {
      const word = rest[j] ?? '';
      if (word.startsWith('--')) break;
      value.push(word);
    }
    const text = value.join(' ').trim();
    const eq = text.indexOf('=');
    const target = (eq === -1 ? text : text.slice(0, eq)).trim();
    if (!target) throw new Error('--out-of-scope needs <path>=<reason>');
    declarations.push({
      path: target,
      reason: eq === -1 ? '' : text.slice(eq + 1).trim(),
    });
  }
  return declarations;
}

/**
 * Sorts the changed paths (committed first, then the working tree, each path
 * once; the contract file and .amber/ never count) against the write-scope
 * and the declarations.
 */
function classify(
  baseline: string | null,
  lists: readonly (readonly [ChangeKind, readonly string[]])[],
  writeScopes: readonly string[],
  boundaryRel: string | null | undefined,
  declarations: readonly Declaration[],
): ScopeResult {
  const changed: ChangedPath[] = [];
  const seen = new Set<string>();
  for (const [kind, list] of lists) {
    for (const p of list) {
      if (
        seen.has(p) ||
        p === boundaryRel ||
        p === '.amber' ||
        p.startsWith('.amber/')
      ) {
        continue;
      }
      seen.add(p);
      changed.push({ path: p, kind });
    }
  }
  const outside = changed.filter((c) => !glob.inScopes(c.path, writeScopes));
  const declared: DeclaredPath[] = [];
  const undeclared: ChangedPath[] = [];
  for (const c of outside) {
    const d = declarations.find(
      (x) => x.path === c.path || glob.globToRegExp(x.path).test(c.path),
    );
    if (d)
      declared.push({ path: c.path, reason: d.reason.slice(0, REASON_MAX) });
    else undeclared.push(c);
  }
  return { baseline, changed, outside, declared, undeclared };
}

function refusal(
  result: ScopeResult,
  contractFile: string,
  writeScopes: readonly string[],
  command: string,
): string {
  const lines = [
    String(result.undeclared.length) +
      ' changed file(s) lie outside every write-scope of ' +
      contractFile +
      ' and were not declared' +
      (result.baseline
        ? ' (baseline ' + result.baseline.slice(0, 7) + ')'
        : '') +
      ':',
  ];
  for (const c of result.undeclared) {
    lines.push('  ' + c.kind.padEnd(12) + ' ' + c.path);
  }
  lines.push('write-scope: ' + writeScopes.join(', '));
  lines.push(
    'Revert them (`git checkout -- <path>` for tracked changes, delete untracked files, ' +
      '`git revert` for commits) or declare each with `--out-of-scope <path>=<reason>` (a glob is ' +
      'accepted), then run `' +
      command +
      '` again. Declared paths are recorded in progress.json and ' +
      'the ledger; whether the change was legitimate stays with you and the operator.',
  );
  return lines.join('\n');
}

/** Ledger/signal fields for declared out-of-scope files (capped per row). */
function recordFields(declared: readonly DeclaredPath[] | null | undefined): {
  out_of_scope?: DeclaredPath[];
  out_of_scope_count?: number;
} {
  if (!declared || declared.length === 0) return {};
  return {
    out_of_scope: declared.slice(0, OUT_OF_SCOPE_MAX),
    out_of_scope_count: declared.length,
  };
}

export = {
  OUT_OF_SCOPE_MAX,
  statusPaths,
  parseDeclarations,
  classify,
  refusal,
  recordFields,
};
