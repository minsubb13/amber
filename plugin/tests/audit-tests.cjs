#!/usr/bin/env node
// Tests of the read-only audit helper against the synthetic fixture in
// fixtures/audit (a ledger with projects alpha, beta and self, and two
// Claude Code transcripts of alpha sessions). Every expected number below
// is hand-counted from the fixture files, not copied from the helper.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');

const PLUGIN = path.resolve(__dirname, '..');
const SCRIPT = path.join(PLUGIN, 'scripts', 'audit.cjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'audit');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-audit-test-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const PERIOD = '2026-09-12T00:00:00.000Z';
const LOSS = 'a1b2c3d4';       // alpha session with an opening verdict text and no skip row
const RECORDED = 'e5f6a7b8';   // alpha session whose opening verdict was recorded through mark
const CODEX_ID = 'c0dec001-0000-4000-8000-000000000001';

function fixture() {
  const base = fs.mkdtempSync(path.join(BASE, 'case-'));
  const home = path.join(base, 'amber-home');
  const transcripts = path.join(base, 'transcripts');
  fs.mkdirSync(home);
  fs.copyFileSync(path.join(FIXTURE, 'ledger.jsonl'), path.join(home, 'runs.jsonl'));
  fs.cpSync(path.join(FIXTURE, 'transcripts'), transcripts, { recursive: true });
  return { base, home, transcripts };
}
function run(f, args, overrides = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: f.base, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, AMBER_HOME: f.home, AMBER_TRANSCRIPTS: f.transcripts, ...overrides },
  });
}
const lines = (r) => r.stdout.replace(/\n$/, '').split('\n');

function codexFixture() {
  const f = fixture();
  fs.copyFileSync(path.join(FIXTURE,'codex','ledger.jsonl'),path.join(f.home,'runs.jsonl'));
  fs.cpSync(path.join(FIXTURE,'codex','transcripts'),f.transcripts,{recursive:true});
  f.codexFile = path.join(f.transcripts,'2026','09','21','rollout-2026-09-21T12-00-00-' + CODEX_ID + '.jsonl');
  return f;
}

test('Codex audit: actual code-mode execution events, direct fallback and duplicated UI events', () => {
  const f = codexFixture();
  const before = snapshot(f.base);
  const r = run(f,['session',CODEX_ID]);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/summary: events=8 matched=4 matched_unattributed=1 refused=1 mentions=1 missing=1 orphan_rows=1/);
  assert.match(r.stdout,/verdict-text -> skip: MISSING/);
  assert.match(r.stdout,/typed amber:audit -> skill-invocation: matched/);
  assert.match(r.stdout,/stop hook summaries: unknown/);
  assert.match(r.stdout,/loop send-backs .*: 1 at L15/);
  assert.doesNotMatch(r.stdout,/opening verdict: no contract for this fixture/, 'no transcript body disclosure');
  assert.deepEqual(snapshot(f.base),before);
  assert.equal(run(f,['check-session',CODEX_ID]).status,0,'planted skip loss detected');
  assert.match(run(f,['sessions']).stdout,new RegExp('session=' + CODEX_ID + ' .*transcript=yes'));
});

test('Codex audit: default CODEX_HOME discovery and explicit transcript root isolation', () => {
  const f = codexFixture();
  const codexHome=path.join(f.base,'codex-home');
  fs.cpSync(path.join(FIXTURE,'codex','transcripts'),path.join(codexHome,'sessions'),{recursive:true});
  const found=run(f,['session',CODEX_ID],{AMBER_TRANSCRIPTS:'',CODEX_HOME:codexHome});
  assert.equal(found.status,0,found.stderr);
  const isolated=run(f,['session',CODEX_ID],{AMBER_TRANSCRIPTS:path.join(f.base,'absent'),CODEX_HOME:codexHome});
  assert.equal(isolated.status,1,'explicit root must not fall back to real user transcripts');
});

test('Codex audit: absent outcomes and malformed records remain visibly unknown', () => {
  const f=codexFixture();
  fs.appendFileSync(f.codexFile, JSON.stringify({timestamp:'2026-09-21T03:01:00Z',type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'missing',arguments:JSON.stringify({cmd:'node /fixture/record.cjs unit failed U1 --evidence fixture'})}})+'\n{broken\n');
  const r=run(f,['session',CODEX_ID]);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/unobservable \(command outcome absent or ambiguous\)/);
  assert.match(r.stdout,/transcript coverage: 1 malformed line/);
});

