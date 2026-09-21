const assert = require('node:assert/strict');

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim());
}

function candidateRows(lines) {
  // The contract promises behavior, not a particular response language.
  // Preserve column order/meaning and reject filled-in operator verdicts.
  // The template's item cell is explicitly a mechanism or an event.
  const labels = [/^#$/, /^((?:Item|Mechanism|Event)(?:\s*\/\s*classification)?)$/i,
    /^(Evidence(?: and classification)?)$/i,
    /^(Proposed disposition)$/i, /^(Verdict)$/i];
  const header = lines.findIndex(line => {
    const c = cells(line);
    return c.length === labels.length && c.every((value, i) => labels[i].test(value));
  });
  assert.notEqual(header, -1, 'five candidate columns (#, item, evidence, proposed disposition, verdict) expected');
  assert(cells(lines[header + 1] || '').every(c => /^:?-+:?$/.test(c)), 'table separator expected');
  const rows = [];
  for (let i = header + 2; i < lines.length && lines[i].trim().startsWith('|'); i += 1) {
    const c = cells(lines[i]);
    assert.equal(c.length, 5, 'five candidate cells expected: ' + lines[i]);
    assert.equal(c[4], '', 'operator verdict must remain empty: ' + lines[i]);
    rows.push(lines[i]);
  }
  assert(rows.length >= 1, 'at least one candidate row expected');
  return rows;
}

module.exports = { candidateRows };
