// The audit QA's check of a report's candidate table.

import assert from 'node:assert/strict';

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

export function candidateRows(lines: readonly string[]): string[] {
  // The contract promises behavior, not a particular response language.
  // Preserve column order/meaning and reject filled-in operator verdicts.
  // The template's item cell is explicitly a mechanism or an event.
  const labels = [
    /^#$/,
    /^((?:Item|Mechanism|Event)(?:\s*\/\s*classification)?)$/i,
    /^(Evidence(?: and classification)?)$/i,
    /^(Proposed disposition)$/i,
    /^(Verdict)$/i,
  ];
  const header = lines.findIndex((line) => {
    const c = cells(line);
    return (
      c.length === labels.length &&
      c.every((value, i) => labels[i]?.test(value) === true)
    );
  });
  assert.notEqual(
    header,
    -1,
    'five candidate columns (#, item, evidence, proposed disposition, verdict) expected',
  );
  assert.ok(
    cells(lines[header + 1] ?? '').every((c) => /^:?-+:?$/.test(c)),
    'table separator expected',
  );
  const rows: string[] = [];
  for (let i = header + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || !line.trim().startsWith('|')) break;
    const c = cells(line);
    assert.equal(c.length, 5, 'five candidate cells expected: ' + line);
    assert.equal(c[4], '', 'operator verdict must remain empty: ' + line);
    rows.push(line);
  }
  assert.ok(rows.length >= 1, 'at least one candidate row expected');
  return rows;
}
