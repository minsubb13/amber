// Multiset comparison of normalized (input, output) pairs. Order is ignored,
// so the comparison does not depend on how the suites schedule processes;
// counts are not, so a missing or extra invocation is a difference.

import type { Normalized } from './normalize.mjs';

export interface DifferenceGroup {
  readonly input: string;
  /** Outputs the reference produced more often than the candidate. */
  readonly reference: readonly string[];
  /** Outputs the candidate produced more often than the reference. */
  readonly candidate: readonly string[];
}

export interface Comparison {
  readonly invocations: number;
  readonly differences: number;
  readonly groups: readonly DifferenceGroup[];
}

const SEPARATOR = '\u0000';

function counts(items: readonly Normalized[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = item.input + SEPARATOR + item.output;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

export function compare(
  reference: readonly Normalized[],
  candidate: readonly Normalized[],
): Comparison {
  const ref = counts(reference);
  const cand = counts(candidate);
  const groups = new Map<
    string,
    { reference: string[]; candidate: string[] }
  >();
  let differences = 0;
  for (const key of new Set([...ref.keys(), ...cand.keys()])) {
    const delta = (ref.get(key) ?? 0) - (cand.get(key) ?? 0);
    if (delta === 0) continue;
    differences += Math.abs(delta);
    const cut = key.indexOf(SEPARATOR);
    const input = key.slice(0, cut);
    const output = key.slice(cut + SEPARATOR.length);
    let group = groups.get(input);
    if (group === undefined) {
      group = { reference: [], candidate: [] };
      groups.set(input, group);
    }
    const side = delta > 0 ? group.reference : group.candidate;
    for (let i = 0; i < Math.abs(delta); i += 1) side.push(output);
  }
  return {
    invocations: candidate.length,
    differences,
    groups: [...groups].map(([input, group]) => ({ input, ...group })),
  };
}

function excerpt(text: string, at: number): string {
  const start = Math.max(0, at - 60);
  return JSON.stringify(text.slice(start, at + 60));
}

/** A readable account of the first `limit` difference groups. */
export function describe(comparison: Comparison, limit: number): string[] {
  const lines: string[] = [];
  for (const group of comparison.groups.slice(0, limit)) {
    lines.push(`- input ${group.input.slice(0, 300)}`);
    const ref = group.reference[0];
    const cand = group.candidate[0];
    if (ref !== undefined && cand !== undefined) {
      let at = 0;
      while (at < ref.length && ref[at] === cand[at]) at += 1;
      lines.push(`  first difference at output offset ${String(at)}`);
      lines.push(`  reference: ${excerpt(ref, at)}`);
      lines.push(`  candidate: ${excerpt(cand, at)}`);
    } else {
      lines.push(
        `  reference-only outputs: ${String(group.reference.length)}, ` +
          `candidate-only outputs: ${String(group.candidate.length)}`,
      );
      const only = ref ?? cand ?? '';
      lines.push(`  output: ${excerpt(only, 0)}`);
    }
  }
  if (comparison.groups.length > limit) {
    lines.push(`- ... ${String(comparison.groups.length - limit)} more`);
  }
  return lines;
}
