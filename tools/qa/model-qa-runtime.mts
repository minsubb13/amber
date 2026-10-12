// Supplemental installed-host QA: real resume, hold lifecycle, file/Bash
// denials, post-hoc scope detection, status and init discovery. Every write
// is in a temporary fixture or its isolated AMBER_HOME; retain raw evidence.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { at, items, parseJson, textAt } from '../shared/json.mjs';

export type Host = 'claude' | 'codex';

/** A throwaway zone and its isolated AMBER_HOME. */
export interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly name: string;
  readonly kind: string;
  /** The audit scenario's copy of the fixture transcripts. */
  readonly transcripts?: string;
  /** The audit scenario's number of fixture ledger rows. */
  readonly fixtureRows?: number;
}

/** One host invocation on a fixture. */
export interface Run extends Fixture {
  readonly sessionId: string;
  readonly final: string;
  readonly cost?: unknown;
  readonly turns?: unknown;
}

export interface RunOptions {
  readonly resume?: string;
  readonly persistedTrust?: boolean;
  readonly budget?: number;
  readonly timeout?: number;
  readonly effort?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** What model-qa hands the runtime scenarios. */
export interface QaContext {
  readonly host: Host;
  readonly scenario: string;
  readonly BASE: string;
  readonly activePlugin: string;
  readonly runHost: (
    fixture: Fixture,
    prompt: string,
    options?: RunOptions,
  ) => Run;
  readonly ledger: (home: string) => unknown[];
  readonly sensorFailures: (home: string) => string;
  readonly transcriptFiles: (run: Run, includeChildren?: boolean) => string[];
}

export function toolEvidence(files: readonly string[]): string {
  const textOf = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((b: unknown) =>
              typeof b === 'string' ? b : textAt(b, 'text'),
            )
            .join('\n')
        : JSON.stringify(content);
  return files
    .flatMap((p) => readFileSync(p, 'utf8').split('\n'))
    .flatMap((line) => {
      let r: unknown;
      try {
        r = parseJson(line);
      } catch {
        return [];
      }
      const p = at(r, 'payload');
      if (
        at(r, 'type') === 'response_item' &&
        /^(custom_tool_call_output|function_call_output)$/.test(
          textAt(p, 'type'),
        )
      ) {
        return [textOf(at(p, 'output'))];
      }
      if (
        at(r, 'type') === 'event_msg' &&
        at(p, 'type') === 'item_completed' &&
        at(p, 'item', 'type') === 'CommandExecution'
      ) {
        return [
          textAt(p, 'item', 'stdout') || textAt(p, 'item', 'aggregated_output'),
        ];
      }
      const content = at(r, 'message', 'content');
      return Array.isArray(content)
        ? content
            .filter((b: unknown) => at(b, 'type') === 'tool_result')
            .map((b: unknown) => textOf(at(b, 'content')))
        : [];
    })
    .join('\n');
}

// Semantic gate of the init-empty scenario, kept pure so an oracle script can
// run negative cases against it. Each of intent.md's three slots must be
// asked as a question (a sentence that ends in '?'), the emptiness must be
// cited as a scan result (a paragraph that names the scan, the oracle map, or
// a charge, not just the prompt's own words), and the oracle map must carry an
// explicit empty row for a charge. Returns the list of failed checks.
const INIT_EMPTY_SLOTS: Readonly<Record<string, RegExp>> = {
  purpose:
    /purpose|goal|intent|why (does|should|will)|what (is|will|should) (this|the) project/i,
  oracle: /verif|oracle|test|check|prove/i,
  forbidden:
    /forbid|never|not do|out of scope|must not|off[- ]limits|won't|boundar/i,
};
// A slot question asks for the slot's value, not merely about the label.
const ASKS_FOR_VALUE =
  /\b(what|which|why|how|who|describe|name|state|tell|give|list)\b/i;
// Scan subjects the prompt does not hand the model ("no code, no document,
// no commit" is the operator's sentence): an emptiness claim counts as a
// scan result only when tied to one of these in the same sentence.
const SCAN_SUBJECT =
  /\b(tests?|test suite|test vectors?|build|ci|hooks?|files?|refs?|remote|tooling|verification|index|linter|manifests?|benchmarks?|vectors?|source|readme|package)\b/i;
const EMPTY_WORD = /\b(none|empty|nothing|absent|missing)\b/i;
const emptinessTiedToSubject = (sentence: string): boolean =>
  (EMPTY_WORD.test(sentence) || /\bno\b/i.test(sentence)) &&
  SCAN_SUBJECT.test(sentence);
// Exact assignment of slots to distinct questions (3 slots, backtracking).
function assignSlots(
  slots: readonly (readonly [string, RegExp])[],
  questions: readonly string[],
  used: ReadonlySet<number> = new Set(),
  i = 0,
): boolean {
  // Past the last slot (i === slots.length) every slot has its question.
  const slot = slots[i];
  if (slot === undefined) return true;
  const [, re] = slot;
  return questions.some(
    (q, k) =>
      !used.has(k) &&
      re.test(q) &&
      ASKS_FOR_VALUE.test(q) &&
      assignSlots(slots, questions, new Set([...used, k]), i + 1),
  );
}
export function assessInitEmpty(final: string, oracleMap: string): string[] {
  const failures: string[] = [];
  const questions = final
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith('?'));
  if (questions.length === 0) failures.push('no question asked');
  const slots = Object.entries(INIT_EMPTY_SLOTS);
  for (const [slot, re] of slots) {
    if (!questions.some((q) => re.test(q) && ASKS_FOR_VALUE.test(q))) {
      failures.push('slot not asked as a question: ' + slot);
    }
  }
  if (failures.length === 0 && !assignSlots(slots, questions)) {
    failures.push('slots not asked as distinct questions');
  }
  const cites = final
    .split(/\n\s*\n/)
    .some(
      (p) =>
        /\b(scan|oracle map|charge|verification assets|knowledge assets|history and environment)\b/i.test(
          p,
        ) && p.split(/(?<=[.!?:])\s+|\n+/).some(emptinessTiedToSubject),
    );
  if (!cites) failures.push('empty scan not cited as a scan result');
  const emptyRow = oracleMap
    .split('\n')
    .some(
      (l) =>
        /verif|test|build|\bci\b|knowledge|document|histor|environment|commit|hook/i.test(
          l,
        ) &&
        (EMPTY_WORD.test(l) ||
          /\bno\s+(active\s+|tracked\s+|untracked\s+|build\s+or\s+test\s+)?(tests?|build|ci|hooks?|files?|commits?|refs?|remote|tooling|verification|index|linter|manifests?|benchmarks?|vectors?|source|readme|package)\b/i.test(
            l,
          )),
    );
  if (!emptyRow) failures.push('oracle map has no explicit empty charge row');
  return failures;
}

