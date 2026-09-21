#!/usr/bin/env node
// Amber sensors and enforcers, dispatched by argv:
//   S0 (SessionStart)     - pass the model id forward, report sensor failures;
//                           inject contract awareness (standing obligations,
//                           completion-signal and mark conventions) when a
//                           contract is active, or the one-line cycle arming
//                           note when none is
//   S1 (UserPromptSubmit) - record typed /amber:planning, $amber:planning, /amber:init
//                           or $amber:init; brief the session once when a
//                           contract became active after session start (S0
//                           briefs only at startup); S0 and S1 both name a
//                           completion signal waiting for another session
//   S2 (Stop)             - consume the completion signal the model wrote with
//                           `record.cjs done` (its semantic-review attestation
//                           rides in the signal; the final message is never
//                           read); under a contract, accept it only when the
//                           pointer is sound, the signal names that contract,
//                           and no linked worktree remains (max 3 rejections),
//                           then release the contract; with open plan units
//                           and no signal, send the stop back (loop body) -
//                           a plain hold passes once, an external hold passes
//                           every stop until the held unit's next transition
//   S3 (PreToolUse Skill) - record model-invoked amber skills (the judged
//                           cycle-opening path S1 cannot see) and amber:mark
//                           calls (cycle events - the call itself is the
//                           record); sensor only, never a permission decision
//   E1 (PreToolUse)       - deny tool calls that cross the active contract's
//                           machine rules (write-scope globs, bash-deny);
//                           shell writes escape it, so scope-check.cjs compares
//                           git-changed files with the write-scope at unit
//                           verified and done (record.cjs);
//                           register the session as a driver of the run when
//                           it runs a unit command or the completion signal
// No active contract (no .amber/active.json at the zone root) means every
// enforcement path is silent. Unexpected hook crashes fail open and leave a
// breadcrumb in sensor-failures.log; broken contract state fails closed with
// an actionable reason.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { patchPaths } = require('./patch-paths.cjs');
const progress = require('./progress.cjs');

