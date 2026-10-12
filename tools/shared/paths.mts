// The checkout and the plugin directory the suites and the QA tools work on.

import { join, resolve } from 'node:path';

/** The checkout's root: every compiled module sits three levels below it. */
export const REPO = resolve(import.meta.dirname, '..', '..', '..');

/** The plugin under test: $AMBER_PLUGIN_DIR, or plugin/ of this checkout. */
export function pluginDir(): string {
  return resolve(process.env['AMBER_PLUGIN_DIR'] ?? join(REPO, 'plugin'));
}