test('Codex audit: duplicate rollouts require an unambiguous source', () => {
  const f=codexFixture();
  fs.copyFileSync(f.codexFile,path.join(f.transcripts,'rollout-copy-' + CODEX_ID + '.jsonl'));
  const r=run(f,['session',CODEX_ID]);
  assert.equal(r.status,1);
  assert.match(r.stderr,/2 candidates/);
});

test('Codex audit: same contract events classify like Claude events', () => {
  const f=codexFixture();
  fs.writeFileSync(f.codexFile,[
    {type:'session_meta',payload:{id:CODEX_ID,cwd:'/fixture/codex'}},
    {timestamp:'2026-09-21T03:00:01Z',type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',id:'i',command:['sh','-c','node /fixture/record.cjs invoke planning'],aggregated_output:'amber: recorded invoke planning\n'}}},
    {timestamp:'2026-09-21T03:00:02Z',type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',id:'s',command:['sh','-c','node /fixture/record.cjs mark skip "opening verdict - no contract"'],aggregated_output:'amber: recorded mark skip\n'}}},
  ].map(JSON.stringify).join('\n')+'\n');
  const ledgerRows=[['skill-invocation','amber:planning'],['skip','opening verdict - no contract']].map(([trigger,summary],i)=>({session_id:CODEX_ID,ts:'2026-09-21T03:00:0'+(i+1)+'.000Z',trigger,summary,cwd:'/fixture/codex'}));
  fs.writeFileSync(path.join(f.home,'runs.jsonl'),ledgerRows.map(JSON.stringify).join('\n')+'\n');
  const codex=run(f,['session',CODEX_ID]);
  const claude=run(fixture(),['session',RECORDED,'--period-end',PERIOD]);
  assert.equal(codex.status,0,codex.stderr);
  assert.equal(lines(codex).at(-1),lines(claude).at(-1));
  assert.equal(run(f,['check-session',CODEX_ID]).status,1,'recorded skip is not a loss');
});

// Hand-counted from fixtures/audit/ledger.jsonl at PERIOD without project
// self: 25 rows in the file, 2 after the period end (one alpha, one beta),
// 3 rows of self; 20 field rows over sessions A (6), A2 (2), B (11) and
// one shell row.
const SUMMARY = [
  'period_end=' + PERIOD,
  'excluded_projects=self',
  'ledger_rows=23 malformed=0 field_rows=20',
  'by_project: alpha=9 beta=11',
  'by_trigger: done-declaration=4 finding=1 skill-invocation=5 skip=1 unit-claim=1 unit-hold=2 unit-init=2 unit-start=1 unit-verified=3',
  'by_model: claude-fable-5-1=8 claude-opus-5[1m]=11 unknown=1',
  'model_unknown_by_trigger: unit-verified=1',
  'by_plugin_version: 0.18.2=1 0.23.0=19',
  'skill_invocations: amber:init=1 amber:planning=3 amber:set=1',
  'skips: opening verdict=1',
  'done: with_contract=3 without_contract=1 with_review=3 with_goal=3',
  'gate: none=1 passed=3',
  'completions_distinct_contracts=3',
  'completions: 2026-09-10-alpha-contract.md 2026-09-11-beta-contract.md 2026-09-11-beta-two-contract.md',
  'unit_events: claim=1 hold=2 init=2 start=1 verified=3',
  'unit_rows_attributed: session=8 shell=1',
  'out_of_scope_declarations=1',
  'sessions_distinct=4',
];

test('summary: exact lines at a fixed period end without project self', () => {
  const r = run(fixture(), ['summary', '--period-end', PERIOD, '--exclude', 'self']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r), SUMMARY);
});
test('summary: options parse anywhere and the period end is printed as a millisecond instant', () => {
  const r = run(fixture(), ['--exclude', 'self', 'summary', '--period-end', '2026-09-12T00:00:00Z']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r), SUMMARY);
});
test('summary: a later period end counts the rows after the cut', () => {
  const r = run(fixture(), ['summary', '--period-end', '2026-09-14T00:00:00.000Z', '--exclude', 'self']);
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r);
  assert.equal(out[2], 'ledger_rows=25 malformed=0 field_rows=22');
  assert.equal(out[3], 'by_project: alpha=10 beta=12');
  assert.equal(out[8], 'skill_invocations: amber:init=1 amber:planning=3 amber:set=1 amber:status=1');
  assert.equal(out[9], 'skips: opening verdict=2');
  assert.equal(out[17], 'sessions_distinct=4');
});
test('summary: no exclusion keeps every project, two exclusions are listed sorted', () => {
  const f = fixture();
  const none = run(f, ['summary', '--period-end', PERIOD]);
  assert.equal(none.status, 0, none.stderr);
  const out = lines(none);
  assert.equal(out[1], 'excluded_projects=none');
  assert.equal(out[2], 'ledger_rows=23 malformed=0 field_rows=23');
  assert.equal(out[3], 'by_project: alpha=9 beta=11 self=3');
  assert.equal(out[17], 'sessions_distinct=5');
  const two = run(f, ['summary', '--period-end', PERIOD, '--exclude', 'self', '--exclude', 'beta']);
  assert.equal(two.status, 0, two.stderr);
  assert.equal(lines(two)[1], 'excluded_projects=beta,self');
  assert.equal(lines(two)[2], 'ledger_rows=23 malformed=0 field_rows=9');
  assert.equal(lines(two)[3], 'by_project: alpha=9');
});
test('missing ledger: every command reports zero rows and exits 0', () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.home, 'runs.jsonl'));
  const summary = run(f, ['summary', '--period-end', PERIOD]);
  assert.equal(summary.status, 0, summary.stderr);
  assert.equal(lines(summary)[2], 'ledger_rows=0 malformed=0 field_rows=0');
  assert.equal(lines(summary)[3], 'by_project: ');
  assert.equal(lines(summary)[17], 'sessions_distinct=0');
  const dead = run(f, ['dead']);
  assert.equal(dead.status, 0, dead.stderr);
  assert.match(dead.stdout, /^amber:planning \(Skill tool\) \| 0 \| DEAD \(0 in field\)$/m);
  const sessions = run(f, ['sessions']);
  assert.equal(sessions.status, 0, sessions.stderr);
  assert.equal(sessions.stdout, '');
  const session = run(f, ['session', LOSS]);
  assert.equal(session.status, 0, session.stderr);
  assert.equal(lines(session)[1], 'ledger rows for session (<= period_end): 0 []');
  assert.equal(lines(session).at(-1), 'summary: events=10 matched=0 matched_unattributed=0 refused=1 mentions=1 missing=7 orphan_rows=0');
  assert.equal(fs.existsSync(path.join(f.home, 'runs.jsonl')), false, 'the helper must not create the ledger');
});

