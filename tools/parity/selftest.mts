// Self-test of the parity harness: each mutation changes one outside-visible
// behavior of a candidate copy, and the comparison has to report it.

import type { Mutation } from './workspace.mjs';

export const MUTATIONS: readonly Mutation[] = [
  {
    // (a) one character of a user-visible S0 briefing sentence
    name: 'S0 briefing text',
    // (the briefing texts moved to lib/hook-text in stage 3)
    file: 'lib/hook-text.cjs',
    find: "'amber: an active contract governs this zone - '",
    replace: "'amber: an active contract governs this zone , '",
  },
  {
    // (b) the exit code of a refused record.cjs command
    name: 'record.cjs refusal exit code',
    file: 'scripts/record.cjs',
    find: 'process.exitCode = 1;',
    replace: 'process.exitCode = 2;',
  },
  {
    // (c) one E1 allow/deny decision: bash-deny stops matching
    name: 'E1 bash-deny decision',
    // (E1 moved to lib/enforcer in stage 3)
    file: 'lib/enforcer.cjs',
    find: 'if (re.test(command)) {',
    replace: 'if (re.test(command) && false) {',
  },
  {
    // (d) one value written to progress.json
    name: 'progress.json field',
    // (the initial state moved to lib/progress-model in stage 2)
    file: 'lib/progress-model.cjs',
    find: '        blocks: 0,\n',
    replace: '        blocks: 1,\n',
  },
];

/**
 * Controls that change how output is produced but not what the outside sees;
 * the comparison must report no difference for them. One moves a record.cjs
 * message from process.stdout.write to fs.writeSync(1, ...), which capture
 * has to follow.
 */
// The recorder's "amber: unit U<n> -> <status>" line as compiled.
const UNIT_LINE =
  "process.stdout.write('amber: unit ' +\n        id +\n        ' -> '";

export const CONTROLS: readonly Mutation[] = [
  {
    name: 'stdout through fs.writeSync',
    file: 'scripts/record.cjs',
    // (the compiled recorder of stage 4 breaks this call over lines)
    find: UNIT_LINE,
    replace: UNIT_LINE.replace(
      'process.stdout.write(',
      "require('node:fs').writeSync(1, ",
    ),
  },
];

/**
 * Probes that add output only file-descriptor-level capture can see: the
 * comparison of records (not the suites failing) must report them. One makes
 * record.cjs start a grandchild that writes to the inherited stdout.
 */
export const PROBES: readonly Mutation[] = [
  {
    name: 'stdout from an inherited grandchild',
    file: 'scripts/record.cjs',
    find: UNIT_LINE,
    replace:
      "require('node:child_process').spawnSync('sh', ['-c', 'printf parity-probe'], { stdio: 'inherit' }); " +
      UNIT_LINE,
  },
];
