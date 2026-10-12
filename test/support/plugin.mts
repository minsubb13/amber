// Where the suites find the plugin under test and their fixtures, and how
// they load a plugin module. The suites run compiled from build/test against
// $AMBER_PLUGIN_DIR (plugin/ of this checkout when unset), so the same tests
// drive any build: the working tree, or a reference build in a parity run.

import { createRequire } from 'node:module';
import { join } from 'node:path';

import { pluginDir, REPO } from '../../tools/shared/paths.mjs';

export const PLUGIN = pluginDir();

/** test/fixtures of this checkout; the compiled suites read them in place. */
export const FIXTURES = join(REPO, 'test', 'fixtures');

const requireFromHere = createRequire(import.meta.url);

function exportsAll<T extends object>(
  value: unknown,
  names: readonly (keyof T & string)[],
): value is T {
  return (
    typeof value === 'object' &&
    value !== null &&
    names.every((name) => name in value)
  );
}

/**
 * Loads PLUGIN/<rel> and checks that it exports every name the suite uses.
 * T is the type of the module's source in src/, which the build compiles to
 * that file; a reference build in a parity run has the same exports.
 */
export function loadModule<T extends object>(
  rel: string,
  names: readonly (keyof T & string)[],
): T {
  const loaded: unknown = requireFromHere(join(PLUGIN, rel));
  if (!exportsAll<T>(loaded, names)) {
    throw new Error(`${rel} does not export ${names.join(', ')}`);
  }
  return loaded;
}