test('dead: one row per skill directory, DEAD and unrecorded rows, no line references, no fixed marks', () => {
  const r = run(fixture(), ['dead', '--period-end', PERIOD, '--exclude', 'self']);
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r);
  assert.equal(out[0], 'period_end=' + PERIOD);
  assert.equal(out[1], 'excluded_projects=self');
  assert.equal(out[2], 'mechanism | field_count | status');
  // The expected skill rows come from the plugin's own directory at test
  // time, so a skill added later (audit) is covered without a literal here.
  const skills = fs.readdirSync(path.join(PLUGIN, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(skills.includes('planning') && skills.includes('mark'), 'plugin skills: ' + skills);
  for (const name of skills) {
    assert.ok(out.some((l) => l.startsWith('amber:' + name + ' (Skill tool')), 'row for skill ' + name + ' expected:\n' + r.stdout);
  }
  assert.ok(out.includes('amber:planning (Skill tool) | 3 | live'));
  assert.ok(out.includes('amber:set (Skill tool) | 1 | live'));
  assert.ok(out.includes('amber:mark (Skill tool: skip, finding and hold rows) | 4 | live'));
  // Typed rows are their own mechanism, so the Skill-tool row of init stays 0.
  assert.ok(out.includes('amber:init (Skill tool) | 0 | DEAD (0 in field)'));
  assert.ok(out.includes('S1 typed /amber:init (skill-invocation "amber:init (typed)") | 1 | live'));
  assert.ok(out.includes('S1 typed /amber:audit (skill-invocation "amber:audit (typed)") | 0 | DEAD (0 in field)'));
  assert.ok(out.includes('S1 typed /amber:planning (planning-invocation) | 0 | DEAD (0 in field)'));
  assert.ok(out.includes('mark hold (unit-hold) | 2 | live'));
  assert.ok(out.includes('hold plain (unit-hold without kind; one stop passes) | 1 | live'));
  assert.ok(out.includes('hold external (unit-hold kind=external; every stop passes until the next transition) | 1 | live'));
  assert.ok(out.includes('unit claim (subagent claim observed by E1, unit-claim) | 1 | live'));
  assert.ok(out.includes('unit failed | 0 | DEAD (0 in field)'));
  assert.ok(out.includes('unit limit (ten re-entries on one unit) | 0 | DEAD (0 in field)'));
  assert.ok(out.includes('out-of-scope declaration at verified/done | 1 | live'));
  assert.ok(out.includes('gate passed | 3 | live'));
  assert.ok(out.includes('sensor failure breadcrumb (state/sensor-failures.log) | 0 | DEAD (0 in field)'));
  for (const name of ['E1 deny', 'S2 continuation send-back', 'hold consumed by S2', 'operator-typed /amber:status', 'S0 briefing']) {
    assert.ok(out.some((l) => l.startsWith(name) && / \| - \| unrecorded \(by design/.test(l)), 'unrecorded row for ' + name + ' expected:\n' + r.stdout);
  }
  assert.doesNotMatch(r.stdout, /amber-hook\.cjs:\d+/, 'no file:line references');
  assert.doesNotMatch(r.stdout, /not removable|removable/, 'no fixed-mechanism marks');
  for (const l of out.slice(3)) assert.match(l, /^.+ \| (\d+|-|file present) \| (live|DEAD \(0 in field\)|unrecorded \(by design: [^)]*\))$/, l);
});
test('dead: the period end applies to the mechanism counts too', () => {
  const r = run(fixture(), ['dead', '--period-end', '2026-09-14T00:00:00.000Z', '--exclude', 'self']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lines(r).includes('amber:status (Skill tool) | 1 | live'));
  assert.ok(lines(r).includes('mark skip: opening verdict - no contract | 2 | live'));
});

const SESSIONS = [
  'session=b2c3d4e5-0000-4000-8000-000000000003 project=beta first=2026-09-11T11:00:00.000Z last=2026-09-11T12:30:00.000Z rows=11 completions=2 transcript=no',
  'session=e5f6a7b8-0000-4000-8000-000000000002 project=alpha first=2026-09-11T08:59:00.200Z last=2026-09-11T09:00:00.300Z rows=2 completions=0 transcript=yes',
  'session=a1b2c3d4-0000-4000-8000-000000000001 project=alpha first=2026-09-10T09:30:05.000Z last=2026-09-10T10:25:30.000Z rows=6 completions=1 transcript=yes',
];
test('sessions: newest first, completions and transcript presence, shell rows skipped', () => {
  const f = fixture();
  const r = run(f, ['sessions', '--period-end', PERIOD, '--exclude', 'self']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r), SESSIONS);
  const all = run(f, ['sessions', '--period-end', PERIOD]);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(lines(all), [...SESSIONS,
    'session=c3d4e5f6-0000-4000-8000-000000000004 project=self first=2026-09-09T09:00:00.000Z last=2026-09-09T09:30:00.000Z rows=3 completions=0 transcript=no']);
  const one = run(f, ['sessions', '1', '--period-end', PERIOD, '--exclude', 'self']);
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(lines(one), [SESSIONS[0]]);
});
test('sessions: a missing transcript root means transcript=no everywhere', () => {
  const f = fixture();
  const r = run(f, ['sessions', '--period-end', PERIOD, '--exclude', 'self'], { AMBER_TRANSCRIPTS: path.join(f.base, 'nowhere') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r), SESSIONS.map((l) => l.replace(/transcript=yes$/, 'transcript=no')));
});

