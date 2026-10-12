// Running git for the scope check: read-only commands with a short timeout,
// stdout as text, stderr kept on the error for the refusal message.

import childProcess = require('node:child_process');

import guards = require('./guards.cjs');

/** The stdout of `git -C <cwd> <args>`; throws the child_process error. */
function git(cwd: string, args: readonly string[]): string {
  return childProcess
    .execFileSync('git', ['-C', cwd, ...args], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    .toString();
}

/** A child_process output field: a Buffer, or a string with an encoding. */
function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString() : '';
}

/** The first line of what a failed git run said. */
function firstLine(err: unknown): string {
  const fields = guards.isObject(err) ? err : {};
  const stderr = fields['stderr'];
  const message = fields['message'];
  const text =
    (stderr ? outputText(stderr).trim() : '') ||
    (typeof message === 'string' ? message : '') ||
    String(err);
  return text.split('\n')[0] ?? '';
}

export = { git, firstLine };
