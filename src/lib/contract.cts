// Active contract discovery: <zone root>/.amber/active.json points at the
// ratified boundary document. Missing pointer = no contract = null. A pointer
// whose target cannot be read is a broken contract, reported as such so E1
// can fail closed with an actionable reason.

import fs = require('node:fs');
import path = require('node:path');

import guards = require('./guards.cjs');
import rules = require('./contract-rules.cjs');
import zone = require('./zone.cjs');
import type { Contract } from './types.cjs';

function errorText(err: unknown): string {
  const message = guards.isObject(err) ? err['message'] : undefined;
  return guards.toText(message || err);
}

function loadContract(cwd: string | undefined): Contract | null {
  const root = zone.zoneRoot(cwd);
  const pointerPath = path.join(root, '.amber', 'active.json');
  if (!fs.existsSync(pointerPath)) return null;
  try {
    // The pointer is read as found: a null pointer fails here with the
    // engine's TypeError, which becomes the broken-contract reason.
    const pointer: unknown = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    const boundaryPath = path.resolve(
      root,
      guards.toText(guards.readField(pointer, 'boundary') || ''),
    );
    if (!boundaryPath.startsWith(root + path.sep)) {
      throw new Error('boundary path escapes the zone root');
    }
    const text = fs.readFileSync(boundaryPath, 'utf8');
    return {
      root,
      pointerPath,
      boundaryPath,
      boundaryFile: path.basename(boundaryPath),
      ratifiedBy: guards.readField(pointer, 'ratified_by') || 'unknown',
      ratifiedAt: guards.readField(pointer, 'ratified_at') || 'unknown',
      text,
      broken: false,
    };
  } catch (err) {
    return {
      root,
      pointerPath,
      boundaryPath: null,
      boundaryFile: null,
      text: '',
      broken: true,
      error: errorText(err),
    };
  }
}

/** The boundary file's path relative to the zone root, /-separated. */
function boundaryRel(root: string, boundaryPath: string): string {
  return path.relative(root, boundaryPath).split(path.sep).join('/');
}

/** What record.cjs needs to know about the zone's contract. */
function contractInfo(cwd: string | undefined): {
  root: string;
  boundaryFile: string | null;
  broken: boolean;
  error?: string | undefined;
  writeScopes: string[];
  boundaryRel: string | null;
} {
  const c = loadContract(cwd);
  if (!c) {
    return {
      root: zone.zoneRoot(cwd),
      boundaryFile: null,
      broken: false,
      writeScopes: [],
      boundaryRel: null,
    };
  }
  return {
    root: c.root,
    boundaryFile: c.boundaryFile,
    broken: c.broken,
    error: c.broken ? c.error : undefined,
    writeScopes: c.broken ? [] : rules.machineRules(c.text).writeScopes,
    boundaryRel: c.broken ? null : boundaryRel(c.root, c.boundaryPath),
  };
}

export = { loadContract, boundaryRel, contractInfo };
