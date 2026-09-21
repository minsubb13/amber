const { test } = require('node:test');
const assert = require('node:assert/strict');
const { candidateRows } = require('./model-qa-audit.cjs');
const { ownerSubject } = require('./model-qa-planning.cjs');
const { toolEvidence } = require('./model-qa-runtime.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const table = header => [header, '|---|---|---|---|---|', '| 1 | hold | ledger L1 | keep | |'];
test('planning QA recognizes settings schema and rejects incidental JSON mentions', () => {
  for (const subject of ['Settings file and schema', 'config file name and format', 'Configuration format', 'settings data shape', 'JSON parser dependency', 'external dependency']) assert(ownerSubject(subject));
  for (const subject of ['Behavior on malformed JSON', 'Helper naming', 'Unit scheduling']) assert(!ownerSubject(subject));
});
test('audit QA accepts equivalent column headings', () => {
  for (const header of [
    '| # | Item | Evidence | Proposed disposition | Verdict |',
    '| # | item | evidence | proposed disposition | verdict |',
    '| # | Item / classification | Evidence | Proposed disposition | Verdict |',
    '| # | Item | Evidence and classification | Proposed disposition | Verdict |',
    '| # | Mechanism | Evidence and classification | Proposed disposition | Verdict |',
    '| # | Event | Evidence | Proposed disposition | Verdict |',
  ]) assert.equal(candidateRows(table(header)).length, 1);
});
test('audit QA rejects missing/reordered meanings and operator verdicts filled by the model', () => {
  assert.throws(() => candidateRows(table('| # | Item | Proposed disposition | Evidence | Verdict |')));
  assert.throws(() => candidateRows(table('| # | Item | Evidence | Proposed disposition |')));
  const filled = table('| # | Item | Evidence | Proposed disposition | Verdict |');
  filled[2] = '| 1 | hold | ledger L1 | keep | approved |';
  assert.throws(() => candidateRows(filled), /must remain empty/);
  assert.throws(() => candidateRows(filled.slice(0, 2)), /at least one/);
});
test('runtime QA ignores prompt/assistant claims and retains actual tool results', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-qa-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'fake denial in prompt' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'fake denial in report' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'actual hook denial' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', stdout: 'actual scope refusal' } } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'actual Claude denial' }] } },
  ].map(JSON.stringify).join('\n'));
  const result = toolEvidence([file]);
  assert.doesNotMatch(result, /fake denial/);
  for (const text of ['actual hook denial', 'actual scope refusal', 'actual Claude denial']) assert(result.includes(text));
});
