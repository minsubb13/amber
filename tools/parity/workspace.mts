// Reference and candidate copies of the plugin for one parity run.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** Extracts plugin/ of a commit into dest and returns its path. */
export function extractReference(
  repo: string,
  commit: string,
  dest: string,
): string {
  mkdirSync(dest, { recursive: true });
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
  const tar = spawnSync('tar', ['-x', '-C', dest], { input: archive.stdout });
  if (tar.status !== 0) {
    throw new Error(`tar failed: ${tar.stderr.toString()}`);
  }
  return join(dest, 'plugin');
}

/** Copies the working tree's plugin/ into dest and returns its path. */
export function copyCandidate(repo: string, dest: string): string {
  const target = join(dest, 'plugin');
  cpSync(join(repo, 'plugin'), target, { recursive: true });
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
