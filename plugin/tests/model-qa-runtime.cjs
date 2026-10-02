// Supplemental installed-host QA: real resume, hold lifecycle, file/Bash
// denials, post-hoc scope detection, status and init discovery. Every write
// is in a temporary fixture or its isolated AMBER_HOME; retain raw evidence.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function toolEvidence(files) {
  const textOf = content => typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(b => typeof b === 'string' ? b : b.text || '').join('\n')
      : JSON.stringify(content);
  return files.flatMap(p => fs.readFileSync(p, 'utf8').split('\n')).flatMap(line => {
    let r;
    try { r = JSON.parse(line); } catch { return []; }
    const p = r.payload || {};
    if (r.type === 'response_item' && /^(custom_tool_call_output|function_call_output)$/.test(p.type)) return [textOf(p.output)];
    if (r.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution') return [p.item.stdout || p.item.aggregated_output || ''];
    const content = r.message?.content;
    return Array.isArray(content) ? content.filter(b => b.type === 'tool_result').map(b => textOf(b.content)) : [];
  }).join('\n');
}

// Semantic gate of the init-empty scenario, kept pure so an oracle script can
// run negative cases against it. Each of intent.md's three slots must be
// asked as a question (a sentence that ends in '?'), the emptiness must be
// cited as a scan result (a paragraph that names the scan, the oracle map, or
// a charge, not just the prompt's own words), and the oracle map must carry an
// explicit empty row for a charge. Returns the list of failed checks.
const INIT_EMPTY_SLOTS = {
  purpose: /purpose|goal|intent|why (does|should|will)|what (is|will|should) (this|the) project/i,
  oracle: /verif|oracle|test|check|prove/i,
  forbidden: /forbid|never|not do|out of scope|must not|off[- ]limits|won't|boundar/i,
};
function assessInitEmpty(final, oracleMap) {
  const failures = [];
  const questions = String(final).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.endsWith('?'));
  if (questions.length === 0) failures.push('no question asked');
  for (const [slot, re] of Object.entries(INIT_EMPTY_SLOTS)) {
    if (!questions.some(q => re.test(q))) failures.push('slot not asked as a question: ' + slot);
  }
  const cites = String(final).split(/\n\s*\n/).some(p =>
    /\b(scan|oracle map|charge|verification assets|knowledge assets|history and environment)\b/i.test(p) &&
    /\b(no|none|empty|nothing|absent|missing)\b/i.test(p));
  if (!cites) failures.push('empty scan not cited as a scan result');
  const emptyRow = String(oracleMap).split('\n').some(l =>
    /verif|test|build|\bci\b|knowledge|document|histor|environment|commit/i.test(l) &&
    /\b(none|empty|nothing|absent|missing|no)\b/i.test(l));
  if (!emptyRow) failures.push('oracle map has no explicit empty charge row');
  return failures;
}

function assertStatusEvidence(host, run, rows, files, activePlugin) {
  const invocations = rows.filter(r => r.trigger === 'skill-invocation' && /amber:status/.test(r.summary));
  if (host === 'codex') {
    assert(invocations.length > 0, 'Codex explicit status recorder invocation missing');
  } else {
    // Typed status is deliberately excluded by S1; the current host also
    // refuses Skill-tool calls to this explicit-only skill. Verify the
    // actual command expansion and manifest-reading tool result instead.
    assert.equal(invocations.length, 0, 'Claude typed status must not invent an invocation row');
    const typed = files.some(file => fs.readFileSync(file, 'utf8').split('\n').some(line => {
      let r;
      try { r = JSON.parse(line); } catch { return false; }
      return r.type === 'user' && typeof r.message?.content === 'string' &&
        r.message.content.includes('<command-name>/amber:status</command-name>');
    }));
    assert(typed, 'actual Claude status slash-command event missing');
    const expected = JSON.parse(fs.readFileSync(path.join(activePlugin, '.claude-plugin', 'plugin.json'), 'utf8'));
    const output = toolEvidence(files);
    assert.match(output, /\bamber\b/, 'plugin name missing from tool output');
    assert(output.includes(expected.version), 'installed version missing from tool output');
    assert(run.final.includes(expected.version), 'status reports the wrong installed version');
  }
  assert.match(run.final, /Install:/);
  assert.match(run.final, /Active contract:/);
  assert.match(run.final, /Cycle completions:/);
  assert.match(run.final, /Last audit:/);
}

