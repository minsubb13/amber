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
const { execFileSync } = require('child_process');
const progress = require('./progress.cjs');

const OUT_OF_SCOPE_MAX = 20;
const REASON_MAX = 120;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args],
    { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function firstLine(err) {
  const text = (err && err.stderr && err.stderr.toString().trim()) || (err && err.message) || String(err);
  return text.split('\n')[0];
}

function toplevel(cwd) {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch (err) {
    throw new Error(cwd + ' is not inside a git repository, so changed files cannot be compared ' +
      'with the write-scope (Amber runs live in git): ' + firstLine(err));
  }
}

// Paths git status reports - tracked changes and untracked files, ignored
// files excluded - relative to the toplevel; a rename yields its new path.
function dirtyPaths(top) {
  const entries = git(top, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
  const paths = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i += 1; // the original path follows
  }
  return paths;
}

// The commit that added the contract file, or null when it was never committed
// (or the repository has no commits yet).
function baselineCommit(top, boundaryRel) {
  if (!boundaryRel) return null;
  try {
    return git(top, ['log', '--diff-filter=A', '--format=%H', '-1', '--', boundaryRel]).trim() || null;
  } catch {
    return null;
  }
}

function committedPaths(top, baseline) {
  if (!baseline) return [];
  return git(top, ['diff', '--name-only', baseline, 'HEAD']).split('\n')
    .map((l) => l.trim()).filter(Boolean);
}

// The dirty path list `unit init` stores as progress.json `preexisting`; best
// effort, because the refusal point is verified/done, not init.
function snapshot(cwd) {
  try {
    return dirtyPaths(toplevel(cwd));
  } catch {
    return [];
  }
}

// --out-of-scope <path>=<reason>, repeatable; the path may be a glob.
function parseDeclarations(rest) {
  const declarations = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== '--out-of-scope') continue;
    const value = [];
    for (let j = i + 1; j < rest.length && !rest[j].startsWith('--'); j += 1) value.push(rest[j]);
    const text = value.join(' ').trim();
    const eq = text.indexOf('=');
    const target = (eq === -1 ? text : text.slice(0, eq)).trim();
    if (!target) throw new Error('--out-of-scope needs <path>=<reason>');
    declarations.push({ path: target, reason: eq === -1 ? '' : text.slice(eq + 1).trim() });
  }
  return declarations;
}

function check(opts) {
  const { cwd, writeScopes, boundaryRel } = opts;
  const top = toplevel(cwd);
  const baseline = baselineCommit(top, boundaryRel);
  const skip = new Set(opts.preexisting || []);
  const changed = [];
  const seen = new Set();
  const lists = [
    ['committed', committedPaths(top, baseline)],
    ['working-tree', dirtyPaths(top).filter((p) => !skip.has(p))],
  ];
  for (const [kind, list] of lists) {
    for (const p of list) {
      if (seen.has(p) || p === boundaryRel || p === '.amber' || p.startsWith('.amber/')) continue;
      seen.add(p);
      changed.push({ path: p, kind });
    }
  }
  const outside = changed.filter((c) => !progress.inScopes(c.path, writeScopes));
  const declared = [];
  const undeclared = [];
  for (const c of outside) {
    const d = (opts.declarations || []).find((x) => x.path === c.path ||
      progress.globToRegExp(x.path).test(c.path));
    if (d) declared.push({ path: c.path, reason: d.reason.slice(0, REASON_MAX) });
    else undeclared.push(c);
  }
  return { baseline, changed, outside, declared, undeclared };
}

function refusal(result, contractFile, writeScopes, command) {
  const lines = [result.undeclared.length + ' changed file(s) lie outside every write-scope of ' +
    contractFile + ' and were not declared' +
    (result.baseline ? ' (baseline ' + result.baseline.slice(0, 7) + ')' : '') + ':'];
  for (const c of result.undeclared) lines.push('  ' + c.kind.padEnd(12) + ' ' + c.path);
  lines.push('write-scope: ' + writeScopes.join(', '));
  lines.push('Revert them (`git checkout -- <path>` for tracked changes, delete untracked files, ' +
    '`git revert` for commits) or declare each with `--out-of-scope <path>=<reason>` (a glob is ' +
    'accepted), then run `' + command + '` again. Declared paths are recorded in progress.json and ' +
    'the ledger; whether the change was legitimate stays with you and the operator.');
  return lines.join('\n');
}

// Ledger/signal fields for declared out-of-scope files (capped per row).
function recordFields(declared) {
  if (!declared || declared.length === 0) return {};
  return { out_of_scope: declared.slice(0, OUT_OF_SCOPE_MAX), out_of_scope_count: declared.length };
}

module.exports = { OUT_OF_SCOPE_MAX, snapshot, parseDeclarations, check, refusal, recordFields };
