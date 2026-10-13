// `npm test`: run every plugin test suite against plugin/ (or --plugin <dir>)
// and exit non-zero when any suite fails.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { runSuites } from '../shared/suites.mjs';

const { values } = parseArgs({
  options: { plugin: { type: 'string', default: 'plugin' } },
});

const results = runSuites(resolve(values.plugin), { inherit: true });
const failed = results.filter((run) => run.status !== 0);
for (const run of failed) {
  console.error(`suite failed: ${run.suite} (exit ${String(run.status)})`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
