// Parse the native apply_patch envelope before E1 checks every affected path.
// This module keeps the interface the tests use; the parser lives in
// lib/apply-patch.

import applyPatch = require('../lib/apply-patch.cjs');

export = { patchPaths: applyPatch.patchPaths };
