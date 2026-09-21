#!/usr/bin/env node
// Amber hook test runner. Builds throwaway zones (contract / empty / broken
// pointer / bad regex) under a temp directory, pipes synthetic hook events
// through amber-hook.cjs with AMBER_HOME redirected, and asserts on stdout,
// the ledger, and gate-counter state. Never touches the real ~/.amber or the
// real zone. Exit code 0 only if every case passes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'amber-hook.cjs');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-test-'));
let passed = 0;
let failed = 0;

function makeZone(name, boundaryText, pointer) {
  const zone = path.join(BASE, name);
  fs.mkdirSync(zone, { recursive: true });
  execFileSync('git', ['-C', zone, 'init', '-q']);
  if (boundaryText !== null) {
    fs.writeFileSync(path.join(zone, 'test-boundary.md'), boundaryText);
  }
  if (pointer !== null) {
    fs.mkdirSync(path.join(zone, '.amber'), { recursive: true });
    fs.writeFileSync(path.join(zone, '.amber', 'active.json'), JSON.stringify(pointer));
  }
  return zone;
}

const BOUNDARY = [
  '# boundary - test contract',
  '',
  '## forbidden lines',
  '- writes stay inside plugin/ [machine: write-scope plugin/**]',
  '- docs are writable too [machine: write-scope docs/*.md]',
  '- no merge or push [machine: bash-deny git\\s+(merge|push)\\b]',
  '',
  '## goal test',
  '- all runner cases pass',
  '',
  '## Standing rules',
  '- keep the journal current [hook: gate]',
].join('\n');