const EVENT = process.argv[2];
const AMBER_HOME = process.env.AMBER_HOME || path.join(os.homedir(), '.amber');
const STATE_DIR = path.join(AMBER_HOME, 'state');
const RUNS_FILE = path.join(AMBER_HOME, 'runs.jsonl');
const FAILURES_FILE = path.join(STATE_DIR, 'sensor-failures.log');
const STATE_TTL_MS = 48 * 60 * 60 * 1000;
const SUMMARY_MAX = 200;
const MAX_LINE_BYTES = 4096;
const MAX_GATE_ATTEMPTS = 3;
// Completion signal freshness: a signal older than this is a leftover of a
// turn that never stopped and must not close a later one.
const DONE_TTL_MS = 60 * 60 * 1000;
const REQUEST_REVIEW_TARGET = 'request';
const PLANNING_CALL = /^(?:\/|\$)amber:planning\b/;
// A typed init call is recorded as a bare skill-invocation row (time and place
// come from the row); a typed status call is not recorded at all.
const INIT_CALL = /^(?:\/|\$)amber:init\b/;
// A typed audit call is recorded the same way; its arguments stay out.
const AUDIT_CALL = /^(?:\/|\$)amber:audit\b/;
// Model-invoked amber skills arrive as Skill tool calls. The live payload
// shape is unconfirmed until the next-session probe, so match the likely
// fields defensively (with or without the plugin prefix).
const AMBER_SKILL = /^(?:amber:)?(planning|set|status|init|mark|audit)$/;
// mark arguments: "<kind> - <text>". Anything else falls back to a plain
// skill-invocation row, so no call ever vanishes unrecorded.
const MARK_ARGS = /^(skip|finding|hold)\s*[-:]\s*([\s\S]+)$/;
const UNIT_CLAIM = /\brecord\.cjs["']?\s+unit\s+claim\s+(U\d+)\b/;
// Any unit command or the completion signal, run by the session itself (no
// agent id): the act that registers the session as a driver of the run.
const UNIT_CMD = /\brecord\.cjs["']?\s+(?:unit\s+(?:init|claim|start|verified|failed|hold)|done)\b/;
const RECORD_CLI = path.join(__dirname, '..', 'scripts', 'record.cjs');
const MACHINE_TAG = /\[machine:\s*(write-scope|bash-deny)\s+(.+)\]\s*$/;

function safeId(id) {
  const cleaned = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned || 'unknown';
}

function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function sessionStatePath(sessionId) {
  return path.join(STATE_DIR, 'session-' + safeId(sessionId) + '.json');
}

function loopStatePath(sessionId) {
  return path.join(STATE_DIR, 'loop-' + safeId(sessionId) + '.json');
}

function gateStatePath(sessionId) {
  return path.join(STATE_DIR, 'gate-' + safeId(sessionId) + '.json');
}

function writeStateAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function tryUnlink(file) {
  try { fs.unlinkSync(file); } catch {}
}

// Refresh the session state file's mtime so the S0 TTL sweep measures
// inactivity, not age: a session alive past STATE_TTL_MS would otherwise
// lose its state (and with it the ledger's model field) to another
// session's sweep. Touch only - never creates a file or a record.
function touchSessionState(sessionId) {
  const now = new Date();
  try { fs.utimesSync(sessionStatePath(sessionId), now, now); } catch {}
}

function pluginVersion() {
  try {
    const manifest = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function gitQuery(cwd, args) {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args],
      { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

// Zone root. A linked worktree that carries its own .amber/active.json is
// its own zone - a parallel run on its own branch. Otherwise
// the zone is the main repository's top level: from a subagent worktree
// (Claude's .claude/worktrees/<name>/, no .amber/ of its own) the common git
// dir still points at the main repository, so the run's pointer and
// progress file - both gitignored, hence absent from the worktree - are found.
function zoneRoot(cwd) {
  const top = gitQuery(cwd, ['rev-parse', '--show-toplevel']);
  if (top && fs.existsSync(path.join(top, '.amber', 'active.json'))) return top;
  const common = gitQuery(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common && path.basename(common) === '.git') return path.dirname(common);
  if (top) return top;
  return path.resolve(cwd || '.');
}

function worktreeTop(cwd) {
  return gitQuery(cwd, ['rev-parse', '--show-toplevel']);
}

// Zone-relative path of a write target. A target inside a linked worktree of
// the zone maps to the same relative path in the zone, so contract and unit
// scopes apply unchanged wherever the write physically lands.
function zoneRelative(contract, cwd, abs) {
  const top = worktreeTop(cwd);
  let base = (top && top !== contract.root && abs.startsWith(top + path.sep)) ? top : contract.root;
  // Codex children inherit the session cwd. A shell tool can override its
  // workdir, but apply_patch still reports the inherited cwd and absolute
  // worktree targets. Map only git-registered worktrees of this repository,
  // never an arbitrary directory that happens to contain the same filename.
  const worktrees = gitQuery(contract.root, ['worktree', 'list', '--porcelain', '-z']);
  for (const row of (worktrees || '').split('\0')) {
    if (!row.startsWith('worktree ')) continue;
    const candidate = row.slice('worktree '.length);
    if (abs.startsWith(candidate + path.sep) &&
        (base === contract.root || candidate.length > base.length)) base = candidate;
  }
  return path.relative(base, abs).split(path.sep).join('/');
}

// Linked worktrees that belong to this zone's run: those created inside the
// zone (subagent worktrees live under <zone>/.claude/worktrees/). A sibling
// worktree elsewhere is another zone's run and never blocks this one.
function extraWorktrees(root) {
  const out = gitQuery(root, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  const base = path.resolve(root);
  return out.split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((w) => path.resolve(w) !== base && path.resolve(w).startsWith(base + path.sep));
}

// Completion signal: the model runs `record.cjs done` as its
// last tool call, which writes <zone>/.amber/done.json; S2 consumes that
// file instead of parsing the final message, so no marker line reaches the
// operator. The file is single-use and short-lived.
function donePath(root) {
  return path.join(root, '.amber', 'done.json');
}

function writeDoneSignal(root, fields) {
  fs.mkdirSync(path.join(root, '.amber'), { recursive: true });
  writeStateAtomic(donePath(root), { v: 1, ts: new Date().toISOString(), ...fields });
}

// Read and consume the zone's completion signal. Consumed on every path so a
// rejected signal never fires twice; a stale one is dropped.
function takeDoneSignal(root) {
  const file = donePath(root);
  if (!fs.existsSync(file)) return null;
  let signal = null;
  try { signal = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  tryUnlink(file);
  if (!signal || typeof signal.summary !== 'string' || typeof signal.review !== 'string') return null;
  if (!(Date.now() - Date.parse(signal.ts || 0) <= DONE_TTL_MS)) return null;
  return signal;
}

// Release on a passed completion: the pointer and progress file go, and the
// session forgets its briefing so a re-approved contract briefs again.
function releaseContract(contract, sessionId) {
  tryUnlink(contract.pointerPath);
  tryUnlink(progress.progressPath(contract.root));
  const stateFile = sessionStatePath(sessionId);
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    delete state.briefed;
    writeStateAtomic(stateFile, state);
  } catch {}
}

function doneCommandText(contract) {
  return 'node ' + RECORD_CLI + ' done --review "<evidence-based review result>"' +
    (contract ? ' --goal "<goal-test result of ' + contract.boundaryFile + '>"' : '') +
    ' --summary "<one-line summary>"';
}

// Completion guidance shared by the S0/S1 briefings: the semantic-review
// obligation, the signal command, and what the hook does and does not judge.
function completionGuidance(contract) {
  return [
    'Completion signal: when the governed work is genuinely complete, first perform a fresh ' +
      'semantic review - compare the original request' +
      (contract ? ', every required condition in ' + contract.boundaryFile : '') +
      ', the current artifacts, and the validation evidence. A file, command exit code, or earlier ' +
      'result proves only the fact it establishes; anything missing, failed, stale after a relevant ' +
      'change, or supported by an unsuitable oracle means the work is not complete. Then run, as ' +
      'your last tool call:',
    doneCommandText(contract),
    'and end the turn with the completion report - what was done and how, in full: the real files, ' +
      'text, or code shapes, what changed where, how it was verified, explained for a reader with no ' +
      'context. No marker line goes in the message. Never run the command for incomplete, blocked, ' +
      'waiting, or status-only states: it declares the governed work unit itself complete, never that ' +
      'an assessment, report, or attempt finished. If work changes after the review, refresh the ' +
      'affected validation and review again before running it. The hook checks only the signal and ' +
      'the current contract, not its truth' +
      (contract ? '; on a passed completion it releases the contract by itself (removes the pointer and progress.json).' : '.'),
  ].join('\n');
}

function projectKey(cwd) {
  return path.basename(zoneRoot(cwd));
}

// Active contract discovery: <zone root>/.amber/active.json points at the
// ratified boundary document. Missing pointer = no contract = null. A pointer
// whose target cannot be read is a broken contract, reported as such so E1
// can fail closed with an actionable reason.
function loadContract(cwd) {
  const root = zoneRoot(cwd);
  const pointerPath = path.join(root, '.amber', 'active.json');
  if (!fs.existsSync(pointerPath)) return null;
  try {
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    const boundaryPath = path.resolve(root, String(pointer.boundary || ''));
    if (!boundaryPath.startsWith(root + path.sep)) {
      throw new Error('boundary path escapes the zone root');
    }
    const text = fs.readFileSync(boundaryPath, 'utf8');
    return {
      root, pointerPath, boundaryPath,
      boundaryFile: path.basename(boundaryPath),
      ratifiedBy: pointer.ratified_by || 'unknown',
      ratifiedAt: pointer.ratified_at || 'unknown',
      text, broken: false,
    };
  } catch (err) {
    return {
      root, pointerPath, boundaryPath: null, boundaryFile: null, text: '',
      broken: true, error: String((err && err.message) || err),
    };
  }
}

function machineRules(text) {
  const rules = { writeScopes: [], bashDeny: [] };
  for (const line of text.split('\n')) {
    const m = MACHINE_TAG.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'write-scope') rules.writeScopes.push(m[2].trim());
    else rules.bashDeny.push(m[2].trim());
  }
  return rules;
}

const { globToRegExp } = progress;

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'amber: ' + reason,
    },
  };
}

function runE1(input) {
  const contract = loadContract(input.cwd);
  if (!contract) return null;
  if (contract.broken) {
    return deny('active contract pointer ' + contract.pointerPath +
      ' is broken (' + contract.error + '). Fix it, or remove the file to release the contract.');
  }
  const rules = machineRules(contract.text);
  const toolInput = input.tool_input || {};
  const agentId = input.agent_id ? String(input.agent_id) : null;
  if (input.tool_name === 'Bash') {
    const command = String(toolInput.command || '');
    for (const pattern of rules.bashDeny) {
      let re;
      try {
        re = new RegExp(pattern);
      } catch {
        return deny('contract ' + contract.boundaryFile +
          ' has an invalid bash-deny pattern: ' + pattern + '. Fix the boundary document.');
      }
      if (re.test(command)) {
        return deny('blocked by contract ' + contract.boundaryFile +
          ': bash-deny ' + pattern);
      }
    }
    if (agentId) {
      // The claim handshake: a subagent's first action names its unit; the
      // hook is the only party that sees the host-assigned agent id, so it
      // records the binding here (agent_id arrives on every subagent tool
      // call; the Agent tool's name does not).
      const claim = UNIT_CLAIM.exec(command);
      if (claim) return observeClaim(input, contract, agentId, claim[1]);
    } else if (UNIT_CMD.test(command)) {
      registerSession(input, contract);
    }
    return null;
  }
  let targets;
  const isPatch = input.tool_name === 'apply_patch';
  if (isPatch) {
    try {
      targets = patchPaths(toolInput.command);
    } catch (err) {
      return deny('cannot inspect apply_patch under contract ' + contract.boundaryFile +
        ': ' + err.message + '. Correct the patch and retry.');
    }
  } else {
    const target = String(toolInput.file_path || toolInput.notebook_path || '');
    targets = target ? [target] : [];
  }
  let unitId = null;
  let unit = null;
  if (agentId) {
    const p = progress.loadProgress(contract.root);
    if (!p || p.broken) {
      return deny('subagent ' + agentId + ' cannot write under contract ' + contract.boundaryFile + ': ' +
        (p ? 'progress.json is broken (' + p.error + ')'
          : 'no progress.json - the main agent runs `node ' + RECORD_CLI +
            ' unit init <plan>` first, and each subagent claims its unit'));
    }
    unitId = progress.unitByAgent(p, agentId);
    if (!unitId) {
      return deny('subagent ' + agentId + ' has not claimed a unit. First run `node ' + RECORD_CLI +
        ' unit claim U<n>` for the unit named in your brief, then write only inside that unit\'s scope.');
    }
    unit = p.units[unitId];
  }
  const boundaryRel = path.relative(contract.root, contract.boundaryPath).split(path.sep).join('/');
  for (const target of targets) {
    const abs = path.resolve(input.cwd || contract.root, target);
    const rel = zoneRelative(contract, input.cwd, abs);
    if (abs === contract.pointerPath || abs === contract.boundaryPath ||
        rel === boundaryRel || rel === '.amber/active.json') {
      return deny('the active contract and its pointer are not editable while the contract is active. ' +
        'Release the contract first (remove ' + contract.pointerPath + ').');
    }
    if (rules.writeScopes.length > 0 &&
        (rel.startsWith('..') || path.isAbsolute(rel) || !progress.inScopes(rel, rules.writeScopes))) {
      return deny('blocked by contract ' + contract.boundaryFile + ': write target ' +
        rel + ' is outside every write-scope (' + rules.writeScopes.join(', ') + ')');
    }
    if (unit && !progress.inScopes(rel, unit.scope)) {
      return deny('blocked by unit ' + unitId + ' (claimed by subagent ' + agentId + '): write target ' +
        rel + ' is outside its scope (' + unit.scope.join(', ') +
        '). Stay inside the unit, or report BLOCKED to the main agent.');
    }
  }
  return null;
}

// Session binding: a run belongs to the sessions that drive it.
// E1 registers a session when it runs a unit command or the completion
// signal itself; the loop body and the completion gate act only for
// registered sessions, so a sibling session in the same zone (a discussion,
// another task) is neither sent back nor allowed to close the run. Boundary
// enforcement stays zone-wide. The registration lives in the session state
// (source of truth, keyed to the boundary file) and is mirrored into
// progress.json's session_ids for the briefing.
function readSessionState(sessionId) {
  try { return JSON.parse(fs.readFileSync(sessionStatePath(sessionId), 'utf8')); } catch { return {}; }
}

// The session behind a shell unit command. The model shell on Claude Code
// may carry no session id, which would leave unit rows attributed to session
// "shell" and model "unknown". E1 registers and
// touches the driving session just before the command runs, so the recorder
// reads that registration back: the most recently touched state file
// registered to this run. Read-only; nothing is registered here.
function driverOfRun(boundaryFile) {
  if (!boundaryFile) return null;
  let names;
  try { names = fs.readdirSync(STATE_DIR); } catch { return null; }
  let best = null;
  for (const name of names) {
    const m = /^session-(.+)\.json$/.exec(name);
    if (!m) continue;
    const file = path.join(STATE_DIR, name);
    let state;
    let mtime;
    try {
      state = JSON.parse(fs.readFileSync(file, "utf8"));
      mtime = fs.statSync(file).mtimeMs;
    } catch { continue; }
    if (state.run !== boundaryFile) continue;
    if (!best || mtime > best.mtime) best = { sessionId: m[1], model: state.model || null, mtime };
  }
  return best;
}

function ownsRun(input, contract) {
  if (!contract || contract.broken) return true;
  return readSessionState(input.session_id).run === contract.boundaryFile;
}

function registerSession(input, contract) {
  const sessionId = input.session_id || 'unknown';
  const state = readSessionState(sessionId);
  if (state.run !== contract.boundaryFile) {
    state.run = contract.boundaryFile;
    ensureDirs();
    writeStateAtomic(sessionStatePath(sessionId), state);
  }
  // Every unit command touches the registration, so the recorder that runs
  // right after this hook finds the issuing session as the newest driver.
  touchSessionState(sessionId);
  const p = progress.loadProgress(contract.root);
  if (p && !p.broken) {
    p.session_ids = Array.isArray(p.session_ids) ? p.session_ids : [];
    if (!p.session_ids.includes(sessionId)) {
      p.session_ids.push(sessionId);
      progress.saveProgress(contract.root, p);
    }
  }
}

function ownershipContextFor(contract, input) {
  if (!contract || contract.broken) return null;
  const p = progress.loadProgress(contract.root);
  const registered = p && !p.broken && Array.isArray(p.session_ids) ? p.session_ids.length : 0;
  if (ownsRun(input, contract)) {
    return 'amber session: this session drives the run (registered; ' + registered + ' session(s) registered in all).';
  }
  return 'amber session: ' + registered + ' session(s) drive this run and this session is not one of them. ' +
    'Its stops are not sent back and its completion signal is not read; the contract\'s write-scope and ' +
    'bash-deny rows still apply here. Running a unit command (`node ' + RECORD_CLI + ' unit …`) registers ' +
    'this session as a driver - do that only to take the run over, e.g. when resuming it. Parallel work ' +
    'belongs in its own linked worktree with its own .amber/active.json (a zone of its own).';
}

function observeClaim(input, contract, agentId, unitId) {
  const p = progress.loadProgress(contract.root);
  if (!p || p.broken) {
    return deny('cannot record the unit claim: ' +
      (p ? 'progress.json is broken (' + p.error + ')' : 'no progress.json in ' + contract.root));
  }
  try {
    progress.applyEvent(p, 'claim', unitId, { agent_id: agentId });
  } catch (err) {
    return deny('unit claim refused: ' + err.message);
  }
  progress.saveProgress(contract.root, p);
  appendRecord(input, unitId + ' claimed by subagent ' + agentId,
    { contract: contract.boundaryFile, unit: unitId, agent_id: agentId }, 'unit-claim');
  return null;
}

// Loop body: a plain stop under a contract with open units is
// sent back with the next unit, up to REENTRY_LIMIT re-entries per unit; a
// recorded hold passes once, an external hold (waiting on an external job)
// passes every stop until progress.applyEvent releases it;
// reaching the limit records it and lets the stop through. No progress.json
// means no continuation at all.
function continuation(input) {
  const loopFile = loopStatePath(input.session_id);
  const release = () => { tryUnlink(loopFile); return null; };
  const contract = loadContract(input.cwd);
  if (!contract || contract.broken) return release();
  if (!ownsRun(input, contract)) return release();
  const p = progress.loadProgress(contract.root);
  if (!p || p.broken) return release();
  if (progress.openUnits(p).length === 0) return release();
  if (p.hold) {
    if (p.hold.kind === 'external') return release();
    p.hold = null;
    progress.saveProgress(contract.root, p);
    return release();
  }
  const id = progress.focusUnit(p);
  if (!id) return release();
  const unit = p.units[id];
  if (unit.reentries >= progress.REENTRY_LIMIT) {
    progress.applyEvent(p, 'limit', id, { by: input.session_id || 'stop' });
    progress.saveProgress(contract.root, p);
    appendRecord(input, id + ' reached the re-entry limit',
      { contract: contract.boundaryFile, unit: id, reentries: unit.reentries }, 'unit-limit');
    return release();
  }
  unit.reentries += 1;
  p.blocks = (p.blocks || 0) + 1;
  progress.saveProgress(contract.root, p);
  ensureDirs();
  writeStateAtomic(loopFile, { blocked_at: new Date().toISOString(), unit: id });
  return { decision: 'block', reason: continuationDirective(contract, p, id) };
}

function continuationDirective(contract, p, id) {
  const unit = p.units[id];
  return 'amber loop (contract ' + contract.boundaryFile + '): ' + progress.openUnits(p).length +
    ' unit(s) still open. Re-entry ' + unit.reentries + '/' + progress.REENTRY_LIMIT + ' on ' + id + '.\n' +
    progress.summary(p) + '\n' +
    'Continue the contract work now: run `node ' + RECORD_CLI + ' unit start ' + id +
    '` if it is not running, do the unit, verify it with its oracle, then `unit verified ' + id +
    ' --evidence "<what the oracle showed>"` (or `unit failed ' + id + ' --evidence "..."`). ' +
    'Units listed as ready whose scopes do not overlap may run in parallel as subagents in worktrees; ' +
    'each subagent first runs `unit claim U<n>`. ' +
    'If you must stop instead - waiting on the operator, budget reached, an out-of-contract decision - ' +
    'invoke amber:mark with args `hold - ' + id + ' - <reason>` (Codex: `node ' + RECORD_CLI +
    ' mark hold "' + id + ' - <reason>"`) and then stop. Do not declare completion while units are open.';
}

function worktreeDirective(contract, worktrees, attempts) {
  return 'amber gate (attempt ' + attempts + '/' + MAX_GATE_ATTEMPTS + '): completion under ' +
    contract.boundaryFile + ' requires that no linked worktree remains, but ' + worktrees.length +
    ' still exist(s): ' + worktrees.join(', ') + '. Merge each verified unit into the main checkout, ' +
    'run the integration verification there, remove the worktrees (`git worktree remove <path>`), ' +
    'run the done command again, then restate the completion report.';
}

function progressContextFor(contract) {
  if (!contract || contract.broken) return null;
  const p = progress.loadProgress(contract.root);
  if (!p) return null;
  if (p.broken) return 'amber: ' + p.file + ' is broken (' + p.error + ') - fix or rebuild it with `node ' + RECORD_CLI + ' unit init <plan> --force` before continuing.';
  const external = p.hold && p.hold.kind === 'external'
    ? 'external hold on ' + (p.hold.unit || '-') + ' since ' + p.hold.ts + ': ' + p.hold.reason +
      ' - every stop passes until that unit next starts, is verified, or fails, or a new hold replaces it.\n'
    : '';
  return progress.summary(p) + '\n' + external +
    'Unit transitions go through `node ' + RECORD_CLI + ' unit start|verified|failed|hold U<n>`; ' +
    'subagents claim with `unit claim U<n>` as their first action and write only inside that unit\'s scope. ' +
    'A plain stop with open units is sent back (' + progress.REENTRY_LIMIT + ' re-entries per unit); ' +
    'to stop legitimately, invoke amber:mark with args `hold - U<n> - <reason>` (passes one stop); ' +
    'a reason starting with `external:` (waiting on an external job) lets every stop pass until that ' +
    'unit\'s next transition.';
}

// Waiting-signal briefing: S2 leaves a completion signal alone
// when the session does not drive the run, so S0 and S1 say that one is
// waiting. Existence only - the signal is never consumed here.
function waitingSignalContextFor(contract, input) {
  if (!contract || contract.broken) return null;
  if (!fs.existsSync(donePath(contract.root))) return null;
  if (ownsRun(input, contract)) return null;
  return 'amber: a completion signal is waiting in this zone; this session does not drive the run ' +
    '(run a unit command or the done command here to take the run over, or leave it to the driving session).';
}

// Rejection directives for a signal the gate cannot accept: a broken
// pointer, or a signal written for another contract. The signal was consumed,
// so the model must run the done command again once the cause is fixed.
function completionDirective(contract, signal, attempts) {
  const head = 'amber gate (attempt ' + attempts + '/' + MAX_GATE_ATTEMPTS + '): ';
  if (contract.broken) {
    return head + 'the active contract is broken (' + contract.error + '), so no completion ' +
      'can be accepted. Fix the pointer, run the done command again, and restate the completion ' +
      'report - or continue the work without declaring. Retry exhaustion is not success.';
  }
  return head + 'the completion signal names ' + signal.target + ' but the active contract is ' +
    contract.boundaryFile + '. Review against the current contract, run the done command again, ' +
    'and restate the completion report.';
}



function appendRecord(input, summary, gateFields, trigger) {
  ensureDirs();
  let model = null;
  try {
    model = JSON.parse(fs.readFileSync(sessionStatePath(input.session_id), 'utf8')).model || null;
  } catch {}
  const record = {
    v: 1,
    ts: new Date().toISOString(),
    session_id: input.session_id || 'unknown',
    cwd: input.cwd || '',
    project: projectKey(input.cwd),
    host: os.hostname(),
    model: model || 'unknown',
    plugin_version: pluginVersion(),
    trigger: trigger || 'done-declaration',
    summary: summary.slice(0, SUMMARY_MAX),
  };
  if (gateFields) Object.assign(record, gateFields);
  const line = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) {
    fs.appendFileSync(RUNS_FILE, line, { mode: 0o600 });
  }
}

// S1: the typed cycle-opening path (recorded from the raw prompt, stage-1
// spike) plus the mid-session briefing. S0 briefs only at session start, so
// a contract approved later would otherwise govern an unbriefed session -
// S1 fires on every prompt and injects the briefing exactly once per
// boundary file. Everything else stays silent.
function runS1(input) {
  touchSessionState(input.session_id);
  const prompt = String(input.prompt || '').trim();
  if (PLANNING_CALL.test(prompt)) appendRecord(input, prompt, null, 'planning-invocation');
  if (INIT_CALL.test(prompt)) appendRecord(input, 'amber:init (typed)', null, 'skill-invocation');
  if (AUDIT_CALL.test(prompt)) appendRecord(input, 'amber:audit (typed)', null, 'skill-invocation');
  const contract = loadContract(input.cwd);
  if (!contract) return null;
  const promptContext = (text) => ({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
  });
  // The waiting-signal line is delivered on every prompt while it applies,
  // briefed session or not.
  const waiting = waitingSignalContextFor(contract, input);
  const key = contract.boundaryFile || 'broken';
  const stateFile = sessionStatePath(input.session_id);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  if (state.briefed === key) return waiting ? promptContext(waiting) : null;
  state.briefed = key;
  ensureDirs();
  writeStateAtomic(stateFile, state);
  return promptContext([contractContextFor(contract), progressContextFor(contract),
    ownershipContextFor(contract, input), waiting].filter(Boolean).join('\n\n'));
}

// S3: the judged cycle-opening path. When the model invokes an amber skill
// itself (utterance-triggered), the invocation surfaces as a Skill tool call
// and never passes UserPromptSubmit, so S1 is blind to it. Sensor only:
// no permission decision, silence on everything that is not an amber skill.
function runS3(input) {
  const toolInput = input.tool_input || {};
  const name = String(toolInput.skill || toolInput.name || '').trim();
  const m = AMBER_SKILL.exec(name);
  if (!m) return null;
  const args = String(toolInput.args || '').trim();
  if (m[1] === 'mark') {
    // Cycle events arrive as mark calls - the call is the record. Collecting
    // text markers at Stop would lose mid-turn events, because
    // last_assistant_message is the final message only.
    const ev = MARK_ARGS.exec(args);
    if (ev) {
      if (ev[1] === 'hold') return recordHold(input, ev[2].trim());
      appendRecord(input, ev[2].trim(), null, ev[1]);
      return null;
    }
  }
  appendRecord(input, name + (args ? ' ' + args : ''), null, 'skill-invocation');
  return null;
}

// S2: the completion recorder. The signal is the zone's done.json written by
// `record.cjs done`; the final message is not read at all.
function runS2(input) {
  touchSessionState(input.session_id);
  const root = zoneRoot(input.cwd);
  // A session that does not drive the run leaves its signal alone: the
  // driver that wrote it (E1 registered it on the done command) reads it.
  const signal = ownsRun(input, loadContract(input.cwd)) ? takeDoneSignal(root) : null;
  const gateFile = gateStatePath(input.session_id);
  let gateAttempts = 0;
  try {
    gateAttempts = JSON.parse(fs.readFileSync(gateFile, 'utf8')).attempts || 0;
  } catch {}
  const loopFile = loopStatePath(input.session_id);
  if (input.stop_hook_active === true) {
    if (gateAttempts === 0) {
      // Re-entered stop with no live gate counter: our own continuation or
      // another hook's block. A fresh signal is ours either way - a consumed
      // signal cannot be re-presented, so a foreign re-entry never duplicates.
      if (!signal) return continuation(input);
      tryUnlink(loopFile);
    } else if (!signal) {
      // The model followed the directive's other branch: declaration withdrawn.
      tryUnlink(gateFile);
      return null;
    }
  } else {
    if (gateAttempts > 0) {
      // Stale counter from an interrupted rejection loop - reclaim it.
      tryUnlink(gateFile);
      gateAttempts = 0;
    }
    tryUnlink(loopFile);
  }
  if (!signal) return continuation(input);
  const contract = loadContract(input.cwd);
  const reviewFields = {
    review_target: contract && !contract.broken ? contract.boundaryFile : REQUEST_REVIEW_TARGET,
    review: signal.review.slice(0, SUMMARY_MAX),
  };
  if (!contract) {
    tryUnlink(gateFile);
    appendRecord(input, signal.summary, reviewFields);
    return null;
  }
  let worktrees = [];
  if (!contract.broken && signal.target === contract.boundaryFile) {
    // Loop body completion condition: every unit worktree merged and gone.
    worktrees = extraWorktrees(contract.root);
    if (worktrees.length === 0) {
      tryUnlink(gateFile);
      appendRecord(input, signal.summary, {
        contract: contract.boundaryFile,
        goal: String(signal.goal || '').slice(0, SUMMARY_MAX),
        gate: 'passed',
        ...reviewFields,
        // Declared out-of-scope files ride in the signal (scope-check.cjs).
        ...(Array.isArray(signal.out_of_scope) && signal.out_of_scope.length > 0
          ? { out_of_scope: signal.out_of_scope,
              out_of_scope_count: signal.out_of_scope_count || signal.out_of_scope.length }
          : {}),
      });
      releaseContract(contract, input.session_id);
      return null;
    }
  }
  // Rejection path: broken pointer, a signal for another contract, or a
  // well-formed signal while unit worktrees remain.
  const attempts = gateAttempts + 1;
  if (attempts > MAX_GATE_ATTEMPTS) {
    tryUnlink(gateFile);
    appendRecord(input, signal.summary, {
      contract: contract.boundaryFile || 'broken',
      goal: null,
      gate: 'exhausted',
    });
    return null;
  }
  ensureDirs();
  writeStateAtomic(gateFile, { attempts });
  const reason = worktrees.length > 0
    ? worktreeDirective(contract, worktrees, attempts)
    : completionDirective(contract, signal, attempts);
  return { decision: 'block', reason };
}

// Contract awareness briefing: contract identity, the standing-obligations
// section verbatim, and the declaration/marker conventions. Injected by S0
// at session start and by S1 when a contract becomes active mid-session
// (field-run 1: an approval 30 minutes in left the model unbriefed).
// A hold recorded through mark: `hold - U<n> - <reason>`. Sets the pass in
// progress.json (when the zone has one) - one-shot, or standing when the
// reason starts with `external:` - and always leaves a ledger row.
function recordHold(input, text) {
  const m = /^(U\d+)\s*[-:]\s*([\s\S]*)$/.exec(text);
  const unitId = m ? m[1] : null;
  const reason = m ? m[2].trim() : text;
  const contract = loadContract(input.cwd);
  const fields = { unit: unitId, reason: reason.slice(0, SUMMARY_MAX) };
  const kind = progress.holdKind(reason);
  if (kind) fields.kind = kind;
  if (contract && !contract.broken) {
    fields.contract = contract.boundaryFile;
    const p = progress.loadProgress(contract.root);
    if (p && !p.broken) {
      try {
        progress.applyEvent(p, 'hold', unitId && p.units[unitId] ? unitId : null,
          { reason, by: input.session_id || 'model' });
        progress.saveProgress(contract.root, p);
      } catch {}
    }
  }
  appendRecord(input, text, fields, 'unit-hold');
  return null;
}

// Unit events recorded by scripts/record.cjs (both hosts' shell path).
function recordUnitEvent(sessionId, cwd, event, summaryText, fields) {
  appendRecord({ session_id: sessionId, cwd }, summaryText, fields || null, 'unit-' + event);
}

function contractInfo(cwd) {
  const c = loadContract(cwd);
  if (!c) return { root: zoneRoot(cwd), boundaryFile: null, broken: false, writeScopes: [], boundaryRel: null };
  return {
    root: c.root, boundaryFile: c.boundaryFile, broken: c.broken, error: c.error,
    writeScopes: c.broken ? [] : machineRules(c.text).writeScopes,
    boundaryRel: c.boundaryPath ? path.relative(c.root, c.boundaryPath).split(path.sep).join('/') : null,
  };
}

function contractContextFor(contract) {
  if (!contract) return null;
  if (contract.broken) {
    return 'amber: the active contract pointer ' + contract.pointerPath +
      ' is broken (' + contract.error + '). Enforcement fails closed - ' +
      'fix the pointer, or remove it to release the contract.';
  }
  const lines = contract.text.split('\n');
  // The contract's `## Standing rules` section is handed to the model verbatim.
  const start = lines.findIndex((l) => /^##\s*standing rules\b/i.test(l.trim()));
  let obligations = '(none listed)';
  if (start !== -1) {
    const body = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) break;
      body.push(lines[i]);
    }
    if (body.join('\n').trim()) obligations = body.join('\n').trim();
  }
  return [
    'amber: an active contract governs this zone - ' + contract.boundaryFile +
      ' (approved by ' + contract.ratifiedBy + ', ' + contract.ratifiedAt + ').',
    'Standing rules:',
    obligations,
    completionGuidance(contract),
    'Record cycle events with the amber:mark skill; follow its host-specific recording instructions:',
    'args "skip - <subject> - <reason>"  (a gate the operator skipped, or a no-contract opening verdict)',
    'args "finding - <finding> - <disposition>"  (a verification finding and its settled disposition)',
    'args "hold - U<n> - <reason>"  (a legitimate stop while units are open: operator wait, budget, out-of-contract decision)',
  ].join('\n');
}