module.exports = function runtimeQA(ctx) {
  const { host, scenario, BASE, activePlugin, runHost, ledger, sensorFailures, transcriptFiles } = ctx;
  const root = path.join(BASE, scenario);
  const home = path.join(BASE, scenario + '-amber-home');
  // The greenfield fixture is nothing but `git init`: no src/, no .gitignore.
  fs.mkdirSync(scenario === 'init-empty' ? root : path.join(root, 'src'), { recursive: true });
  const write = (p, text) => fs.writeFileSync(path.join(root, p), text);
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q');
  if (scenario !== 'init-empty') {
    git('config', 'user.name', 'qa');
    git('config', 'user.email', 'qa@local');
    write('.gitignore', '.amber/\n');
  }
  const rec = 'node ' + path.join(activePlugin, 'scripts', 'record.cjs');
  const fixture = { root, home, name: scenario, kind: scenario };
  const skill = name => (host === 'codex' ? '$amber:' : '/amber:') + name;
  const progress = () => JSON.parse(fs.readFileSync(path.join(root, '.amber', 'progress.json'), 'utf8'));

  if (scenario === 'status') {
    git('add', '.');
    git('commit', '-qm', 'status fixture baseline');
    // Unlike behavioral QA, this invocation does not bypass hook trust.
    const run = runHost(fixture, skill('status'), { persistedTrust: true, budget: 2 });
    const rows = ledger(home);
    assert.equal(sensorFailures(home), '');
    assertStatusEvidence(host, run, rows, transcriptFiles(run), activePlugin);
    const state = path.join(home, 'state', 'session-' + run.sessionId + '.json');
    assert(fs.existsSync(state), 'S0 did not run with persisted hook trust');
    assert(JSON.parse(fs.readFileSync(state, 'utf8')).started_at, 'S0 timestamp absent');
    assert(!rows.some(r => r.trigger === 'done-declaration'), 'status must not declare completion');
    return { outcome: 'status-persisted-trust-pass', session_id: run.sessionId, root, ledger: rows, final: run.final };
  }

  if (scenario === 'init-empty') {
    // Greenfield: an empty repository and no operator facts. The skill has to
    // ask - anchored on the empty scan rows and bounded to intent.md's three
    // slots (purpose, first oracle, forbidden set) - and must not invent
    // intent.md from nothing.
    const run = runHost(fixture, [
      skill('init'),
      'Explicit operator request: initialize Amber in this empty repository using the init skill. There is no code, no document, and no commit here yet.',
      'I will answer your questions in my next message: ask what you need to settle and then stop. Do not guess the project\'s purpose for me.',
      'Put the oracle map at project-root oracle-map.md and the tension list at project-root tension-list.md when you write them.',
      'The installed plugin is already enabled for this invocation and its AMBER_HOME is isolated. Use its normal sensors and required read-only scan agents. Do not open a planning contract for bootstrap, and do not signal completion.',
    ].join('\n'), { budget: 12, timeout: 1200000 });
    const rows = ledger(home);
    assert.equal(sensorFailures(home), '');
    assert(rows.some(r => r.trigger === 'skill-invocation' && /amber:init/.test(r.summary)), 'init invocation missing');
    assert(!rows.some(r => r.trigger === 'done-declaration'), 'empty-repo init must not declare completion');
    assert(!fs.existsSync(path.join(root, '.amber', 'active.json')), 'init must not open a planning contract');
    const raw = transcriptFiles(run, true).map(p => fs.readFileSync(p, 'utf8')).join('\n');
    assert.match(raw, host === 'codex' ? /spawn_agent/ : /"name":"Agent"/, 'scan delegation absent');
    const oracleMap = path.join(root, 'oracle-map.md');
    assert(fs.existsSync(oracleMap), 'oracle map missing');
    assert(!fs.existsSync(path.join(root, 'intent.md')), 'intent.md written without any operator answer');
    const failures = assessInitEmpty(run.final, fs.readFileSync(oracleMap, 'utf8'));
    assert.deepEqual(failures, [], 'init-empty semantic gate failed: ' + failures.join('; '));
    return { outcome: 'init-empty-ask-gate-pass', session_id: run.sessionId, cost_usd: run.cost, turns: run.turns, root, ledger: rows, final: run.final };
  }

  if (scenario === 'init') {
    write('src/cli.cjs', "console.log('hello');\n");
    write('README.md', '# QA greeting CLI\nRun `node src/cli.cjs`; expected output: hello.\n');
    git('add', '.');
    git('commit', '-qm', 'init fixture baseline');
    const run = runHost(fixture, [
      skill('init'),
      'Explicit operator request: initialize Amber in this isolated greeting CLI project using the init skill, through presentation of draft documents for ratification.',
      'Operator facts: intent is a local demonstration CLI that prints hello; no network, deployment, customers, secrets, or external dependencies. Preserve its code and README. The verifier is node src/cli.cjs with exact stdout hello followed by newline. No other promised behavior.',
      'Use the four standard document roles, docs/work-logs for work logs, and project-root oracle-map.md and tension-list.md. Existing ancestor harness instructions are retained; do not change outside configuration. New entry/intent/status documents are permitted, all are drafts pending my next ratification utterance. Resolve routine reversible wording yourself. If any genuinely material choice remains, report it explicitly.',
      'The installed plugin is already enabled for this invocation and its AMBER_HOME is isolated. Use its normal sensors and required read-only scan agents. Do not open a planning contract for bootstrap, and do not signal completion before ratification. Present every created/changed document and stop at the ratification gate.',
    ].join('\n'), { budget: 12, timeout: 1200000 });
    const rows = ledger(home);
    assert.equal(sensorFailures(home), '');
    assert(rows.some(r => r.trigger === 'skill-invocation' && /amber:init/.test(r.summary)), 'init invocation missing');
    assert(!rows.some(r => r.trigger === 'done-declaration'), 'draft init must not complete before ratification');
    assert(!fs.existsSync(path.join(root, '.amber', 'active.json')), 'init must not open a planning contract');
    const entry = host === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
    for (const p of [entry, 'intent.md', 'status.md', 'oracle-map.md', 'tension-list.md']) {
      assert(fs.existsSync(path.join(root, p)), 'init draft missing: ' + p);
    }
    const text = fs.readFileSync(path.join(root, entry), 'utf8');
    assert.match(text, /record\.cjs/);
    assert.match(text, /--review/);
    assert.match(text, /--goal/);
    assert.match(text, /hold|mark/);
    assert.equal(fs.readFileSync(path.join(root, 'src/cli.cjs'), 'utf8'), "console.log('hello');\n");
    const raw = transcriptFiles(run, true).map(p => fs.readFileSync(p, 'utf8')).join('\n');
    assert.match(raw, host === 'codex' ? /spawn_agent/ : /"name":"Agent"/, 'scan delegation absent');
    assert.match(run.final, /ratif|approv/i, 'ratification gate not presented');
    return { outcome: 'init-draft-gate-pass', session_id: run.sessionId, root, ledger: rows, final: run.final };
  }

  write('AGENTS.md', '# QA zone\nFollow the explicit fixture contract and probe instructions.\n');
  write('CLAUDE.md', '# QA zone\nFollow the explicit fixture contract and probe instructions.\n');
  write('qa-contract.md', [
    '# Runtime QA contract',
    '## Completion conditions',
    '1. src/allowed.txt has exact bytes allowed\\n, verified with node verify.cjs.',
    '2. Forbidden file and command probes were refused; a planted shell write was detected by unit verified and then removed.',
    '3. External hold survived two stops and resume, then start cleared it; a plain hold was consumed once.',
    '4. Status was invoked and this fixture is complete only after all these probes.',
    '- source [machine: write-scope src/**]',
    '- forbidden [machine: bash-deny AMBER_QA_FORBIDDEN_COMMAND]',
  ].join('\n') + '\n');
  write('plan.md', '## Work units\n- [ ] U1 runtime probes [unit: U1 scope=src/** oracle=node verify.cjs]\n');
  write('verify.cjs', "require('node:assert/strict').equal(require('node:fs').readFileSync('src/allowed.txt','utf8'),'allowed\\n'); console.log('PASS allowed bytes');\n");
  write('plant.cjs', "require('node:fs').writeFileSync('outside.txt','planted QA scope violation\\n');\n");
  write('clean.cjs', "require('node:fs').unlinkSync('outside.txt');\n");
  git('add', '.');
  git('commit', '-qm', 'runtime fixture baseline');
  fs.mkdirSync(path.join(root, '.amber'));
  write('.amber/active.json', JSON.stringify({ v: 1, boundary: 'qa-contract.md', ratified_by: 'qa', ratified_at: '2026-09-21' }));
  let run = runHost(fixture, [
    'Run the authorized runtime QA probes in this already approved fixture contract. Do not open a new cycle or finish the contract in this turn.',
    'First run `' + rec + ' unit init plan.md`, then separately `' + rec + ' unit start U1`.',
    'Deliberately submit one FILE TOOL write of forbidden.txt; expect rejection. Separately submit the harmless shell command `printf AMBER_QA_FORBIDDEN_COMMAND`; expect rejection. These are negative probes, do not skip them and do not bypass either denial.',
    'Use the file tool to create src/allowed.txt with exact bytes allowed followed by newline. Run node verify.cjs.',
    'Next run node plant.cjs (authorized fixture fault injection), then `' + rec + ' unit verified U1 --evidence "negative scope probe"`. Expect refusal for outside.txt. Do not declare an exception or mark the unit verified. Run node clean.cjs to remove only the fixture-planted outside.txt.',
    'Finally run `' + rec + ' unit hold U1 --reason "external: QA resume probe"`, report the observations and stop. Do not run done.',
  ].join('\n'), { budget: 6 });
  const firstId = run.sessionId;
  const initial = progress();
  assert(initial.session_ids.includes(firstId), 'driver was not registered');
  assert.equal(initial.hold.kind, 'external');
  assert.equal(initial.units.U1.status, 'running');
  assert.equal(initial.units.U1.reentries, 0);
  assert(!fs.existsSync(path.join(root, 'forbidden.txt')), 'denied file was written');
  assert(!fs.existsSync(path.join(root, 'outside.txt')), 'planted file not cleaned');
  assert.equal(fs.readFileSync(path.join(root, 'src/allowed.txt'), 'utf8'), 'allowed\n');
  const raw = toolEvidence(transcriptFiles(run));
  assert.match(raw, /outside every write-scope/);
  assert.match(raw, /blocked.*(bash-deny|command)|bash-deny.*AMBER_QA_FORBIDDEN_COMMAND/i);
  assert.match(raw, /blocked.*forbidden\.txt|forbidden\.txt.*outside/i);
  assert(!ledger(home).some(r => r.trigger === 'unit-verified'), 'negative scope probe passed');

  run = runHost({ ...fixture, name: 'runtime-resume-external' },
    'Status-only resume check: answer "still waiting" and stop. Do not run tools, change files, clear the external hold, or run done.',
    { resume: firstId, effort: 'low', budget: 1 });
  assert.equal(run.sessionId, firstId, 'resume changed identity');
  assert.deepEqual(progress().hold, initial.hold, 'external hold must survive another stop');
  assert.equal(progress().units.U1.reentries, 0);

  run = runHost({ ...fixture, name: 'runtime-resume-status' }, skill('status'),
    { resume: firstId, budget: 2 });
  assert.equal(run.sessionId, firstId);
  assertStatusEvidence(host, run, ledger(home), transcriptFiles(run), activePlugin);
  assert.deepEqual(progress().hold, initial.hold, 'status must preserve the external hold');

  run = runHost({ ...fixture, name: 'runtime-resume-plain' },
    'Continue QA: run `' + rec + ' unit start U1` to clear the external hold, then `' + rec + ' unit hold U1 --reason "QA one-shot checkpoint"` and stop. Do not do any other unit work or run done.',
    { resume: firstId, effort: 'low', budget: 2 });
  assert.equal(run.sessionId, firstId);
  assert.equal(progress().hold, null, 'plain hold must be consumed once');
  assert.equal(progress().units.U1.reentries, 0);

  run = runHost({ ...fixture, name: 'runtime-resume-complete' }, [
    'Continue the runtime QA contract after the explicit status invocation.',
    'Then run node verify.cjs, review the contract and prior probe evidence. Record `' + rec + ' unit verified U1 --evidence "actual runtime probes and byte verifier passed"`.',
    'If every condition is satisfied, run the usual done command with fresh --review, --goal and --summary as your last tool call and give the completion report.',
  ].join('\n'), { resume: firstId, budget: 4 });
  const rows = ledger(home);
  assert.equal(run.sessionId, firstId);
  assert.equal(sensorFailures(home), '');
  assert.equal(rows.filter(r => r.trigger === 'done-declaration' && r.gate === 'passed').length, 1);
  for (const p of ['active.json', 'progress.json', 'done.json']) assert(!fs.existsSync(path.join(root, '.amber', p)), p + ' not released');
  return { outcome: 'runtime-resume-holds-scope-status-pass', session_id: firstId, root, ledger: rows, final: run.final };
};
module.exports.toolEvidence = toolEvidence;
module.exports.assessInitEmpty = assessInitEmpty;