const zoneContract = makeZone('contract', BOUNDARY,
  { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-08-10' });
// Same contract with the standing-rules title spaced and cased differently -
// S0 must extract it regardless.
const zoneRule = makeZone('rule',
  BOUNDARY.replace('## Standing rules', '##  STANDING RULES'),
  { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-08-11' });
const zoneEmpty = makeZone('empty', null, null);
const zoneBrokenPtr = makeZone('broken', null,
  { v: 1, boundary: 'missing-boundary.md', ratified_by: 'operator', ratified_at: '2026-08-10' });
const zoneBadRegex = makeZone('badregex',
  '- bad pattern [machine: bash-deny (unclosed]',
  { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-08-10' });

function freshHome(tag) {
  const home = path.join(BASE, 'home-' + tag);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function runHook(event, input, home) {
  const res = spawnSync('node', [HOOK, event], {
    input: JSON.stringify(input),
    env: Object.assign({}, process.env, { AMBER_HOME: home }),
    encoding: 'utf8',
    timeout: 10000,
  });
  if (res.status !== 0) return { exit: res.status, out: null };
  const trimmed = (res.stdout || '').trim();
  return { exit: 0, out: trimmed ? JSON.parse(trimmed) : null };
}

function ledger(home) {
  try {
    return fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function gateFileExists(home, sessionId) {
  return fs.existsSync(path.join(home, 'state', 'gate-' + sessionId + '.json'));
}

function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('PASS ' + label);
  } else {
    failed += 1;
    console.log('FAIL ' + label + (detail ? ' - ' + detail : ''));
  }
}

function isDeny(out) {
  return !!(out && out.hookSpecificOutput &&
    out.hookSpecificOutput.permissionDecision === 'deny');
}

function e1(zone, tool, toolInput, home) {
  return runHook('E1', {
    session_id: 'e1-test', cwd: zone, hook_event_name: 'PreToolUse',
    tool_name: tool, tool_input: toolInput,
  }, home).out;
}

function stopEvent(zone, message, active) {
  return {
    session_id: 's2-test', cwd: zone, hook_event_name: 'Stop',
    stop_hook_active: !!active, last_assistant_message: message,
  };
}

const RECORD_CLI = path.join(__dirname, '..', 'scripts', 'record.cjs');
// The completion signal: `record.cjs done` run in the zone, as the model does.
function done(zone, home, args, extraEnv) {
  return spawnSync('node', [RECORD_CLI, 'done', ...args], {
    cwd: zone, encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, { AMBER_HOME: home }, extraEnv || {}),
  });
}
const signalPath = (zone) => path.join(zone, '.amber', 'done.json');
const signalExists = (zone) => fs.existsSync(signalPath(zone));
// A hand-written signal for cases the command itself refuses (broken pointer,
// another contract, stale timestamp).
function plantSignal(zone, fields) {
  fs.mkdirSync(path.join(zone, '.amber'), { recursive: true });
  fs.writeFileSync(signalPath(zone), JSON.stringify(Object.assign(
    { v: 1, ts: new Date().toISOString(), target: 'test-boundary.md', review: 'planted review',
      goal: 'planted goal', summary: 'planted summary' }, fields)));
}
const OK_DONE = ['--review', 'current artifact and test evidence satisfy every row',
  '--goal', 'all runner cases pass', '--summary', 'unit complete'];
// Session binding: E1 registers the session that runs a unit
// command itself. Tests drive record.cjs directly, so they register through
// the same observation the live session gets.
function register(zone, home, sessionId, command) {
  return runHook('E1', {
    session_id: sessionId, cwd: zone, hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_input: { command: command || 'node ' + RECORD_CLI + ' unit start U1' },
  }, home).out;
}
const sessionState = (home, sessionId) => {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'state', 'session-' + sessionId + '.json'), 'utf8')); } catch { return {}; }
};

// ---- E1: contract zone ----
{
  const home = freshHome('e1');
  check('E1 write inside scope allowed',
    e1(zoneContract, 'Write', { file_path: path.join(zoneContract, 'plugin/hooks/x.cjs') }, home) === null);
  check('E1 write in second scope allowed',
    e1(zoneContract, 'Write', { file_path: path.join(zoneContract, 'docs/a.md') }, home) === null);
  const outsideDeny = e1(zoneContract, 'Write', { file_path: path.join(zoneContract, 'secrets.txt') }, home);
  check('E1 write outside scope denied', isDeny(outsideDeny),
    JSON.stringify(outsideDeny));
  check('E1 edit escaping the zone denied',
    isDeny(e1(zoneContract, 'Edit', { file_path: path.join(BASE, 'outside.txt') }, home)));
  check('E1 bash matching deny pattern denied',
    isDeny(e1(zoneContract, 'Bash', { command: 'git merge feature' }, home)));
  check('E1 normal bash allowed',
    e1(zoneContract, 'Bash', { command: 'git status' }, home) === null);
  check('E1 pointer edit denied (tamper guard)',
    isDeny(e1(zoneContract, 'Edit', { file_path: path.join(zoneContract, '.amber/active.json') }, home)));
  check('E1 boundary edit denied (tamper guard)',
    isDeny(e1(zoneContract, 'Edit', { file_path: path.join(zoneContract, 'test-boundary.md') }, home)));
}

// ---- E1: no contract, broken pointer, bad regex ----
{
  const home = freshHome('e1b');
  check('E1 no-contract zone: write anywhere allowed',
    e1(zoneEmpty, 'Write', { file_path: path.join(zoneEmpty, 'anything.txt') }, home) === null);
  check('E1 no-contract zone: bash allowed',
    e1(zoneEmpty, 'Bash', { command: 'git merge feature' }, home) === null);
  const brokenOut = e1(zoneBrokenPtr, 'Write', { file_path: path.join(zoneBrokenPtr, 'a.txt') }, home);
  check('E1 broken pointer: write denied', isDeny(brokenOut));
  check('E1 broken pointer: reason says how to release',
    !!(brokenOut && /remove the file to release/.test(
      brokenOut.hookSpecificOutput.permissionDecisionReason)));
  check('E1 invalid bash-deny pattern: bash denied (fail closed)',
    isDeny(e1(zoneBadRegex, 'Bash', { command: 'git status' }, home)));
}

// ---- S2: no contract - the done command and its signal ----
{
  const home = freshHome('s2plain');
  runHook('S0', { session_id: 's2-test', cwd: zoneEmpty, model: 'claude-fable-5' }, home);
  const withGoal = done(zoneEmpty, home, OK_DONE);
  check('done refuses --goal without a contract',
    withGoal.status !== 0 && /omit --goal/.test(withGoal.stderr) && !signalExists(zoneEmpty),
    withGoal.stderr);
  const noSummary = done(zoneEmpty, home, ['--review', 'checked']);
  check('done refuses a missing --summary',
    noSummary.status !== 0 && /--summary/.test(noSummary.stderr) && !signalExists(zoneEmpty));
  const ok = done(zoneEmpty, home,
    ['--review', 'requested artifact exists and its focused test passes', '--summary', 'built the thing']);
  check('done without a contract writes the signal',
    ok.status === 0 && /request/.test(ok.stdout) && signalExists(zoneEmpty), ok.stderr);
  const pass = runHook('S2', stopEvent(zoneEmpty, 'work done - report body only'), home).out;
  const recs = ledger(home);
  check('S2 consumes the no-contract signal and records it',
    pass === null && recs.length === 1 && !signalExists(zoneEmpty), JSON.stringify(recs));
  check('S2 no-contract record has no gate fields',
    recs.length === 1 && !('gate' in recs[0]) && !('contract' in recs[0]));
  check('S2 no-contract record carries the review attestation and summary',
    recs.length === 1 && recs[0].review_target === 'request' &&
    /focused test passes/.test(recs[0].review) && recs[0].summary === 'built the thing');
  check('S2 no-contract record carries model from S0 state',
    recs.length === 1 && recs[0].model === 'claude-fable-5');
  runHook('S2', stopEvent(zoneEmpty, 'just a quiet answer, nothing finished'), home);
  runHook('S2', stopEvent(zoneEmpty,
    'AMBER_REVIEW: request - old marker lines\nAMBER_DONE: must be ignored now'), home);
  runHook('S2', stopEvent(zoneEmpty, 'retry turn without a signal', true), home);
  check('S2 quiet/old-marker/reentrant turns add no records', ledger(home).length === 1);
  plantSignal(zoneEmpty, { target: 'request', goal: null,
    ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
  const stale = runHook('S2', stopEvent(zoneEmpty, 'late stop'), home).out;
  check('S2 drops a stale signal without recording it',
    stale === null && ledger(home).length === 1 && !signalExists(zoneEmpty));
}

// ---- S2 under a contract: signal, pass, release ----
{
  const zone = makeZone('release', BOUNDARY,
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-15' });
  const home = freshHome('release');
  runHook('S0', { session_id: 's2-test', cwd: zone, model: 'claude-fable-5' }, home);
  register(zone, home, 's2-test');
  check('S0 briefed the contract session', sessionState(home, 's2-test').briefed === 'test-boundary.md');
  const noGoal = done(zone, home, ['--review', 'checked', '--summary', 'unit complete']);
  check('done under a contract refuses a missing --goal',
    noGoal.status !== 0 && /--goal/.test(noGoal.stderr) && !signalExists(zone), noGoal.stderr);
  fs.writeFileSync(path.join(zone, '.amber', 'progress.json'),
    JSON.stringify({ v: 1, contract: 'test-boundary.md', plan: 'plan.md', units: {} }));
  const ok = done(zone, home, OK_DONE);
  check('done under a contract writes the signal naming the contract',
    ok.status === 0 && signalExists(zone) &&
    JSON.parse(fs.readFileSync(signalPath(zone), 'utf8')).target === 'test-boundary.md', ok.stderr);
  const pass = runHook('S2', stopEvent(zone, 'completion report body'), home).out;
  check('gate passes a sound signal on the first try', pass === null, JSON.stringify(pass));
  const recs = ledger(home);
  check('gated record carries contract/goal/gate fields',
    recs.length === 1 && recs[0].gate === 'passed' &&
    recs[0].contract === 'test-boundary.md' &&
    recs[0].goal === 'all runner cases pass' &&
    recs[0].review_target === 'test-boundary.md' &&
    /test evidence/.test(recs[0].review) && recs[0].summary === 'unit complete', JSON.stringify(recs));
  check('gate counter absent after pass', !gateFileExists(home, 's2-test'));
  check('pass consumes the signal', !signalExists(zone));
  check('pass releases the contract pointer', !fs.existsSync(path.join(zone, '.amber', 'active.json')));
  check('pass removes progress.json', !fs.existsSync(path.join(zone, '.amber', 'progress.json')));
  check('pass clears the session briefing so a re-approval briefs again', !('briefed' in sessionState(home, 's2-test')));
  const after = runHook('S2', stopEvent(zone, 'next turn in the released zone'), home).out;
  check('released zone is quiet afterwards', after === null && ledger(home).length === 1);
}

// ---- S2 gate: broken pointer - block, exhaustion, withdrawal ----
{
  const home = freshHome('gate3');
  const refused = done(zoneBrokenPtr, home, OK_DONE);
  check('done refuses a broken pointer',
    refused.status !== 0 && /broken/.test(refused.stderr) && !signalExists(zoneBrokenPtr), refused.stderr);
  const attempt = (active) => { plantSignal(zoneBrokenPtr, {}); return runHook('S2', stopEvent(zoneBrokenPtr, 'claimed done', active), home).out; };
  const b1 = attempt(false);
  check('gate blocks a signal under a broken pointer and says why',
    !!(b1 && b1.decision === 'block' && /broken/.test(b1.reason) && /done command again/.test(b1.reason)),
    JSON.stringify(b1));
  check('gate counter created', gateFileExists(home, 's2-test'));
  check('block consumes the signal', !signalExists(zoneBrokenPtr));
  const b2 = attempt(true);
  const b3 = attempt(true);
  const b4 = attempt(true);
  check('gate blocks exactly 3 times then releases',
    !!(b2 && b2.decision === 'block') && !!(b3 && b3.decision === 'block') && b4 === null,
    JSON.stringify([b2 && b2.decision, b3 && b3.decision, b4]));
  const recs = ledger(home);
  check('exhausted declaration recorded with gate:exhausted',
    recs.length === 1 && recs[0].gate === 'exhausted' && recs[0].goal === null &&
    recs[0].contract === 'broken', JSON.stringify(recs));
  check('gate counter cleared after exhaustion', !gateFileExists(home, 's2-test'));
  check('broken contract never produces a passed completion', !recs.some((r) => r.gate === 'passed'));

  const home2 = freshHome('gate4');
  attempt(false);
  fs.writeFileSync(path.join(home2, 'placeholder'), '');
  const b = (() => { plantSignal(zoneBrokenPtr, {}); return runHook('S2', stopEvent(zoneBrokenPtr, 'claimed'), home2).out; })();
  check('withdrawal setup blocked', !!(b && b.decision === 'block'));
  const withdrawal = runHook('S2',
    stopEvent(zoneBrokenPtr, 'resuming the work instead, no signal', true), home2).out;
  check('withdrawal releases the gate', withdrawal === null);
  check('withdrawal clears the counter', !gateFileExists(home2, 's2-test'));
  check('withdrawal records nothing', ledger(home2).length === 0);
}

// ---- S2 gate: foreign re-entry, stale counter, quiet turn, old markers ----
{
  const home = freshHome('gate5');
  const foreign = runHook('S2', stopEvent(zoneContract,
    'done\n\nAMBER_REVIEW: test-boundary.md - current evidence checked\n' +
    'AMBER_GOAL: goal met\nAMBER_DONE: foreign re-entry', true), home).out;
  check('foreign re-entry without a signal stays silent', foreign === null);
  check('foreign re-entry records nothing', ledger(home).length === 0);

  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'gate-s2-test.json'), '{"attempts":1}');
  const afterStale = runHook('S2',
    stopEvent(zoneContract, 'ordinary quiet turn'), home).out;
  check('stale counter on a normal turn is reclaimed silently',
    afterStale === null && !gateFileExists(home, 's2-test'));

  check('quiet turn under contract not blocked',
    runHook('S2', stopEvent(zoneContract, 'just discussing'), home).out === null);
  const markers = runHook('S2', stopEvent(zoneContract,
    'done\n\nAMBER_REVIEW: test-boundary.md - old protocol\nAMBER_GOAL: met\nAMBER_DONE: old protocol'), home).out;
  check('old marker lines under a contract neither block nor record',
    markers === null && ledger(home).length === 0 &&
    fs.existsSync(path.join(zoneContract, '.amber', 'active.json')), JSON.stringify(markers));
  check('quiet turns under contract record nothing', ledger(home).length === 0);
}

// ---- S1 briefing: contract activated mid-session ----
{
  const home = freshHome('brief1');
  runHook('S0', { session_id: 'b1', cwd: zoneEmpty, model: 'm' }, home);
  const out1 = runHook('S1',
    { session_id: 'b1', cwd: zoneContract, prompt: 'please continue' }, home).out;
  const ctx1 = out1 && out1.hookSpecificOutput && out1.hookSpecificOutput.additionalContext;
  check('S1 briefs once when a contract is active and the session is unbriefed',
    !!ctx1 && /test-boundary\.md/.test(ctx1) && / done --review /.test(ctx1),
    JSON.stringify(out1));
  const out2 = runHook('S1',
    { session_id: 'b1', cwd: zoneContract, prompt: 'next turn' }, home).out;
  check('S1 does not re-brief the same boundary', out2 === null);
  const out3 = runHook('S1',
    { session_id: 'b1', cwd: zoneEmpty, prompt: 'elsewhere' }, home).out;
  check('S1 stays silent without a contract', out3 === null);

  const home2 = freshHome('brief2');
  runHook('S0', { session_id: 'b2', cwd: zoneContract, model: 'm' }, home2);
  const out4 = runHook('S1',
    { session_id: 'b2', cwd: zoneContract, prompt: 'hello' }, home2).out;
  check('S1 skips sessions S0 already briefed', out4 === null);
}

// ---- S0 regression ----
{
  const home = freshHome('s0');
  const out = runHook('S0',
    { session_id: 'abc', cwd: zoneEmpty, model: 'claude-fable-5' }, home).out;
  const armCtx = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
  check('S0 contract-less session injects the arming note',
    !!armCtx && /no active contract/.test(armCtx) && /amber:planning/.test(armCtx),
    JSON.stringify(out));
  check('S0 arming note carries the opening criterion',
    !!armCtx && /work request/.test(armCtx) && /Q&A/.test(armCtx));
  check('S0 arming note routes the contract judgment inside planning',
    !!armCtx && /judged inside planning/.test(armCtx) && /recorded/.test(armCtx));
  check('S0 contract-less briefing names the done command without --goal',
    !!armCtx && / done --review /.test(armCtx) && !/--goal/.test(armCtx) && /semantic review/.test(armCtx));
  check('S0 contract-less briefing forbids the signal for incomplete reports',
    !!armCtx && /Never run the command for incomplete/.test(armCtx) &&
    /governed work unit itself complete/.test(armCtx) && !/AMBER_/.test(armCtx));
  check('S0 wrote the session state file',
    fs.existsSync(path.join(home, 'state', 'session-abc.json')));
  fs.appendFileSync(path.join(home, 'state', 'sensor-failures.log'), 'x failure\n');
  const out2 = runHook('S0',
    { session_id: 'abc', cwd: zoneEmpty, model: 'claude-fable-5' }, home).out;
  check('S0 surfaces recorded sensor failures',
    !!(out2 && out2.hookSpecificOutput &&
      /sensor failure/.test(out2.hookSpecificOutput.additionalContext)));
}

// ---- S1: planning-invocation sensor ----
{
  const home = freshHome('s1');
  runHook('S0', { session_id: 's1-test', cwd: zoneEmpty, model: 'claude-fable-5' }, home);
  runHook('S1', { session_id: 's1-test', cwd: zoneEmpty,
    prompt: '/amber:planning refactor the parser' }, home);
  const recs = ledger(home);
  check('S1 records a planning invocation',
    recs.length === 1 && recs[0].trigger === 'planning-invocation' &&
    recs[0].summary === '/amber:planning refactor the parser', JSON.stringify(recs));
  check('S1 record carries model from S0 state',
    recs.length === 1 && recs[0].model === 'claude-fable-5');
  runHook('S1', { session_id: 's1-test', cwd: zoneEmpty,
    prompt: 'ordinary prompt that mentions /amber:planning mid-sentence' }, home);
  runHook('S1', { session_id: 's1-test', cwd: zoneEmpty, prompt: '/amber:planningish' }, home);
  runHook('S1', { session_id: 's1-test', cwd: zoneEmpty, prompt: '/amber:status' }, home);
  check('S1 ignores non-planning prompts', ledger(home).length === 1);
  const res = runHook('S1', { session_id: 's1-test', cwd: zoneEmpty,
    prompt: '/amber:planning again' }, home);
  check('S1 stays exit-0 and stdout-silent', res.exit === 0 && res.out === null);
}

// ---- session state TTL: inactivity, not age ----
{
  const home = freshHome('ttl');
  const stateOf = (id) => path.join(home, 'state', 'session-' + id + '.json');
  const setOld = (id, hours) => {
    const past = new Date(Date.now() - hours * 3600 * 1000);
    fs.utimesSync(stateOf(id), past, past);
  };
  runHook('S0', { session_id: 'alive', cwd: zoneEmpty, model: 'claude-fable-5' }, home);
  runHook('S0', { session_id: 'other', cwd: zoneEmpty, model: 'claude-fable-5' }, home);
  setOld('alive', 49);
  setOld('other', 49);
  runHook('S1', { session_id: 'alive', cwd: zoneEmpty, prompt: 'any prompt' }, home);
  check('S1 refreshes its own session state mtime',
    fs.statSync(stateOf('alive')).mtimeMs > Date.now() - 60000);
  check('S1 leaves other sessions\' state untouched',
    fs.statSync(stateOf('other')).mtimeMs < Date.now() - 48 * 3600 * 1000);
  setOld('alive', 49);
  runHook('S2', { session_id: 'alive', cwd: zoneEmpty,
    last_assistant_message: 'quiet turn' }, home);
  check('S2 refreshes its own session state mtime',
    fs.statSync(stateOf('alive')).mtimeMs > Date.now() - 60000);
  check('S1 for a stateless session creates no state file',
    (() => {
      runHook('S1', { session_id: 'ghost', cwd: zoneEmpty, prompt: 'hi' }, home);
      return !fs.existsSync(stateOf('ghost'));
    })());
  // The sweep itself is unchanged: idle past TTL still reclaimed, active kept.
  runHook('S0', { session_id: 'sweeper', cwd: zoneEmpty, model: 'claude-fable-5' }, home);
  check('S0 sweep reclaims state idle past the TTL',
    !fs.existsSync(stateOf('other')));
  check('S0 sweep keeps recently active state',
    fs.existsSync(stateOf('alive')));
}

// ---- S3: model-invoked amber-skill sensor ----
{
  const home = freshHome('s3');
  runHook('S0', { session_id: 's3-test', cwd: zoneEmpty, model: 'claude-fable-5' }, home);
  function s3(toolInput) {
    return runHook('S3', { session_id: 's3-test', cwd: zoneEmpty,
      hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: toolInput }, home);
  }
  s3({ skill: 'amber:planning', args: 'auth refactor' });
  let recs = ledger(home);
  check('S3 records a prefixed skill invocation with args',
    recs.length === 1 && recs[0].trigger === 'skill-invocation' &&
    recs[0].summary === 'amber:planning auth refactor', JSON.stringify(recs));
  check('S3 record carries model from S0 state',
    recs.length === 1 && recs[0].model === 'claude-fable-5');
  s3({ skill: 'set' });
  recs = ledger(home);
  check('S3 records an unprefixed skill name too',
    recs.length === 2 && recs[1].summary === 'set');
  s3({ skill: 'superpowers:brainstorming' });
  s3({ skill: 'amber:planningish' });
  s3({ name: 'code-review' });
  s3({});
  check('S3 ignores non-amber skills and empty input', ledger(home).length === 2);
  const res = s3({ skill: 'amber:status' });
  check('S3 stays exit-0 and stdout-silent (no permission decision)',
    res.exit === 0 && res.out === null && ledger(home).length === 3);
  s3({ skill: 'amber:init', args: '/home/x/proj' });
  recs = ledger(home);
  check('S3 records an init invocation with args',
    recs.length === 4 && recs[3].summary === 'amber:init /home/x/proj',
    JSON.stringify(recs));
  s3({ skill: 'amber:initx' });
  check('S3 ignores near-miss init names', ledger(home).length === 4);
  s3({ skill: 'amber:audit', args: 'exclude=amber' });
  recs = ledger(home);
  check('S3 records an audit invocation with args',
    recs.length === 5 && recs[4].trigger === 'skill-invocation' &&
    recs[4].summary === 'amber:audit exclude=amber', JSON.stringify(recs));
}

// ---- S0: contract awareness injection ----
{
  const home = freshHome('s0c');
  const out = runHook('S0', { session_id: 'c1', cwd: zoneContract, model: 'm' }, home).out;
  const ctx = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
  check('S0 injects active-contract identity',
    !!ctx && /test-boundary\.md/.test(ctx) && /approved by operator/.test(ctx),
    JSON.stringify(out));
  check('S0 injection carries the standing obligations verbatim',
    !!ctx && /keep the journal current/.test(ctx));
  check('S0 injection carries the completion-signal and mark conventions',
    !!ctx && / done --review /.test(ctx) && /--goal "<goal-test result of test-boundary\.md>"/.test(ctx) &&
    /releases the contract by itself/.test(ctx) && /amber:mark/.test(ctx) && !/AMBER_/.test(ctx));
  check('S0 contract briefing forbids the signal for an incomplete assessment',
    !!ctx && /Never run the command for incomplete/.test(ctx) &&
    /never that an assessment, report, or attempt finished/.test(ctx));
  check('S0 contract session carries no arming note',
    !!ctx && !/no active contract/.test(ctx));
  const outRule = runHook('S0', { session_id: 'c4', cwd: zoneRule, model: 'm' }, home).out;
  const ctxRule = outRule && outRule.hookSpecificOutput && outRule.hookSpecificOutput.additionalContext;
  check('S0 extracts the standing-rules section whatever its spacing and case',
    !!ctxRule && /keep the journal current/.test(ctxRule), JSON.stringify(outRule));
  const out3 = runHook('S0', { session_id: 'c3', cwd: zoneBrokenPtr, model: 'm' }, home).out;
  const ctx3 = out3 && out3.hookSpecificOutput && out3.hookSpecificOutput.additionalContext;
  check('S0 surfaces a broken pointer at session start',
    !!ctx3 && /broken/.test(ctx3), JSON.stringify(out3));

  plantSignal(zoneBrokenPtr, { target: 'missing-boundary.md', summary: 'must not pass' });
  const brokenDone = runHook('S2', stopEvent(zoneBrokenPtr, 'claimed done'), home).out;
  check('S2 broken contract cannot produce a passed completion',
    !!(brokenDone && brokenDone.decision === 'block' && /broken/.test(brokenDone.reason)) &&
    !ledger(home).some((row) => row.gate === 'passed'), JSON.stringify(brokenDone));
}

// ---- S2 signal target is mechanically tied to the current contract ----
{
  const home = freshHome('review-target');
  register(zoneContract, home, 's2-test');
  plantSignal(zoneContract, { target: 'older-boundary.md', summary: 'wrong target' });
  const wrong = runHook('S2', stopEvent(zoneContract, 'done'), home).out;
  check('gate rejects a signal written for another contract',
    !!(wrong && wrong.decision === 'block' && /test-boundary\.md/.test(wrong.reason) &&
      /older-boundary\.md/.test(wrong.reason)),
    JSON.stringify(wrong));
  check('wrong signal target records no completion and keeps the pointer',
    ledger(home).length === 0 && !signalExists(zoneContract) &&
    fs.existsSync(path.join(zoneContract, '.amber', 'active.json')));
  runHook('S2', stopEvent(zoneContract, 'withdrawn', true), home);
}

// ---- mark: cycle events as tool calls ----
{
  const home = freshHome('mark');
  const call = (name, args) =>
    runHook('S3', { session_id: 's3-mark', cwd: zoneEmpty,
      tool_input: { skill: name, args } }, home);
  call('amber:mark', 'skip - opening verdict - no contract: outputs land outside the zone');
  const recs = ledger(home);
  check('mark skip call records a skip row carrying the verdict text',
    recs.length === 1 && recs[0].trigger === 'skip' &&
    /opening verdict/.test(recs[0].summary) && !/^skip\b/.test(recs[0].summary),
    JSON.stringify(recs));
  call('mark', 'finding: null check missing - applied');
  check('mark finding call records a finding row (unprefixed name, colon form)',
    ledger(home).length === 2 && ledger(home)[1].trigger === 'finding' &&
    /null check/.test(ledger(home)[1].summary));
  call('amber:mark', 'note - malformed kind');
  check('malformed mark args fall back to a skill-invocation row',
    ledger(home).length === 3 && ledger(home)[2].trigger === 'skill-invocation' &&
    /mark/.test(ledger(home)[2].summary),
    JSON.stringify(ledger(home)));
  runHook('S2', stopEvent(zoneEmpty, [
    'AMBER_SKIP: text marker - must no longer record',
    'AMBER_FINDING: text marker - must no longer record',
  ].join('\n')), home);
  check('S2 no longer collects text-marker lines', ledger(home).length === 3);
  const gated = runHook('S2', stopEvent(zoneContract,
    'work summary\n\nAMBER_DONE: with no goal line'), home).out;
  check('a bare AMBER_DONE line is plain text now - no gate, no record',
    gated === null && ledger(home).length === 3, JSON.stringify(gated));
}

// ---- loop body: progress.json, unit commands, worktree-aware E1, S2 continuation ----
{
  const RECORD = path.join(__dirname, '..', 'scripts', 'record.cjs');
  const LOOP_BOUNDARY = [
    '# boundary - loop test contract',
    '',
    '## forbidden lines',
    '- writes stay inside plugin/ [machine: write-scope plugin/**]',
    '- docs are writable too [machine: write-scope docs/*.md]',
    '- no push [machine: bash-deny git\\s+push\\b]',
    '',
    '## Standing rules',
    '- keep the journal current',
  ].join('\n');
  const PLAN = [
    '# loop test plan',
    '',
    '## Work units',
    '- [ ] U1 hook part [unit: U1 scope=plugin/hooks/** oracle=node plugin/tests/run-tests.cjs]',
    '- [ ] U2 docs part [unit: U2 scope=docs/*.md oracle=grep -c ok docs/a.md]',
    '- [ ] U3 integrate [unit: U3 scope=plugin/**,docs/*.md after=U1,U2 oracle=node plugin/tests/run-tests.cjs]',
    '',
    '## Progress log',
  ].join('\n');
  const zone = makeZone('loop', LOOP_BOUNDARY,
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-14' });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(zone, 'plugin', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  fs.writeFileSync(path.join(zone, '.gitignore'), '.amber/\n.claude/worktrees/\n');
  execFileSync('git', ['-C', zone, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', zone, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', zone, 'add', '-A']);
  execFileSync('git', ['-C', zone, 'commit', '-q', '-m', 'init']);
  const home = freshHome('loop');
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = () => JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  const record = (args, extraEnv) => spawnSync('node', [RECORD, ...args], {
    cwd: zone, encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, { AMBER_HOME: home, AMBER_SESSION_ID: 'loop-shell' }, extraEnv || {}),
  });
  const rows = (trigger) => ledger(home).filter((r) => r.trigger === trigger);

  // unit init / start
  const init = record(['unit', 'init', 'docs/plan.md']);
  check('unit init creates progress.json from the plan unit rows',
    init.status === 0 && fs.existsSync(progressFile) &&
    Object.keys(progress().units).join(',') === 'U1,U2,U3',
    (init.stderr || '') + (init.stdout || ''));
  check('unit init parses scope, after, and oracle',
    fs.existsSync(progressFile) && progress().units.U1.scope.join() === 'plugin/hooks/**' &&
    progress().units.U3.after.join() === 'U1,U2' &&
    progress().units.U3.scope.join() === 'plugin/**,docs/*.md' &&
    progress().units.U2.oracle === 'grep -c ok docs/a.md',
    fs.existsSync(progressFile) ? JSON.stringify(progress().units) : 'no progress file');
  check('unit init writes a unit-init ledger row', rows('unit-init').length === 1, JSON.stringify(ledger(home)));
  const start = record(['unit', 'start', 'U1']);
  check('unit start marks the unit running and current',
    start.status === 0 && fs.existsSync(progressFile) && progress().units.U1.status === 'running' &&
    progress().current === 'U1', (start.stderr || '') + (start.stdout || ''));
  check('unit start writes a unit-start ledger row', rows('unit-start').length === 1);

  // worktree-aware E1
  const wt = path.join(zone, '.claude', 'worktrees', 'agent-a1');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync('git', ['-C', zone, 'worktree', 'add', '-q', '-b', 'worktree-agent-a1', wt]);
  const e1wt = (tool, toolInput, agentId) => runHook('E1', Object.assign({
    session_id: 'e1-loop', cwd: wt, hook_event_name: 'PreToolUse',
    tool_name: tool, tool_input: toolInput,
  }, agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}), home).out;
  check('E1 in a worktree still finds the zone contract (outside-scope write denied)',
    isDeny(e1wt('Write', { file_path: path.join(wt, 'secrets.txt') })),
    JSON.stringify(e1wt('Write', { file_path: path.join(wt, 'secrets.txt') })));
  check('E1 in a worktree maps the path back to the zone (inside-scope write allowed)',
    e1wt('Write', { file_path: path.join(wt, 'plugin', 'hooks', 'a.cjs') }) === null);
  const unclaimed = e1wt('Write', { file_path: path.join(wt, 'plugin', 'hooks', 'a.cjs') }, 'a1');
  check('E1 denies a subagent write before it claims a unit',
    isDeny(unclaimed) && /claim/.test(unclaimed.hookSpecificOutput.permissionDecisionReason),
    JSON.stringify(unclaimed));
  const claim = e1wt('Bash', { command: 'node ' + RECORD + ' unit claim U1' }, 'a1');
  check('E1 observes a subagent unit claim and records its agent id',
    claim === null && progress().units.U1.agent_id === 'a1',
    JSON.stringify(claim) + ' ' + JSON.stringify(progress().units.U1));
  check('E1 allows the claimed subagent inside its unit scope',
    e1wt('Write', { file_path: path.join(wt, 'plugin', 'hooks', 'a.cjs') }, 'a1') === null);
  const outside = e1wt('Write', { file_path: path.join(wt, 'docs', 'a.md') }, 'a1');
  check('E1 denies the claimed subagent outside its unit scope even inside the contract scope',
    isDeny(outside) && /U1/.test(outside.hookSpecificOutput.permissionDecisionReason),
    JSON.stringify(outside));
  const claimRun = record(['unit', 'claim', 'U1']);
  check('unit claim command reports the observed claim', claimRun.status === 0 && /a1/.test(claimRun.stdout),
    (claimRun.stderr || '') + (claimRun.stdout || ''));

  // S2 continuation
  const plain = (active) => stopEvent(zone, 'Finished the hook part for now.', active);
  runHook('S0', { session_id: 's2-test', cwd: zone, model: 'loop-model' }, home);
  register(zone, home, 's2-test');
  check('registration lists the session in progress.json', progress().session_ids.join() === 's2-test');
  const b1 = runHook('S2', plain(false), home).out;
  check('S2 blocks a plain stop while units remain open',
    !!(b1 && b1.decision === 'block' && /U1/.test(b1.reason)), JSON.stringify(b1));
  check('S2 counts the re-entry on the current unit', progress().units.U1.reentries === 1);
  let last = b1;
  for (let i = 2; i <= 10; i += 1) last = runHook('S2', plain(true), home).out;
  check('S2 keeps blocking up to the tenth re-entry',
    !!(last && last.decision === 'block') && progress().units.U1.reentries === 10, JSON.stringify(last));
  const eleventh = runHook('S2', plain(true), home).out;
  check('S2 releases the stop after ten re-entries and marks the unit limit',
    eleventh === null && progress().units.U1.status === 'limit' && rows('unit-limit').length === 1,
    JSON.stringify(eleventh) + ' ' + JSON.stringify(progress().units.U1));
  record(['unit', 'start', 'U2']);
  const b2 = runHook('S2', plain(false), home).out;
  check('S2 starts a fresh count when the current unit changes',
    !!(b2 && b2.decision === 'block' && /U2/.test(b2.reason)) && progress().units.U2.reentries === 1,
    JSON.stringify(b2));
  const hold = record(['unit', 'hold', 'U2', '--reason', 'waiting for the operator']);
  check('unit hold records the hold', hold.status === 0 && progress().hold && progress().hold.unit === 'U2' &&
    rows('unit-hold').length === 1, (hold.stderr || '') + JSON.stringify(progress().hold));
  const held = runHook('S2', plain(false), home).out;
  check('S2 lets a held stop through and consumes the hold',
    held === null && progress().hold === null, JSON.stringify(held) + ' ' + JSON.stringify(progress().hold));
  const afterHold = runHook('S2', plain(false), home).out;
  check('S2 blocks again once the hold is consumed', !!(afterHold && afterHold.decision === 'block'));
  const s3 = runHook('S3', {
    session_id: 's2-test', cwd: zone, hook_event_name: 'PreToolUse', tool_name: 'Skill',
    tool_input: { skill: 'amber:mark', args: 'hold - U2 - need operator decision' },
  }, home).out;
  check('mark hold via S3 records the hold in progress and ledger',
    s3 === null && progress().hold && /operator/.test(progress().hold.reason) && rows('unit-hold').length === 2,
    JSON.stringify(progress().hold));
  runHook('S2', plain(false), home); // consume

  // verified / failed transitions
  const ver = record(['unit', 'verified', 'U2', '--evidence', 'grep found 1 ok']);
  check('unit verified records the transition',
    ver.status === 0 && progress().units.U2.status === 'verified' && rows('unit-verified').length === 1,
    (ver.stderr || '') + (ver.stdout || ''));
  const fail = record(['unit', 'failed', 'U3', '--evidence', 'runner 1 failed']);
  check('unit failed keeps the unit open and records it',
    fail.status === 0 && progress().units.U3.status === 'failed' && rows('unit-failed').length === 1);

  // the done command refuses while units are open
  const home2 = freshHome('loop-decl');
  runHook('S0', { session_id: 's2-test', cwd: zone, model: 'loop-model' }, home2);
  register(zone, home2, 's2-test');
  const LOOP_DONE = ['--review', 'all units verified', '--goal', 'met', '--summary', 'loop test complete'];
  const openRefusal = done(zone, home2, LOOP_DONE);
  check('done refuses while plan units are open',
    openRefusal.status !== 0 && /units still open: U3/.test(openRefusal.stderr) && !signalExists(zone),
    openRefusal.stderr);
  record(['unit', 'verified', 'U3', '--evidence', 'runner passed'], { AMBER_HOME: home2 });
  const okDone = done(zone, home2, LOOP_DONE);
  check('done accepts once every unit is closed (limit counts as closed)',
    okDone.status === 0 && signalExists(zone), okDone.stderr);

  // declaration gate: worktrees must be gone
  const wtBlock = runHook('S2', stopEvent(zone, 'report', false), home2).out;
  check('S2 rejects a completion signal while a worktree remains',
    !!(wtBlock && wtBlock.decision === 'block' && /worktree/.test(wtBlock.reason) &&
      /done command again/.test(wtBlock.reason)) && !signalExists(zone), JSON.stringify(wtBlock));
  execFileSync('git', ['-C', zone, 'worktree', 'remove', '--force', wt]);
  done(zone, home2, LOOP_DONE);
  const wtPass = runHook('S2', stopEvent(zone, 'report', true), home2).out;
  check('S2 records the completion once no worktree remains',
    wtPass === null && ledger(home2).some((r) => r.trigger === 'done-declaration' && r.gate === 'passed'),
    JSON.stringify(wtPass) + ' ' + JSON.stringify(ledger(home2)));
  check('the passed loop completion releases pointer and progress',
    !fs.existsSync(path.join(zone, '.amber', 'active.json')) && !fs.existsSync(progressFile));

  // a completion that closes a turn our continuation brought back is recorded
  const reactivate = (h) => {
    fs.writeFileSync(path.join(zone, '.amber', 'active.json'), JSON.stringify(
      { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-15' }));
    record(['unit', 'init', 'docs/plan.md', '--force'], { AMBER_HOME: h });
  };
  const home3 = freshHome('loop-cont-decl');
  runHook('S0', { session_id: 's2-test', cwd: zone, model: 'loop-model' }, home3);
  reactivate(home3);
  register(zone, home3, 's2-test');
  for (const u of ['U1', 'U2']) {
    record(['unit', 'start', u], { AMBER_HOME: home3 });
    record(['unit', 'verified', u, '--evidence', 'ok'], { AMBER_HOME: home3 });
  }
  record(['unit', 'start', 'U3'], { AMBER_HOME: home3 });
  record(['unit', 'failed', 'U3', '--evidence', 'reopened for the continuation case'], { AMBER_HOME: home3 });
  const contBlock = runHook('S2', plain(false), home3).out;
  check('S2 continuation blocks again with a reopened unit',
    !!(contBlock && contBlock.decision === 'block'), JSON.stringify(contBlock));
  record(['unit', 'verified', 'U3', '--evidence', 'closed again'], { AMBER_HOME: home3 });
  done(zone, home3, LOOP_DONE);
  const contDecl = runHook('S2', stopEvent(zone, 'report', true), home3).out;
  check('S2 records a completion on the re-entered stop after its own continuation',
    contDecl === null && ledger(home3).some((r) => r.trigger === 'done-declaration' && r.gate === 'passed'),
    JSON.stringify(contDecl) + ' ' + JSON.stringify(ledger(home3).map((r) => r.trigger)));
  const foreign = runHook('S2', stopEvent(zone, 'report', true), home3).out;
  check('S2 stays silent on a re-entered stop once the signal is consumed',
    foreign === null && ledger(home3).filter((r) => r.trigger === 'done-declaration').length === 1);

  // S0 briefing carries progress; no progress file means no continuation
  reactivate(home);
  const s0 = runHook('S0', { session_id: 'brief-loop', cwd: zone, model: 'm' }, home).out;
  const ctx = s0 && s0.hookSpecificOutput && s0.hookSpecificOutput.additionalContext;
  check('S0 briefing summarizes progress.json', !!ctx && /3 of 3 unit\(s\) open/.test(ctx) && /U1/.test(ctx), String(ctx).slice(0, 300));
  const home4 = freshHome('loop-s1');
  runHook('S0', { session_id: 'brief-loop-s1', cwd: zoneEmpty, model: 'm' }, home4);
  const s1 = runHook('S1', { session_id: 'brief-loop-s1', cwd: zone, prompt: 'continue' }, home4).out;
  const ctx1 = s1 && s1.hookSpecificOutput && s1.hookSpecificOutput.additionalContext;
  check('S1 mid-session briefing also carries the progress summary',
    !!ctx1 && /test-boundary\.md/.test(ctx1) && /amber progress/.test(ctx1) && /U1/.test(ctx1), String(ctx1).slice(0, 300));
  const quiet = runHook('S2', stopEvent(zoneContract, 'plain turn without progress', false), home).out;
  check('S2 stays quiet under a contract without progress.json', quiet === null, JSON.stringify(quiet));
}

// ---- session binding: the loop body and the completion gate act only for driving sessions ----
{
  const PLAN = [
    '## Work units',
    '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]',
    '- [ ] U2 two [unit: U2 scope=docs/*.md after=U1 oracle=true]',
  ].join('\n');
  const zone = makeZone('bind', BOUNDARY,
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-15' });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const home = freshHome('bind');
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = () => JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  const record = (args) => spawnSync('node', [RECORD_CLI, ...args], {
    cwd: zone, encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, { AMBER_HOME: home, AMBER_SESSION_ID: 'bind-shell' }),
  });
  record(['unit', 'init', 'docs/plan.md']);
  record(['unit', 'start', 'U1']);
  check('progress.json starts with an empty session list', progress().session_ids.length === 0);
  for (const id of ['drv', 'talk']) runHook('S0', { session_id: id, cwd: zone, model: 'm' }, home);

  const reg = register(zone, home, 'drv');
  check('E1 registers the session that runs a unit command itself',
    reg === null && sessionState(home, 'drv').run === 'test-boundary.md' && progress().session_ids.join() === 'drv',
    JSON.stringify(sessionState(home, 'drv')) + ' ' + JSON.stringify(progress().session_ids));
  register(zone, home, 'drv2', 'node ' + RECORD_CLI + ' done --review "r" --goal "g" --summary "s"');
  check('E1 registers on the done command too',
    sessionState(home, 'drv2').run === 'test-boundary.md' && progress().session_ids.includes('drv2'));
  register(zone, home, 'drv');
  check('registration is idempotent', progress().session_ids.filter((x) => x === 'drv').length === 1);
  runHook('E1', { session_id: 'sub', cwd: zone, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    agent_id: 'a9', agent_type: 'general-purpose',
    tool_input: { command: 'node ' + RECORD_CLI + ' unit claim U1' } }, home);
  check('a subagent call does not register a session',
    !sessionState(home, 'sub').run && !progress().session_ids.includes('sub'));
  runHook('E1', { session_id: 'talk', cwd: zone, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'git status' } }, home);
  check('an ordinary command does not register', !sessionState(home, 'talk').run);

  const talkStop = runHook('S2', { session_id: 'talk', cwd: zone, hook_event_name: 'Stop',
    stop_hook_active: false, last_assistant_message: 'just chatting' }, home).out;
  check('a non-driving session is not sent back while units are open',
    talkStop === null && progress().units.U1.reentries === 0 && !(progress().blocks > 0) &&
    !fs.existsSync(path.join(home, 'state', 'loop-talk.json')), JSON.stringify(talkStop));
  const drvStop = runHook('S2', { session_id: 'drv', cwd: zone, hook_event_name: 'Stop',
    stop_hook_active: false, last_assistant_message: 'stopping' }, home).out;
  check('the driving session is still sent back',
    !!(drvStop && drvStop.decision === 'block') && progress().units.U1.reentries === 1, JSON.stringify(drvStop));

  plantSignal(zone, { summary: 'planted by nobody' });
  const talkSignal = runHook('S2', { session_id: 'talk', cwd: zone, hook_event_name: 'Stop',
    stop_hook_active: false, last_assistant_message: 'x' }, home).out;
  check('a non-driving session leaves a completion signal untouched',
    talkSignal === null && signalExists(zone) && ledger(home).every((r) => r.trigger !== 'done-declaration'));
  fs.writeFileSync(path.join(home, 'state', 'session-drv3.json'), JSON.stringify({ run: 'other-boundary.md' }));
  const drv3 = runHook('S2', { session_id: 'drv3', cwd: zone, hook_event_name: 'Stop',
    stop_hook_active: false, last_assistant_message: 'x' }, home).out;
  check('a registration for another contract does not count',
    drv3 === null && signalExists(zone) && progress().units.U1.reentries === 1);
  record(['unit', 'verified', 'U1', '--evidence', 'ok']);
  record(['unit', 'start', 'U2']);
  record(['unit', 'verified', 'U2', '--evidence', 'ok']);
  const drvSignal = runHook('S2', { session_id: 'drv', cwd: zone, hook_event_name: 'Stop',
    stop_hook_active: true, last_assistant_message: 'report' }, home).out;
  check('the driving session consumes the signal and releases the run',
    drvSignal === null && !signalExists(zone) && !fs.existsSync(progressFile) &&
    !fs.existsSync(path.join(zone, '.amber', 'active.json')) &&
    ledger(home).some((r) => r.trigger === 'done-declaration' && r.gate === 'passed'), JSON.stringify(drvSignal));

  // briefing and resume
  fs.writeFileSync(path.join(zone, '.amber', 'active.json'), JSON.stringify(
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-15' }));
  record(['unit', 'init', 'docs/plan.md', '--force']);
  register(zone, home, 'drv4');
  const resumed = runHook('S0', { session_id: 'drv4', cwd: zone, model: 'm', source: 'compact' }, home).out;
  const rctx = resumed && resumed.hookSpecificOutput && resumed.hookSpecificOutput.additionalContext;
  check('S0 on resume/compact keeps the session driving its run',
    sessionState(home, 'drv4').run === 'test-boundary.md' && !!rctx && /this session drives the run/.test(rctx),
    String(rctx).slice(-300));
  const other = runHook('S0', { session_id: 'talk2', cwd: zone, model: 'm' }, home).out;
  const octx = other && other.hookSpecificOutput && other.hookSpecificOutput.additionalContext;
  check('S0 tells a non-driving session so and how to take over',
    !!octx && /not one of them/.test(octx) && /1 session\(s\) drive/.test(octx) && /unit/.test(octx), String(octx).slice(-400));
  const s1 = runHook('S1', { session_id: 'talk3', cwd: zone, prompt: 'hello' }, home).out;
  const s1ctx = s1 && s1.hookSpecificOutput && s1.hookSpecificOutput.additionalContext;
  check('S1 briefing carries the ownership line too', !!s1ctx && /not one of them/.test(s1ctx));
}

// ---- shell attribution: unit rows carry the session E1 registered, not "shell"/"unknown" ----
{
  const PLAN = [
    '## Work units',
    '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]',
    '- [ ] U2 two [unit: U2 scope=docs/*.md oracle=true]',
  ].join('\n');
  const zone = makeZone('attr', BOUNDARY,
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-17' });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const home = freshHome('attr');
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = () => JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  // No environment session id: the registration-lookup path. The runner may
  // itself run inside a Claude Code session, whose CLAUDE_CODE_SESSION_ID
  // would otherwise be inherited and win - blank it explicitly.
  const bare = (args, extraEnv) => spawnSync('node', [RECORD_CLI, ...args], {
    cwd: zone, encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, { AMBER_HOME: home, AMBER_SESSION_ID: '', CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '' }, extraEnv || {}),
  });
  const lastRow = (h) => ledger(h || home).slice(-1)[0] || {};
  runHook('S0', { session_id: 'sa', cwd: zone, model: 'model-a' }, home);
  runHook('S0', { session_id: 'sb', cwd: zone, model: 'model-b' }, home);
  register(zone, home, 'sa', 'node ' + RECORD_CLI + ' unit init docs/plan.md');
  const init = bare(['unit', 'init', 'docs/plan.md']);
  check('a shell unit init is attributed to the session E1 registered (no progress.json yet)',
    init.status === 0 && lastRow().trigger === 'unit-init' && lastRow().session_id === 'sa' &&
    lastRow().model === 'model-a', (init.stderr || '') + JSON.stringify(lastRow()));
  register(zone, home, 'sb');
  const start = bare(['unit', 'start', 'U1']);
  check('the most recently registered driver takes the row and the progress history',
    start.status === 0 && lastRow().session_id === 'sb' && lastRow().model === 'model-b' &&
    progress().units.U1.history.slice(-1)[0].by === 'sb', (start.stderr || '') + JSON.stringify(lastRow()));
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(home, 'state', 'session-sb.json'), old, old);
  register(zone, home, 'sa');
  const hold = bare(['unit', 'hold', 'U1', '--reason', 'waiting']);
  check('an idempotent re-registration touches the state file, so the issuing session wins',
    hold.status === 0 && lastRow().trigger === 'unit-hold' && lastRow().session_id === 'sa' &&
    lastRow().model === 'model-a', (hold.stderr || '') + JSON.stringify(lastRow()));
  const env = bare(['unit', 'start', 'U2'], { AMBER_SESSION_ID: 'env-id' });
  check('an explicit environment session id still wins',
    env.status === 0 && lastRow().session_id === 'env-id', (env.stderr || '') + JSON.stringify(lastRow()));
  const none = freshHome('attr-none');
  const bareNone = bare(['unit', 'failed', 'U2', '--evidence', 'x'], { AMBER_HOME: none });
  check('without any registration the row still says shell/unknown (negative control)',
    bareNone.status === 0 && lastRow(none).session_id === 'shell' && lastRow(none).model === 'unknown',
    (bareNone.stderr || '') + JSON.stringify(lastRow(none)));
}

// ---- worktree zone: a linked worktree with its own pointer is its own zone ----
{
  const zone = makeZone('wtz', BOUNDARY,
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-15' });
  fs.mkdirSync(path.join(zone, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(zone, '.gitignore'), '.amber/\n.claude/worktrees/\n');
  execFileSync('git', ['-C', zone, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', zone, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', zone, 'add', '-A']);
  execFileSync('git', ['-C', zone, 'commit', '-q', '-m', 'init']);
  const side = path.join(BASE, 'wtz-side');
  execFileSync('git', ['-C', zone, 'worktree', 'add', '-q', '-b', 'side', side]);
  const home = freshHome('wtz');
  const e1At = (cwd, file) => runHook('E1', { session_id: 'wt', cwd, hook_event_name: 'PreToolUse',
    tool_name: 'Write', tool_input: { file_path: file } }, home).out;
  check('a linked worktree without a pointer maps to the main zone',
    e1At(side, path.join(side, 'plugin', 'x.cjs')) === null && isDeny(e1At(side, path.join(side, 'secrets.txt'))));
  fs.writeFileSync(path.join(side, 'side-boundary.md'),
    '# side\n- docs only [machine: write-scope docs/**]\n## Standing rules\n- side rule\n');
  fs.mkdirSync(path.join(side, '.amber'), { recursive: true });
  fs.writeFileSync(path.join(side, '.amber', 'active.json'), JSON.stringify(
    { v: 1, boundary: 'side-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-15' }));
  const sideDeny = e1At(side, path.join(side, 'plugin', 'x.cjs'));
  check('a linked worktree with its own pointer is its own zone (its contract governs)',
    isDeny(sideDeny) && /side-boundary\.md/.test(sideDeny.hookSpecificOutput.permissionDecisionReason) &&
    e1At(side, path.join(side, 'docs', 'a.md')) === null, JSON.stringify(sideDeny));
  check('the main zone is unaffected by the side zone',
    e1At(zone, path.join(zone, 'plugin', 'x.cjs')) === null && isDeny(e1At(zone, path.join(zone, 'secrets.txt'))));
  const s0 = runHook('S0', { session_id: 'wt', cwd: side, model: 'm' }, home).out;
  const ctx = s0 && s0.hookSpecificOutput && s0.hookSpecificOutput.additionalContext;
  check('S0 in the side zone briefs the side contract', !!ctx && /side-boundary\.md/.test(ctx) && /side rule/.test(ctx));
  register(side, home, 'wt');
  const sideDone = done(side, home, ['--review', 'r', '--goal', 'g', '--summary', 'side done']);
  check('done in the side zone signals the side contract',
    sideDone.status === 0 && fs.existsSync(path.join(side, '.amber', 'done.json')) &&
    !fs.existsSync(path.join(zone, '.amber', 'done.json')), sideDone.stderr);
  const sidePass = runHook('S2', { session_id: 'wt', cwd: side, hook_event_name: 'Stop',
    stop_hook_active: false, last_assistant_message: 'report' }, home).out;
  check('the side run completes and releases only its own pointer',
    sidePass === null && !fs.existsSync(path.join(side, '.amber', 'active.json')) &&
    fs.existsSync(path.join(zone, '.amber', 'active.json')) &&
    ledger(home).some((r) => r.contract === 'side-boundary.md' && r.gate === 'passed'), JSON.stringify(sidePass));
  fs.writeFileSync(path.join(side, '.amber', 'active.json'), JSON.stringify(
    { v: 1, boundary: 'side-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-15' }));
  register(zone, home, 'mn');
  done(zone, home, OK_DONE);
  const mainPass = runHook('S2', { session_id: 'mn', cwd: zone, hook_event_name: 'Stop',
    stop_hook_active: false, last_assistant_message: 'report' }, home).out;
  check('a sibling worktree zone does not block the main run\'s completion',
    mainPass === null && !fs.existsSync(path.join(zone, '.amber', 'active.json')) &&
    fs.existsSync(path.join(side, '.amber', 'active.json')) &&
    ledger(home).some((r) => r.contract === 'test-boundary.md' && r.gate === 'passed'), JSON.stringify(mainPass));
}

// ---- post-hoc scope check: verified/done compare git-changed files with the write-scope ----
{
  const RECORD = path.join(__dirname, '..', 'scripts', 'record.cjs');
  const SCOPE_BOUNDARY = [
    '# boundary - scope test contract',
    '',
    '## forbidden lines',
    '- writes stay inside plugin/ [machine: write-scope plugin/**]',
    '- docs are writable too [machine: write-scope docs/*.md]',
    '',
    '## goal test',
    '- all cases pass',
  ].join('\n');
  const SCOPE_PLAN = [
    '## Work units',
    '- [ ] U1 plugin part [unit: U1 scope=plugin/** oracle=true]',
    '- [ ] U2 docs part [unit: U2 scope=docs/*.md after=U1 oracle=true]',
  ].join('\n');
  const zone = makeZone('scope', SCOPE_BOUNDARY,
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-16' });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(zone, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), SCOPE_PLAN);
  fs.writeFileSync(path.join(zone, '.gitignore'), '.amber/\n');
  fs.writeFileSync(path.join(zone, 'top.txt'), 'x\n');
  fs.writeFileSync(path.join(zone, 'other.txt'), 'y\n');
  const git = (...args) => execFileSync('git', ['-C', zone, ...args], { encoding: 'utf8' }).trim();
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'init - adds the contract file, so this is the baseline');
  const baseline = git('rev-parse', 'HEAD');
  // Dirty before the run begins: a modified tracked file and an untracked
  // file, both outside the write-scope - the run must not be charged for them.
  fs.appendFileSync(path.join(zone, 'top.txt'), 'pre-run edit\n');
  fs.writeFileSync(path.join(zone, 'preexist.txt'), 'pre\n');
  const home = freshHome('scope');
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = () => JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  const record = (args) => spawnSync('node', [RECORD, ...args], {
    cwd: zone, encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, { AMBER_HOME: home, AMBER_SESSION_ID: 'scope-shell' }),
  });
  const rows = (trigger) => ledger(home).filter((r) => r.trigger === trigger);
  const SCOPE_DONE = ['--review', 'checked', '--goal', 'met', '--summary', 'scope run complete'];
  const STRAY = ['--out-of-scope', 'stray.md=generated by the tool'];

  record(['unit', 'init', 'docs/plan.md']);
  check('unit init snapshots the paths already dirty when the run begins',
    progress().preexisting.slice().sort().join() === 'preexist.txt,top.txt', JSON.stringify(progress().preexisting));
  record(['unit', 'start', 'U1']);
  fs.writeFileSync(path.join(zone, 'plugin', 'new.cjs'), 'ok\n');
  const inScope = record(['unit', 'verified', 'U1', '--evidence', 'in-scope file only']);
  check('verified passes when every change is inside the write-scope (pre-run dirt excepted)',
    inScope.status === 0 && progress().units.U1.status === 'verified', inScope.stderr);
  check('a clean verified row carries no out_of_scope field',
    rows('unit-verified').length === 1 && !('out_of_scope' in rows('unit-verified')[0]));

  record(['unit', 'start', 'U2']);
  fs.writeFileSync(path.join(zone, 'stray.md'), 'made through the shell\n');
  const refused = record(['unit', 'verified', 'U2', '--evidence', 'x']);
  check('verified refuses an undeclared untracked file outside the write-scope',
    refused.status !== 0 && /working-tree\s+stray\.md/.test(refused.stderr) &&
    /--out-of-scope/.test(refused.stderr) && progress().units.U2.status === 'running', refused.stderr);
  check('a refused verified writes no ledger row and no history entry',
    rows('unit-verified').length === 1 && progress().units.U2.history.length === 1);
  const failedRun = record(['unit', 'failed', 'U2', '--evidence', 'oracle red']);
  check('failed is not gated by the scope check',
    failedRun.status === 0 && progress().units.U2.status === 'failed', failedRun.stderr);
  const declared = record(['unit', 'verified', 'U2', '--evidence', 'x', ...STRAY]);
  const declRow = rows('unit-verified')[1];
  check('verified passes with the file declared and records the declaration',
    declared.status === 0 && progress().units.U2.status === 'verified' && !!declRow &&
    declRow.out_of_scope_count === 1 && declRow.out_of_scope[0].path === 'stray.md' &&
    declRow.out_of_scope[0].reason === 'generated by the tool' &&
    progress().units.U2.history.slice(-1)[0].out_of_scope[0].path === 'stray.md',
    (declared.stderr || '') + JSON.stringify(declRow));

  // done: a tracked file outside the scope modified through the shell, then reverted
  runHook('S0', { session_id: 's2-test', cwd: zone, model: 'scope-model' }, home);
  register(zone, home, 's2-test');
  fs.appendFileSync(path.join(zone, 'other.txt'), 'shell edit\n');
  const modRefused = done(zone, home, [...SCOPE_DONE, ...STRAY]);
  check('done refuses an undeclared modified tracked file outside the write-scope',
    modRefused.status !== 0 && /working-tree\s+other\.txt/.test(modRefused.stderr) &&
    !/stray\.md/.test(modRefused.stderr) && !signalExists(zone), modRefused.stderr);
  git('checkout', '--', 'other.txt');
  const reverted = done(zone, home, [...SCOPE_DONE, ...STRAY]);
  check('done passes once the out-of-scope edit is reverted', reverted.status === 0 && signalExists(zone), reverted.stderr);
  fs.unlinkSync(signalPath(zone));
  // a commit since the baseline that touches an out-of-scope file
  fs.appendFileSync(path.join(zone, 'other.txt'), 'committed edit\n');
  git('add', 'other.txt');
  git('commit', '-q', '-m', 'work');
  const commitRefused = done(zone, home, [...SCOPE_DONE, ...STRAY]);
  check('done refuses an undeclared out-of-scope change committed since the contract commit',
    commitRefused.status !== 0 && /committed\s+other\.txt/.test(commitRefused.stderr) &&
    commitRefused.stderr.includes('baseline ' + baseline.slice(0, 7)) && !signalExists(zone), commitRefused.stderr);
  // the contract file itself is never compared; a glob declaration is accepted
  fs.appendFileSync(path.join(zone, 'test-boundary.md'), '\n<!-- note -->\n');
  const declaredDone = done(zone, home, [...SCOPE_DONE, '--out-of-scope', '*.md=generated by the tool',
    '--out-of-scope', 'other.txt=hotfix agreed in chat']);
  const signal = signalExists(zone) ? JSON.parse(fs.readFileSync(signalPath(zone), 'utf8')) : null;
  check('done passes with every out-of-scope file declared and ignores the contract file',
    declaredDone.status === 0 && !!signal && signal.out_of_scope_count === 2 &&
    signal.out_of_scope.map((o) => o.path).sort().join() === 'other.txt,stray.md',
    (declaredDone.stderr || '') + JSON.stringify(signal));
  const pass = runHook('S2', stopEvent(zone, 'report'), home).out;
  const doneRow = ledger(home).find((r) => r.trigger === 'done-declaration');
  check('S2 copies the declared out-of-scope files into the done-declaration row',
    pass === null && !!doneRow && doneRow.gate === 'passed' && doneRow.out_of_scope_count === 2 &&
    doneRow.out_of_scope.some((o) => o.path === 'other.txt' && /hotfix/.test(o.reason)), JSON.stringify(doneRow));

  // no git: fail closed
  const nogit = path.join(BASE, 'nogit');
  fs.mkdirSync(path.join(nogit, '.amber'), { recursive: true });
  fs.writeFileSync(path.join(nogit, 'test-boundary.md'), SCOPE_BOUNDARY);
  fs.writeFileSync(path.join(nogit, '.amber', 'active.json'), JSON.stringify(
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-16' }));
  fs.writeFileSync(path.join(nogit, '.amber', 'progress.json'),
    JSON.stringify({ v: 1, contract: 'test-boundary.md', plan: 'plan.md', units: {} }));
  const nogitDone = done(nogit, home, SCOPE_DONE);
  check('done refuses when the zone is not a git repository',
    nogitDone.status !== 0 && /not inside a git repository/.test(nogitDone.stderr) &&
    !fs.existsSync(path.join(nogit, '.amber', 'done.json')), nogitDone.stderr);
  // no contract: the declaration flag is refused like --goal
  const plainDecl = done(zoneEmpty, home, ['--review', 'r', '--summary', 's', '--out-of-scope', 'x=y']);
  check('done refuses --out-of-scope without a contract',
    plainDecl.status !== 0 && /omit --out-of-scope/.test(plainDecl.stderr), plainDecl.stderr);
}

// ---- CLAUDE_CODE_SESSION_ID attribution: the Claude Code tool shell carries the hooks' session id ----
{
  const PLAN = [
    '## Work units',
    '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]',
    '- [ ] U2 two [unit: U2 scope=docs/*.md oracle=true]',
  ].join('\n');
  const zone = makeZone('ccattr', BOUNDARY,
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-17' });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const home = freshHome('ccattr');
  // Only CLAUDE_CODE_SESSION_ID is set; the other ids are blanked whatever the
  // runner's own environment carries.
  const cc = (args, extraEnv) => spawnSync('node', [RECORD_CLI, ...args], {
    cwd: zone, encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, {
      AMBER_HOME: home, AMBER_SESSION_ID: '', CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: 'cc-sess',
    }, extraEnv || {}),
  });
  const lastRow = () => ledger(home).slice(-1)[0] || {};
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'session-cc-sess.json'), JSON.stringify({ model: 'm-cc' }));
  const init = cc(['unit', 'init', 'docs/plan.md']);
  check('a unit init row takes CLAUDE_CODE_SESSION_ID',
    init.status === 0 && lastRow().trigger === 'unit-init' && lastRow().session_id === 'cc-sess',
    (init.stderr || '') + JSON.stringify(lastRow()));
  const start = cc(['unit', 'start', 'U1']);
  check('a unit start row takes CLAUDE_CODE_SESSION_ID and the model of that session state',
    start.status === 0 && lastRow().trigger === 'unit-start' && lastRow().session_id === 'cc-sess' &&
    lastRow().model === 'm-cc', (start.stderr || '') + JSON.stringify(lastRow()));
  const env = cc(['unit', 'start', 'U2'], { AMBER_SESSION_ID: 'env-id' });
  check('AMBER_SESSION_ID wins over CLAUDE_CODE_SESSION_ID',
    env.status === 0 && lastRow().session_id === 'env-id', (env.stderr || '') + JSON.stringify(lastRow()));
}

// ---- S1: typed init sensor ----
{
  const home = freshHome('s1init');
  runHook('S0', { session_id: 's1-init', cwd: zoneEmpty, model: 'claude-fable-5' }, home);
  const typed = (prompt) => runHook('S1', { session_id: 's1-init', cwd: zoneEmpty, prompt }, home);
  typed('/amber:init some args');
  let recs = ledger(home);
  check('S1 records a typed /amber:init as a bare skill-invocation row',
    recs.length === 1 && recs[0].trigger === 'skill-invocation' &&
    recs[0].summary === 'amber:init (typed)' && recs[0].model === 'claude-fable-5', JSON.stringify(recs));
  typed('$amber:init');
  recs = ledger(home);
  check('S1 records the $ form of a typed init the same way',
    recs.length === 2 && recs[1].trigger === 'skill-invocation' && recs[1].summary === 'amber:init (typed)',
    JSON.stringify(recs));
  typed('/amber:status');
  typed('/amber:initx');
  typed('please /amber:init later');
  check('S1 records neither a typed status nor a near-miss init', ledger(home).length === 2,
    JSON.stringify(ledger(home)));
  const res = typed('/amber:planning x');
  recs = ledger(home);
  check('S1 still records a typed planning as a planning-invocation row',
    res.exit === 0 && res.out === null && recs.length === 3 && recs[2].trigger === 'planning-invocation' &&
    recs[2].summary === '/amber:planning x', JSON.stringify(recs));
}

// ---- S1: typed audit sensor ----
{
  const home = freshHome('s1audit');
  runHook('S0', { session_id: 's1-audit', cwd: zoneEmpty, model: 'claude-fable-5' }, home);
  const typed = (prompt) => runHook('S1', { session_id: 's1-audit', cwd: zoneEmpty, prompt }, home);
  typed('/amber:audit exclude=amber');
  let recs = ledger(home);
  check('S1 records a typed /amber:audit as a bare skill-invocation row without its arguments',
    recs.length === 1 && recs[0].trigger === 'skill-invocation' &&
    recs[0].summary === 'amber:audit (typed)' && recs[0].model === 'claude-fable-5', JSON.stringify(recs));
  typed('$amber:audit');
  recs = ledger(home);
  check('S1 records the $ form of a typed audit the same way',
    recs.length === 2 && recs[1].trigger === 'skill-invocation' && recs[1].summary === 'amber:audit (typed)',
    JSON.stringify(recs));
  typed('/amber:status');
  typed('/amber:auditx');
  typed('please /amber:audit later');
  check('S1 records neither a typed status nor a near-miss audit', ledger(home).length === 2,
    JSON.stringify(ledger(home)));
  const res = typed('/amber:planning x');
  recs = ledger(home);
  check('S1 still records a typed planning as a planning-invocation row next to the audit sensor',
    res.exit === 0 && res.out === null && recs.length === 3 && recs[2].trigger === 'planning-invocation' &&
    recs[2].summary === '/amber:planning x', JSON.stringify(recs));
}

// ---- external hold: a reason starting with external: stands until the unit's next transition ----
{
  const PLAN = [
    '## Work units',
    '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]',
    '- [ ] U2 two [unit: U2 scope=docs/*.md oracle=true]',
  ].join('\n');
  const zone = makeZone('exthold', BOUNDARY,
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-17' });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const home = freshHome('exthold');
  const progressFile = path.join(zone, '.amber', 'progress.json');
  const progress = () => JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  const record = (args) => spawnSync('node', [RECORD_CLI, ...args], {
    cwd: zone, encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, { AMBER_HOME: home, AMBER_SESSION_ID: 'ext-shell' }),
  });
  const holds = () => ledger(home).filter((r) => r.trigger === 'unit-hold');
  const stop = () => runHook('S2', { session_id: 'drv-ext', cwd: zone, hook_event_name: 'Stop',
    stop_hook_active: false, last_assistant_message: 'waiting' }, home).out;
  const { holdKind } = require('../hooks/progress.cjs');
  check('holdKind classifies external: case-insensitively with leading whitespace',
    holdKind('external: sweep') === 'external' && holdKind('  EXTERNAL: x') === 'external' &&
    holdKind('externally slow') === null && holdKind('waiting on the operator') === null && holdKind('') === null);
  record(['unit', 'init', 'docs/plan.md']);
  record(['unit', 'start', 'U1']);
  runHook('S0', { session_id: 'drv-ext', cwd: zone, model: 'm' }, home);
  register(zone, home, 'drv-ext');
  const s3 = runHook('S3', {
    session_id: 'drv-ext', cwd: zone, hook_event_name: 'PreToolUse', tool_name: 'Skill',
    tool_input: { skill: 'amber:mark', args: 'hold - U1 - external: waiting on the sweep' },
  }, home).out;
  check('mark hold with an external: reason stores kind external in progress.json',
    s3 === null && !!progress().hold && progress().hold.kind === 'external' && progress().hold.unit === 'U1' &&
    /waiting on the sweep/.test(progress().hold.reason), JSON.stringify(progress().hold));
  check('the mark path puts kind external on the unit-hold ledger row',
    holds().length === 1 && holds()[0].kind === 'external' && holds()[0].unit === 'U1', JSON.stringify(holds()));
  const first = stop();
  const second = stop();
  check('an external hold lets every stop of the driving session through and persists',
    first === null && second === null && !!progress().hold && progress().hold.kind === 'external' &&
    progress().units.U1.reentries === 0, JSON.stringify([first, second, progress().hold]));
  const brief = runHook('S0', { session_id: 'brief-ext', cwd: zone, model: 'm' }, home).out;
  const bctx = brief && brief.hookSpecificOutput && brief.hookSpecificOutput.additionalContext;
  check('the S0 briefing names the external hold with its unit, timestamp, and text',
    !!bctx && /external hold on U1 since \S+: external: waiting on the sweep/.test(bctx) &&
    /hold: U1 - external since \S+ - external: waiting on the sweep/.test(bctx), String(bctx).slice(-700));
  const ver = record(['unit', 'verified', 'U1', '--evidence', 'sweep finished']);
  check('verified on the held unit releases the external hold',
    ver.status === 0 && progress().hold === null, (ver.stderr || '') + JSON.stringify(progress().hold));
  const blocked = stop();
  check('a plain stop with open units is blocked again once the external hold is gone',
    !!(blocked && blocked.decision === 'block') && /U2/.test(blocked.reason), JSON.stringify(blocked));
  const shell = record(['unit', 'hold', 'U2', '--reason', 'external: long test']);
  check('record.cjs unit hold with an external: reason yields kind external in progress and ledger',
    shell.status === 0 && progress().hold.kind === 'external' && progress().hold.unit === 'U2' &&
    holds().length === 2 && holds()[1].kind === 'external', (shell.stderr || '') + JSON.stringify(holds()));
  const third = stop();
  check('the shell-recorded external hold passes a stop and persists too',
    third === null && !!progress().hold && progress().hold.kind === 'external', JSON.stringify(progress().hold));
  const plain = record(['unit', 'hold', 'U2', '--reason', 'waiting on operator']);
  check('a plain hold recorded after an external one replaces it (no kind)',
    plain.status === 0 && !!progress().hold && !('kind' in progress().hold) &&
    /operator/.test(progress().hold.reason) && holds().length === 3 && !('kind' in holds()[2]),
    JSON.stringify(progress().hold));
  const once = stop();
  const again = stop();
  check('a plain hold passes exactly one stop', once === null && !!(again && again.decision === 'block'),
    JSON.stringify([once, again]));
  record(['unit', 'hold', 'U2', '--reason', 'External: mixed case']);
  const startHeld = record(['unit', 'start', 'U2']);
  check('start on the held unit releases the external hold too',
    startHeld.status === 0 && progress().hold === null, (startHeld.stderr || '') + JSON.stringify(progress().hold));
  record(['unit', 'hold', 'U2', '--reason', 'external: other unit moves']);
  record(['unit', 'failed', 'U1', '--evidence', 'reopened']);
  check('a transition on another unit leaves the external hold standing',
    !!progress().hold && progress().hold.kind === 'external', JSON.stringify(progress().hold));
  const failHeld = record(['unit', 'failed', 'U2', '--evidence', 'the job failed']);
  check('failed on the held unit releases the external hold too',
    failHeld.status === 0 && progress().hold === null, JSON.stringify(progress().hold));
}

// ---- waiting-signal briefing: S0/S1 tell a non-driving session that a completion signal waits ----
{
  const PLAN = ['## Work units', '- [ ] U1 one [unit: U1 scope=plugin/** oracle=true]'].join('\n');
  const zone = makeZone('waitsig', BOUNDARY,
    { v: 1, boundary: 'test-boundary.md', ratified_by: 'operator', ratified_at: '2026-09-17' });
  fs.mkdirSync(path.join(zone, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(zone, 'docs', 'plan.md'), PLAN);
  const home = freshHome('waitsig');
  spawnSync('node', [RECORD_CLI, 'unit', 'init', 'docs/plan.md'], {
    cwd: zone, encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, { AMBER_HOME: home, AMBER_SESSION_ID: 'wait-shell' }),
  });
  const ctxOf = (event, id) => {
    const out = runHook(event, { session_id: id, cwd: zone, model: 'm', prompt: 'hello' }, home).out;
    return out && out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext : null;
  };
  for (const id of ['drv', 'talk']) runHook('S0', { session_id: id, cwd: zone, model: 'm' }, home);
  register(zone, home, 'drv');
  check('no waiting line before a signal exists',
    !/completion signal is waiting/.test(String(ctxOf('S0', 'talk'))));
  plantSignal(zone, { summary: 'left by the driver' });
  const s0talk = ctxOf('S0', 'talk');
  check('S0 tells a non-driving session that a completion signal is waiting',
    !!s0talk && /completion signal is waiting/.test(s0talk) && /take the run over/.test(s0talk),
    String(s0talk).slice(-400));
  const s1talk = ctxOf('S1', 'talk');
  check('S1 delivers the waiting line to an already briefed non-driving session',
    !!s1talk && /completion signal is waiting/.test(s1talk) && !/an active contract governs/.test(s1talk),
    String(s1talk));
  const s1new = ctxOf('S1', 'talk2');
  check('S1 briefing for an unbriefed non-driving session carries the waiting line with the briefing',
    !!s1new && /completion signal is waiting/.test(s1new) && /an active contract governs/.test(s1new),
    String(s1new).slice(-400));
  const s0drv = ctxOf('S0', 'drv');
  check('S0 for the driving session carries no waiting line',
    !!s0drv && !/completion signal is waiting/.test(s0drv) && /this session drives the run/.test(s0drv),
    String(s0drv).slice(-400));
  check('the briefing never consumes the signal or records a row',
    signalExists(zone) && ledger(home).every((r) => r.trigger !== 'done-declaration'));
  fs.unlinkSync(signalPath(zone));
  check('the waiting line disappears with the signal', ctxOf('S1', 'talk') === null);
}

// ---- hook crash breadcrumb: malformed input fails open and is logged ----
{
  const home = freshHome('crash');
  const res = spawnSync('node', [HOOK, 'S1'], {
    input: '{not json', env: Object.assign({}, process.env, { AMBER_HOME: home }),
    encoding: 'utf8', timeout: 10000,
  });
  const log = path.join(home, 'state', 'sensor-failures.log');
  check('a hook crash exits 0 with no output',
    res.status === 0 && (res.stdout || '').trim() === '', JSON.stringify([res.status, res.stdout]));
  check('a hook crash leaves a breadcrumb naming the event',
    fs.existsSync(log) && /hook-crash event=S1/.test(fs.readFileSync(log, 'utf8')),
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'no log');
}

console.log('---');
console.log(passed + ' passed, ' + failed + ' failed (' + (passed + failed) + ' total)');
fs.rmSync(BASE, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
