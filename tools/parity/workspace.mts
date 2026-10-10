// Reference and candidate copies of the plugin for one parity run.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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

/** Code paths of the plugin, relative to it: what a parity run compares. */
const CODE_DIRS = ['hooks', 'scripts', 'lib'];

function isCode(rel: string): boolean {
  const [dir, ...rest] = rel.split('/');
  if (dir === undefined || !CODE_DIRS.includes(dir)) return false;
  return dir === 'lib' || (rest.length === 1 && rel.endsWith('.cjs'));
}

function listFiles(root: string, rel = ''): string[] {
  const dir = join(root, rel);
  return readdirSync(dir).flatMap((name) => {
    const child = rel === '' ? name : `${rel}/${name}`;
    return statSync(join(dir, name)).isDirectory()
      ? listFiles(root, child)
      : [child];
  });
}

/**
 * The reference build: the working tree's plugin/ with its code (hooks/*.cjs,
 * scripts/*.cjs, lib/) replaced by that of `commit`. Tests, manifests (the
 * version), skills, references, hooks.json and run.sh are the candidate's
 * own, so both builds run the same suites and differ only in code.
 */
export function extractReference(
  repo: string,
  commit: string,
  dest: string,
): string {
  const target = copyCandidate(repo, dest);
  for (const rel of listFiles(target).filter(isCode)) {
    rmSync(join(target, rel));
  }
  rmSync(join(target, 'lib'), { recursive: true, force: true });
  const archive = spawnSync(
    'git',
    ['-C', repo, 'archive', '--format=tar', commit, 'plugin'],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  if (archive.status !== 0) {
    throw new Error(
      `git archive ${commit} failed: ${archive.stderr.toString()}`,
    );
  }
  const full = join(dest, 'archive');
  mkdirSync(full, { recursive: true });
  const tar = spawnSync('tar', ['-x', '-C', full], { input: archive.stdout });
  if (tar.status !== 0) {
    throw new Error(`tar failed: ${tar.stderr.toString()}`);
  }
  const source = join(full, 'plugin');
  for (const rel of listFiles(source).filter(isCode)) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    copyFileSync(join(source, rel), join(target, rel));
  }
  rmSync(full, { recursive: true, force: true });
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
