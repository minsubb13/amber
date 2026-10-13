// Reference and candidate copies of the plugin for one parity run.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function makeWorkdir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'amber-parity-')));
}

export function resolveRev(repo: string, rev: string): string {
  const result = spawnSync(
    'git',
    ['-C', repo, 'rev-parse', '--verify', `${rev}^{commit}`],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`cannot resolve ${rev}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** Copies the working tree's plugin/ into dest and returns its path. */
export function copyCandidate(repo: string, dest: string): string {
  const target = join(dest, 'plugin');
  cpSync(join(repo, 'plugin'), target, { recursive: true });
  return target;
}

/**
 * Paths the reference build takes from the working tree instead of `commit`:
 * the two manifests, whose version field is the one outside-visible change
 * every release makes on purpose (it reaches each ledger row as
 * plugin_version). Both builds run the working tree's suites, which live
 * outside plugin/.
 */
export const SHARED_WITH_CANDIDATE = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
];

/** Extracts `path` of `commit` under dest, keeping its path. */
function extractTree(
  repo: string,
  commit: string,
  path: string,
  dest: string,
): void {
  mkdirSync(dest, { recursive: true });
  const archive = spawnSync(
    'git',
    ['-C', repo, 'archive', '--format=tar', commit, path],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  if (archive.status !== 0) {
    throw new Error(
      `git archive ${commit} failed: ${archive.stderr.toString()}`,
    );
  }
  const tar = spawnSync('tar', ['-x', '-C', dest], { input: archive.stdout });
  if (tar.status !== 0) {
    throw new Error(`tar failed: ${tar.stderr.toString()}`);
  }
}

/**
 * The reference build: plugin/ of `commit` (code, run.sh, hooks.json, skills,
 * references) with the SHARED_WITH_CANDIDATE paths taken from the working
 * tree.
 */
export function extractReference(
  repo: string,
  commit: string,
  dest: string,
): string {
  extractTree(repo, commit, 'plugin', dest);
  const target = join(dest, 'plugin');
  for (const rel of SHARED_WITH_CANDIDATE) {
    rmSync(join(target, rel), { recursive: true, force: true });
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    cpSync(join(repo, 'plugin', rel), join(target, rel), { recursive: true });
  }
  return target;
}

/**
 * The working tree's plugin/ with the legacy suites of `commit` (its
 * plugin/tests) as its tests directory, so those suites run against the
 * current build.
 */
export function withLegacySuites(
  repo: string,
  commit: string,
  dest: string,
): string {
  const target = copyCandidate(repo, dest);
  const legacy = join(dest, 'legacy');
  extractTree(repo, commit, 'plugin/tests', legacy);
  rmSync(join(target, 'tests'), { recursive: true, force: true });
  cpSync(join(legacy, 'plugin', 'tests'), join(target, 'tests'), {
    recursive: true,
  });
  return target;
}

export interface Mutation {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

/** Applies a mutation that must match exactly once. */
export function applyMutation(pluginDir: string, mutation: Mutation): void {
  const file = join(pluginDir, mutation.file);
  const text = readFileSync(file, 'utf8');
  const count = text.split(mutation.find).length - 1;
  if (count !== 1) {
    throw new Error(
      `mutation ${mutation.name}: expected one match in ${mutation.file}, ` +
        `found ${String(count)}`,
    );
  }
  writeFileSync(file, text.replace(mutation.find, mutation.replace));
}