function runS0(input) {
  ensureDirs();
  const contract = loadContract(input.cwd);
  const state = {
    model: input.model || null,
    started_at: new Date().toISOString(),
  };
  // Briefed flag keyed to the boundary file: S1 re-briefs only when a
  // contract appears (or changes) after this session's opening.
  if (contract) state.briefed = contract.boundaryFile || 'broken';
  // A resumed or compacted session keeps driving its run.
  const previous = readSessionState(input.session_id);
  if (previous.run) state.run = previous.run;
  writeStateAtomic(sessionStatePath(input.session_id), state);
  for (const name of fs.readdirSync(STATE_DIR)) {
    if (!name.startsWith('session-') && !name.startsWith('gate-') && !name.startsWith('loop-')) continue;
    const file = path.join(STATE_DIR, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > STATE_TTL_MS) fs.unlinkSync(file);
    } catch {}
  }
  let failures = 0;
  try {
    failures = fs.readFileSync(FAILURES_FILE, 'utf8').split('\n').filter(Boolean).length;
  } catch {}
  const parts = [];
  const contractCtx = contractContextFor(contract);
  if (contractCtx) {
    parts.push(contractCtx);
    const progressCtx = progressContextFor(contract);
    if (progressCtx) parts.push(progressCtx);
    const ownerCtx = ownershipContextFor(contract, input);
    if (ownerCtx) parts.push(ownerCtx);
    const waitingCtx = waitingSignalContextFor(contract, input);
    if (waitingCtx) parts.push(waitingCtx);
  } else {
    // Arming note for contract-less sessions: the session's character is unknown
    // at start, so hand the model the opening criterion and stay out of the
    // way otherwise. Enforcement remains fully silent without a contract.
    // Opening criterion (open-by-default): the only test
    // made out here is "is this a work request" - contract-worthiness is
    // judged inside planning, where the verdict leaves a record either way.
    parts.push('amber: no active contract in this zone. If a work request ' +
      'is starting - anything that would change zone files or produce a ' +
      'deliverable - invoke the amber:planning skill first: whether the work ' +
      'needs a contract is judged inside planning and recorded there, never ' +
      'silently. Only pure Q&A, discussion, or status checks need no cycle.');
    parts.push(completionGuidance(null) + '\nPure Q&A, discussion, and status responses need no signal and are unaffected.');
  }
  if (failures > 0) {
    parts.push('amber: ' + failures + ' sensor failure(s) recorded - see ' + FAILURES_FILE);
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: parts.join('\n\n'),
    },
  };
}

function main() {
  let raw = '';
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let output = null;
    try {
      const input = JSON.parse(raw);
      if (EVENT === 'S0') output = runS0(input);
      else if (EVENT === 'S1') output = runS1(input);
      else if (EVENT === 'S2') output = runS2(input);
      else if (EVENT === 'S3') output = runS3(input);
      else if (EVENT === 'E1') output = runE1(input);
    } catch (err) {
      try {
        ensureDirs();
        fs.appendFileSync(FAILURES_FILE,
          new Date().toISOString() + ' hook-crash event=' + EVENT + ' ' +
          String((err && err.message) || err).slice(0, 200) + '\n',
          { mode: 0o600 });
      } catch {}
    }
    if (output) process.stdout.write(JSON.stringify(output));
    process.exit(0);
  });
}

module.exports = { runS3, recordUnitEvent, contractInfo, writeDoneSignal, driverOfRun };
if (require.main === module) main();
