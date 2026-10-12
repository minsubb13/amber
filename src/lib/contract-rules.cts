// What a boundary document says, without I/O: its machine-enforced rows and
// its standing-rules section.

import type { MachineRules } from './types.cjs';

const MACHINE_TAG = /\[machine:\s*(write-scope|bash-deny)\s+(.+)\]\s*$/;

/** The write-scope globs and bash-deny patterns, in document order. */
function machineRules(text: string): MachineRules {
  const rules: MachineRules = { writeScopes: [], bashDeny: [] };
  for (const line of text.split('\n')) {
    const m = MACHINE_TAG.exec(line.trim());
    if (!m) continue;
    const [, kind, value = ''] = m;
    if (kind === 'write-scope') rules.writeScopes.push(value.trim());
    else rules.bashDeny.push(value.trim());
  }
  return rules;
}

/**
 * The body of the `## Standing rules` section, trimmed, or '(none listed)'
 * when the section is missing or empty. The briefing hands it over verbatim.
 */
function standingRules(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) =>
    /^##\s*standing rules\b/i.test(l.trim()),
  );
  if (start === -1) return '(none listed)';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim() || '(none listed)';
}

export = { machineRules, standingRules };