// Hand-read from the a1b2c3d4 transcript: 23 lines (24 after the trailing
// newline split), 10 user and 10 assistant lines outside the sidechain,
// one stop summary, one re-entry directive (L13), and these events.
const SESSION_A = [
  'ledger rows for session (<= period_end): 6 [done-declaration=2 finding=1 skill-invocation=1 unit-init=1 unit-start=1]',
  'transcript events -> ledger:',
  '  L2 2026-09-10T09:30:00 marker AMBER_REVIEW -> -: n/a (no row by design)',
  '  L2 2026-09-10T09:30:00 marker AMBER_DONE -> done-declaration: matched (row 09:30:05, +5s)',
  '  L4 2026-09-10T10:00:00 skill amber:planning -> skill-invocation: matched (row 10:00:00, +0s)',
  '  L6 2026-09-10T10:00:30 verdict-text -> skip: MISSING',
  '  L7 2026-09-10T10:05:00 cmd done -> done-declaration: not an invocation (command text only mentions record.cjs)',
  '  L9 2026-09-10T10:10:00 cmd unit init -> unit-init: matched (row 10:10:01, +1s)',
  '  L11 2026-09-10T10:11:00 cmd unit start -> unit-start: matched (row 10:11:01, +1s)',
  '  L14 2026-09-10T10:20:00 cmd unit verified -> unit-verified: matched-unattributed (row says session "shell") (row 10:20:01, +1s)',
  '  L16 2026-09-10T10:24:00 cmd done -> done-declaration: refused by the command (no row by design)',
  '  L18 2026-09-10T10:25:00 cmd done -> done-declaration: matched (row 10:25:30, +30s)',
  'ledger rows with no transcript event: 1',
  '  row 2026-09-10T10:22:00 finding exporter wrote CRLF on one row - fixed and re-verified',
  'stop hook summaries: 1 [stop=1]',
  'loop send-backs (re-entry directives injected as user lines): 1 at L13',
  'summary: events=10 matched=5 matched_unattributed=1 refused=1 mentions=1 missing=1 orphan_rows=1',
];
test('session: every planted event of the loss session is classified as expected', () => {
  const f = fixture();
  const r = run(f, ['session', LOSS, '--period-end', PERIOD, '--exclude', 'self']);
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r);
  assert.match(out[0], /^session a1b2c3d4 transcript=\S+a1b2c3d4-0000-4000-8000-000000000001\.jsonl lines=24 user_msgs=10 assistant_msgs=10$/);
  assert.deepEqual(out.slice(1), SESSION_A);
  assert.doesNotMatch(r.stdout, /L2[23] /, 'sidechain lines must be ignored');
});
test('session: the recorded session matches both events and has nothing missing', () => {
  const r = run(fixture(), ['session', RECORDED, '--period-end', PERIOD]);
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r);
  assert.equal(out[1], 'ledger rows for session (<= period_end): 2 [skill-invocation=1 skip=1]');
  assert.equal(out[3], '  L2 2026-09-11T08:59:00 skill amber:planning -> skill-invocation: matched (row 08:59:00, +0s)');
  assert.equal(out[4], '  L4 2026-09-11T09:00:00 mark skip -> skip: matched (row 09:00:00, +0s)');
  assert.equal(out.at(-1), 'summary: events=2 matched=2 matched_unattributed=0 refused=0 mentions=0 missing=0 orphan_rows=0');
});
test('session: an earlier period end hides the later rows of the session', () => {
  const r = run(fixture(), ['session', LOSS, '--period-end', '2026-09-10T10:00:00.000Z']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(r)[1], 'ledger rows for session (<= period_end): 1 [done-declaration=1]');
  assert.equal(lines(r).at(-1), 'summary: events=10 matched=1 matched_unattributed=0 refused=1 mentions=1 missing=6 orphan_rows=0');
});
test('session: a missing transcript is an error, a -tmp- directory is skipped', () => {
  const f = fixture();
  const unknown = run(f, ['session', 'ffffffff']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /transcript for ffffffff: no <id>\*\.jsonl under /);
  const noRoot = run(f, ['session', LOSS], { AMBER_TRANSCRIPTS: path.join(f.base, 'nowhere') });
  assert.equal(noRoot.status, 1);
  assert.match(noRoot.stderr, /transcript for a1b2c3d4: no/);
  fs.renameSync(path.join(f.transcripts, '-home-qa-alpha'), path.join(f.transcripts, '-tmp-home-qa-alpha'));
  const tmp = run(f, ['session', LOSS]);
  assert.equal(tmp.status, 1);
  assert.match(tmp.stderr, /transcript for a1b2c3d4: no/);
});