function assertStatusEvidence(
  host: Host,
  run: Run,
  rows: readonly unknown[],
  files: readonly string[],
  activePlugin: string,
): void {
  const invocations = rows.filter(
    (r) =>
      at(r, 'trigger') === 'skill-invocation' &&
      /amber:status/.test(textAt(r, 'summary')),
  );
  if (host === 'codex') {
    assert.ok(
      invocations.length > 0,
      'Codex explicit status recorder invocation missing',
    );
  } else {
    // Typed status is deliberately excluded by S1; the current host also
    // refuses Skill-tool calls to this explicit-only skill. Verify the
    // actual command expansion and manifest-reading tool result instead.
    assert.equal(
      invocations.length,
      0,
      'Claude typed status must not invent an invocation row',
    );
    const typed = files.some((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => {
          let r: unknown;
          try {
            r = parseJson(line);
          } catch {
            return false;
          }
          const content = at(r, 'message', 'content');
          return (
            at(r, 'type') === 'user' &&
            typeof content === 'string' &&
            content.includes('<command-name>/amber:status</command-name>')
          );
        }),
    );
    assert.ok(typed, 'actual Claude status slash-command event missing');
    const expected = textAt(
      parseJson(
        readFileSync(
          join(activePlugin, '.claude-plugin', 'plugin.json'),
          'utf8',
        ),
      ),
      'version',
    );
    const output = toolEvidence(files);
    assert.match(output, /\bamber\b/, 'plugin name missing from tool output');
    assert.ok(
      output.includes(expected),
      'installed version missing from tool output',
    );
    assert.ok(
      run.final.includes(expected),
      'status reports the wrong installed version',
    );
  }
  assert.match(run.final, /Install:/);
  assert.match(run.final, /Active contract:/);
  assert.match(run.final, /Cycle completions:/);
  assert.match(run.final, /Last audit:/);
}