function report(block) {
  return '# audit fixture report\n\n## Ledger counts\n\n```\n' + block + '```\n\n## Candidates\n';
}
test('check-summary: a block written from the summary output reproduces', () => {
  const f = fixture();
  const summary = run(f, ['summary', '--period-end', PERIOD, '--exclude', 'self']);
  const file = path.join(f.base, 'report.md');
  fs.writeFileSync(file, report(summary.stdout));
  const r = run(f, ['check-summary', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'check-summary: block reproduces (18 lines, period_end ' + PERIOD + ')\n');
  assert.equal(r.stderr, '');
});
test('check-summary: the block\'s own excluded_projects line wins over the flags', () => {
  const f = fixture();
  const summary = run(f, ['summary', '--period-end', PERIOD]);
  const file = path.join(f.base, 'report.md');
  fs.writeFileSync(file, report(summary.stdout));
  const r = run(f, ['check-summary', file, '--exclude', 'self']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'check-summary: block reproduces (18 lines, period_end ' + PERIOD + ')\n');
});
test('check-summary: a tampered number fails with the line named', () => {
  const f = fixture();
  const summary = run(f, ['summary', '--period-end', PERIOD, '--exclude', 'self']);
  const file = path.join(f.base, 'report.md');
  assert.ok(summary.stdout.includes('field_rows=20'));
  fs.writeFileSync(file, report(summary.stdout.replace('field_rows=20', 'field_rows=21')));
  const r = run(f, ['check-summary', file]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'check-summary: 1 line(s) differ\n');
  assert.match(r.stderr, /^DIFF line 3\n  report: ledger_rows=23 malformed=0 field_rows=21\n  now:    ledger_rows=23 malformed=0 field_rows=20$/m);
});
test('check-summary: a block without the excluded_projects line takes the exclusions from the flags (audit-1 compatibility)', () => {
  const f = fixture();
  const summary = run(f, ['summary', '--period-end', PERIOD, '--exclude', 'self']);
  const block = lines(summary).filter((l) => !l.startsWith('excluded_projects=')).join('\n') + '\n';
  const file = path.join(f.base, 'report.md');
  fs.writeFileSync(file, report(block));
  const withFlag = run(f, ['check-summary', file, '--exclude', 'self']);
  assert.equal(withFlag.status, 0, withFlag.stderr);
  assert.equal(withFlag.stdout, 'check-summary: block reproduces (17 lines, period_end ' + PERIOD + ')\n');
  const withoutFlag = run(f, ['check-summary', file]);
  assert.equal(withoutFlag.status, 1, 'the self rows must change the numbers');
  assert.match(withoutFlag.stderr, /DIFF line 2/);
});
test('check-summary: a report without a block is an error', () => {
  const f = fixture();
  const file = path.join(f.base, 'report.md');
  fs.writeFileSync(file, '# nothing here\n');
  const r = run(f, ['check-summary', file]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no fenced block starting with period_end=/);
});

test('check-session: the planted loss is detected, a recorded verdict is not a loss', () => {
  const f = fixture();
  const loss = run(f, ['check-session', LOSS, '--period-end', PERIOD]);
  assert.equal(loss.status, 0, loss.stderr);
  assert.equal(loss.stdout, 'check-session a1b2c3d4: opening-verdict texts in transcript=1 (lines 6), skip rows in ledger=0 -> LOSS DETECTED\n');
  const recorded = run(f, ['check-session', RECORDED, '--period-end', PERIOD]);
  assert.equal(recorded.status, 1);
  assert.equal(recorded.stdout, 'check-session e5f6a7b8: opening-verdict texts in transcript=0 (lines ), skip rows in ledger=1 -> no loss\n');
  const unknown = run(f, ['check-session', 'ffffffff']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /transcript for ffffffff/);
});

test('usage: no command, unknown command, missing argument and bad options exit 2', () => {
  const f = fixture();
  for (const args of [[], ['bogus'], ['session'], ['check-summary'], ['check-session'], ['sessions', '0'], ['sessions', 'x'],
    ['summary', '--period-end', 'not-a-date'], ['summary', '--exclude'], ['summary', '--bogus']]) {
    const r = run(f, args);
    assert.equal(r.status, 2, JSON.stringify(args) + ': ' + r.stderr);
    assert.match(r.stderr, /usage: node audit\.cjs/, JSON.stringify(args));
    assert.equal(r.stdout, '');
  }
});

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
test('read-only: no fixture byte changes and no new file after every command', () => {
  const f = fixture();
  const before = { home: snapshot(f.home), transcripts: snapshot(f.transcripts) };
  const file = path.join(f.base, 'report.md');
  fs.writeFileSync(file, report(run(f, ['summary', '--period-end', PERIOD, '--exclude', 'self']).stdout));
  for (const args of [['summary'], ['dead'], ['sessions'], ['session', LOSS], ['session', RECORDED], ['check-summary', file],
    ['check-session', LOSS], ['check-session', RECORDED], ['session', 'ffffffff'], []]) {
    run(f, args);
  }
  assert.deepEqual(snapshot(f.home), before.home);
  assert.deepEqual(snapshot(f.transcripts), before.transcripts);
  assert.deepEqual(fs.readdirSync(f.home), ['runs.jsonl'], 'no state directory or other file under AMBER_HOME');
});