export function runtimeQA(ctx: QaContext): Record<string, unknown> {
  const {
    host,
    scenario,
    BASE,
    activePlugin,
    runHost,
    ledger,
    sensorFailures,
    transcriptFiles,
  } = ctx;
  const root = join(BASE, scenario);
  const home = join(BASE, scenario + '-amber-home');
  // The greenfield fixture is nothing but `git init`: no src/, no .gitignore.
  mkdirSync(scenario === 'init-empty' ? root : join(root, 'src'), {
    recursive: true,
  });
  const write = (p: string, text: string): void => {
    writeFileSync(join(root, p), text);
  };
  const git = (...args: string[]): string => {
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
  const rec = 'node ' + join(activePlugin, 'scripts', 'record.cjs');
  const fixture: Fixture = { root, home, name: scenario, kind: scenario };
  const skill = (name: string): string =>
    (host === 'codex' ? '$amber:' : '/amber:') + name;
  const progress = (): unknown =>
    parseJson(readFileSync(join(root, '.amber', 'progress.json'), 'utf8'));

  if (scenario === 'status') {
    git('add', '.');
    git('commit', '-qm', 'status fixture baseline');
    // Unlike behavioral QA, this invocation does not bypass hook trust.
    const run = runHost(fixture, skill('status'), {
      persistedTrust: true,
      budget: 2,
    });
    const rows = ledger(home);
    assert.equal(sensorFailures(home), '');
    assertStatusEvidence(host, run, rows, transcriptFiles(run), activePlugin);
    const state = join(home, 'state', 'session-' + run.sessionId + '.json');
    assert.ok(existsSync(state), 'S0 did not run with persisted hook trust');
    assert.ok(
      at(parseJson(readFileSync(state, 'utf8')), 'started_at'),
      'S0 timestamp absent',
    );
    assert.ok(
      !rows.some((r) => at(r, 'trigger') === 'done-declaration'),
      'status must not declare completion',
    );
    return {
      outcome: 'status-persisted-trust-pass',
      session_id: run.sessionId,
      root,
      ledger: rows,
      final: run.final,
    };
  }

  if (scenario === 'init-empty') {
    // Greenfield: an empty repository and no operator facts. The skill has to
    // ask - anchored on the empty scan rows and bounded to intent.md's three
    // slots (purpose, first oracle, forbidden set) - and must not invent
    // intent.md from nothing.
    const run = runHost(
      fixture,
      [
        skill('init'),
        'Explicit operator request: initialize Amber in this empty repository using the init skill. There is no code, no document, and no commit here yet.',
        "I will answer your questions in my next message: ask what you need to settle and then stop. Do not guess the project's purpose for me.",
        'Put the oracle map at project-root oracle-map.md and the tension list at project-root tension-list.md when you write them.',
        'The installed plugin is already enabled for this invocation and its AMBER_HOME is isolated. Use its normal sensors and required read-only scan agents. Do not open a planning contract for bootstrap, and do not signal completion.',
      ].join('\n'),
      { budget: 12, timeout: 1200000 },
    );
    const rows = ledger(home);
    assert.equal(sensorFailures(home), '');
    assert.ok(
      rows.some(
        (r) =>
          at(r, 'trigger') === 'skill-invocation' &&
          /amber:init/.test(textAt(r, 'summary')),
      ),
      'init invocation missing',
    );
    assert.ok(
      !rows.some((r) => at(r, 'trigger') === 'done-declaration'),
      'empty-repo init must not declare completion',
    );
    assert.ok(
      !existsSync(join(root, '.amber', 'active.json')),
      'init must not open a planning contract',
    );
    const raw = transcriptFiles(run, true)
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    assert.match(
      raw,
      host === 'codex' ? /spawn_agent/ : /"name":"Agent"/,
      'scan delegation absent',
    );
    const oracleMap = join(root, 'oracle-map.md');
    assert.ok(existsSync(oracleMap), 'oracle map missing');
    assert.ok(
      !existsSync(join(root, 'intent.md')),
      'intent.md written without any operator answer',
    );
    const failures = assessInitEmpty(
      run.final,
      readFileSync(oracleMap, 'utf8'),
    );
    assert.deepEqual(
      failures,
      [],
      'init-empty semantic gate failed: ' + failures.join('; '),
    );
    return {
      outcome: 'init-empty-ask-gate-pass',
      session_id: run.sessionId,
      cost_usd: run.cost,
      turns: run.turns,
      root,
      ledger: rows,
      final: run.final,
    };
  }

  if (scenario === 'init') {
    write('src/cli.cjs', "console.log('hello');\n");
    write(
      'README.md',
      '# QA greeting CLI\nRun `node src/cli.cjs`; expected output: hello.\n',
    );
    git('add', '.');
    git('commit', '-qm', 'init fixture baseline');
    const run = runHost(
      fixture,
      [
        skill('init'),
        'Explicit operator request: initialize Amber in this isolated greeting CLI project using the init skill, through presentation of draft documents for ratification.',
        'Operator facts: intent is a local demonstration CLI that prints hello; no network, deployment, customers, secrets, or external dependencies. Preserve its code and README. The verifier is node src/cli.cjs with exact stdout hello followed by newline. No other promised behavior.',
        'Use the four standard document roles, docs/work-logs for work logs, and project-root oracle-map.md and tension-list.md. Existing ancestor harness instructions are retained; do not change outside configuration. New entry/intent/status documents are permitted, all are drafts pending my next ratification utterance. Resolve routine reversible wording yourself. If any genuinely material choice remains, report it explicitly.',
        'The installed plugin is already enabled for this invocation and its AMBER_HOME is isolated. Use its normal sensors and required read-only scan agents. Do not open a planning contract for bootstrap, and do not signal completion before ratification. Present every created/changed document and stop at the ratification gate.',
      ].join('\n'),
      { budget: 12, timeout: 1200000 },
    );
    const rows = ledger(home);
    assert.equal(sensorFailures(home), '');
    assert.ok(
      rows.some(
        (r) =>
          at(r, 'trigger') === 'skill-invocation' &&
          /amber:init/.test(textAt(r, 'summary')),
      ),
      'init invocation missing',
    );
    assert.ok(
      !rows.some((r) => at(r, 'trigger') === 'done-declaration'),
      'draft init must not complete before ratification',
    );
    assert.ok(
      !existsSync(join(root, '.amber', 'active.json')),
      'init must not open a planning contract',
    );
    const entry = host === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
    for (const p of [
      entry,
      'intent.md',
      'status.md',
      'oracle-map.md',
      'tension-list.md',
    ]) {
      assert.ok(existsSync(join(root, p)), 'init draft missing: ' + p);
    }
    const text = readFileSync(join(root, entry), 'utf8');
    assert.match(text, /record\.cjs/);
    assert.match(text, /--review/);
    assert.match(text, /--goal/);
    assert.match(text, /hold|mark/);
    assert.equal(
      readFileSync(join(root, 'src/cli.cjs'), 'utf8'),
      "console.log('hello');\n",
    );
    const raw = transcriptFiles(run, true)
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    assert.match(
      raw,
      host === 'codex' ? /spawn_agent/ : /"name":"Agent"/,
      'scan delegation absent',
    );
    assert.match(run.final, /ratif|approv/i, 'ratification gate not presented');
    return {
      outcome: 'init-draft-gate-pass',
      session_id: run.sessionId,
      root,
      ledger: rows,
      final: run.final,
    };
  }

  write(
    'AGENTS.md',
    '# QA zone\nFollow the explicit fixture contract and probe instructions.\n',
  );
  write(
    'CLAUDE.md',
    '# QA zone\nFollow the explicit fixture contract and probe instructions.\n',
  );
  write(
    'qa-contract.md',
    [
      '# Runtime QA contract',
      '## Completion conditions',
      '1. src/allowed.txt has exact bytes allowed\\n, verified with node verify.cjs.',
      '2. Forbidden file and command probes were refused; a planted shell write was detected by unit verified and then removed.',
      '3. External hold survived two stops and resume, then start cleared it; a plain hold was consumed once.',
      '4. Status was invoked and this fixture is complete only after all these probes.',
      '- source [machine: write-scope src/**]',
      '- forbidden [machine: bash-deny AMBER_QA_FORBIDDEN_COMMAND]',
    ].join('\n') + '\n',
  );
  write(
    'plan.md',
    '## Work units\n- [ ] U1 runtime probes [unit: U1 scope=src/** oracle=node verify.cjs]\n',
  );
  write(
    'verify.cjs',
    "require('node:assert/strict').equal(require('node:fs').readFileSync('src/allowed.txt','utf8'),'allowed\\n'); console.log('PASS allowed bytes');\n",
  );
  write(
    'plant.cjs',
    "require('node:fs').writeFileSync('outside.txt','planted QA scope violation\\n');\n",
  );
  write('clean.cjs', "require('node:fs').unlinkSync('outside.txt');\n");
  git('add', '.');
  git('commit', '-qm', 'runtime fixture baseline');
  mkdirSync(join(root, '.amber'));
  write(
    '.amber/active.json',
    JSON.stringify({
      v: 1,
      boundary: 'qa-contract.md',
      ratified_by: 'qa',
      ratified_at: '2026-09-21',
    }),
  );
  let run = runHost(
    fixture,
    [
      'Run the authorized runtime QA probes in this already approved fixture contract. Do not open a new cycle or finish the contract in this turn.',
      'First run `' +
        rec +
        ' unit init plan.md`, then separately `' +
        rec +
        ' unit start U1`.',
      'Deliberately submit one FILE TOOL write of forbidden.txt; expect rejection. Separately submit the harmless shell command `printf AMBER_QA_FORBIDDEN_COMMAND`; expect rejection. These are negative probes, do not skip them and do not bypass either denial.',
      'Use the file tool to create src/allowed.txt with exact bytes allowed followed by newline. Run node verify.cjs.',
      'Next run node plant.cjs (authorized fixture fault injection), then `' +
        rec +
        ' unit verified U1 --evidence "negative scope probe"`. Expect refusal for outside.txt. Do not declare an exception or mark the unit verified. Run node clean.cjs to remove only the fixture-planted outside.txt.',
      'Finally run `' +
        rec +
        ' unit hold U1 --reason "external: QA resume probe"`, report the observations and stop. Do not run done.',
    ].join('\n'),
    { budget: 6 },
  );
  const firstId = run.sessionId;
  const initial = progress();
  assert.ok(
    items(at(initial, 'session_ids')).includes(firstId),
    'driver was not registered',
  );
  assert.equal(at(initial, 'hold', 'kind'), 'external');
  assert.equal(at(initial, 'units', 'U1', 'status'), 'running');
  assert.equal(at(initial, 'units', 'U1', 'reentries'), 0);
  assert.ok(
    !existsSync(join(root, 'forbidden.txt')),
    'denied file was written',
  );
  assert.ok(!existsSync(join(root, 'outside.txt')), 'planted file not cleaned');
  assert.equal(
    readFileSync(join(root, 'src/allowed.txt'), 'utf8'),
    'allowed\n',
  );
  const raw = toolEvidence(transcriptFiles(run));
  assert.match(raw, /outside every write-scope/);
  assert.match(
    raw,
    /blocked.*(bash-deny|command)|bash-deny.*AMBER_QA_FORBIDDEN_COMMAND/i,
  );
  assert.match(raw, /blocked.*forbidden\.txt|forbidden\.txt.*outside/i);
  assert.ok(
    !ledger(home).some((r) => at(r, 'trigger') === 'unit-verified'),
    'negative scope probe passed',
  );

  run = runHost(
    { ...fixture, name: 'runtime-resume-external' },
    'Status-only resume check: answer "still waiting" and stop. Do not run tools, change files, clear the external hold, or run done.',
    { resume: firstId, effort: 'low', budget: 1 },
  );
  assert.equal(run.sessionId, firstId, 'resume changed identity');
  assert.deepEqual(
    at(progress(), 'hold'),
    at(initial, 'hold'),
    'external hold must survive another stop',
  );
  assert.equal(at(progress(), 'units', 'U1', 'reentries'), 0);

  run = runHost(
    { ...fixture, name: 'runtime-resume-status' },
    skill('status'),
    { resume: firstId, budget: 2 },
  );
  assert.equal(run.sessionId, firstId);
  assertStatusEvidence(
    host,
    run,
    ledger(home),
    transcriptFiles(run),
    activePlugin,
  );
  assert.deepEqual(
    at(progress(), 'hold'),
    at(initial, 'hold'),
    'status must preserve the external hold',
  );

  run = runHost(
    { ...fixture, name: 'runtime-resume-plain' },
    'Continue QA: run `' +
      rec +
      ' unit start U1` to clear the external hold, then `' +
      rec +
      ' unit hold U1 --reason "QA one-shot checkpoint"` and stop. Do not do any other unit work or run done.',
    { resume: firstId, effort: 'low', budget: 2 },
  );
  assert.equal(run.sessionId, firstId);
  assert.equal(
    at(progress(), 'hold'),
    null,
    'plain hold must be consumed once',
  );
  assert.equal(at(progress(), 'units', 'U1', 'reentries'), 0);

  run = runHost(
    { ...fixture, name: 'runtime-resume-complete' },
    [
      'Continue the runtime QA contract after the explicit status invocation.',
      'Then run node verify.cjs, review the contract and prior probe evidence. Record `' +
        rec +
        ' unit verified U1 --evidence "actual runtime probes and byte verifier passed"`.',
      'If every condition is satisfied, run the usual done command with fresh --review, --goal and --summary as your last tool call and give the completion report.',
    ].join('\n'),
    { resume: firstId, budget: 4 },
  );
  const rows = ledger(home);
  assert.equal(run.sessionId, firstId);
  assert.equal(sensorFailures(home), '');
  assert.equal(
    rows.filter(
      (r) =>
        at(r, 'trigger') === 'done-declaration' && at(r, 'gate') === 'passed',
    ).length,
    1,
  );
  for (const p of ['active.json', 'progress.json', 'done.json']) {
    assert.ok(!existsSync(join(root, '.amber', p)), p + ' not released');
  }
  return {
    outcome: 'runtime-resume-holds-scope-status-pass',
    session_id: firstId,
    root,
    ledger: rows,
    final: run.final,
  };
}
