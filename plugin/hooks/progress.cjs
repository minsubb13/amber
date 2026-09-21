// Amber loop body state: the per-run progress file (.amber/progress.json at the
// zone root) that the plan's unit rows seed and the unit commands, E1, S2, S3
// update. Shared by amber-hook.cjs and scripts/record.cjs; requires neither.
//
// Plan unit row grammar (one per line, column-0 checkbox):
//   - [ ] U1 <title> [unit: U1 scope=<glob>[,<glob>] [after=U2,U3] [oracle=<command to end of tag>]]
// Unit statuses: pending | running | verified | failed | limit. Open units are
// pending, running, and failed. A plain hold is a one-shot pass consumed by
// S2; an external hold (reason starting with `external:`, kind 'external')
// stands until the held unit's next transition or a newer hold.
const fs = require('fs');
const path = require('path');

const UNIT_ROW = /^-\s*\[[ xX]\]\s*(U\d+)\b(.*?)\[unit:\s*(U\d+)\s+(.*)\]\s*$/;
const OPEN = new Set(['pending', 'running', 'failed']);
const REENTRY_LIMIT = 10;
// "waiting on an external job" hold: the one place both
// recording paths (mark via S3, record.cjs unit hold) classify a reason.
const EXTERNAL_HOLD = /^\s*external:/i;

function holdKind(reason) {
  return EXTERNAL_HOLD.test(String(reason || '')) ? 'external' : null;
}

// Minimal glob (** / * / ?) to RegExp, matched against a /-separated path
// relative to the zone root. No external packages by design.
function globToRegExp(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
        else { re += '.*'; i += 2; }
      } else { re += '[^/]*'; i += 1; }
    } else if (c === '?') {
      re += '[^/]'; i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

function inScopes(rel, scopes) {
  return scopes.some((scope) => globToRegExp(scope).test(rel));
}

function parseUnitFields(rest) {
  const fields = { scope: [], after: [], oracle: '' };
  const oracleAt = rest.indexOf('oracle=');
  const head = oracleAt === -1 ? rest : rest.slice(0, oracleAt);
  if (oracleAt !== -1) fields.oracle = rest.slice(oracleAt + 'oracle='.length).trim();
  for (const token of head.trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf('=');
    if (eq === -1) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (key === 'scope') fields.scope = value;
    else if (key === 'after') fields.after = value;
  }
  return fields;
}

function parsePlanUnits(text) {
  const units = [];
  for (const raw of text.split('\n')) {
    const m = UNIT_ROW.exec(raw.trim());
    if (!m) continue;
    if (m[1] !== m[3]) throw new Error('unit row id mismatch: ' + raw.trim());
    const fields = parseUnitFields(m[4]);
    if (fields.scope.length === 0) throw new Error('unit ' + m[1] + ' has no scope=');
    units.push({ id: m[1], title: m[2].trim(), ...fields });
  }
  const ids = new Set(units.map((u) => u.id));
  for (const u of units) {
    for (const dep of u.after) {
      if (!ids.has(dep)) throw new Error('unit ' + u.id + ' depends on unknown ' + dep);
    }
  }
  return units;
}

function progressPath(root) {
  return path.join(root, '.amber', 'progress.json');
}

function loadProgress(root) {
  const file = progressPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!p || typeof p.units !== 'object') throw new Error('no units object');
    return p;
  } catch (err) {
    return { broken: true, error: String((err && err.message) || err), file };
  }
}

function saveProgress(root, p) {
  const file = progressPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  p.updated_at = new Date().toISOString();
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function initProgress(root, planRel, contractFile, force, preexisting) {
  const file = progressPath(root);
  if (fs.existsSync(file) && !force) {
    throw new Error(file + ' already exists; pass --force to rebuild it from the plan');
  }
  const planAbs = path.resolve(root, planRel);
  const units = parsePlanUnits(fs.readFileSync(planAbs, 'utf8'));
  if (units.length === 0) throw new Error('no [unit: ...] rows found in ' + planRel);
  const p = {
    v: 1,
    contract: contractFile || null,
    plan: path.relative(root, planAbs).split(path.sep).join('/'),
    created_at: new Date().toISOString(),
    current: null,
    hold: null,
    blocks: 0,
    session_ids: [],
    // Paths already dirty when the run began (scope-check excludes them).
    preexisting: Array.isArray(preexisting) ? preexisting : [],
    units: {},
  };
  for (const u of units) {
    p.units[u.id] = {
      title: u.title, scope: u.scope, after: u.after, oracle: u.oracle,
      status: 'pending', agent_id: null, reentries: 0, history: [],
    };
  }
  saveProgress(root, p);
  return p;
}

function isOpen(unit) {
  return OPEN.has(unit.status);
}

function openUnits(p) {
  return Object.keys(p.units).filter((id) => isOpen(p.units[id]));
}

function depsMet(p, id) {
  return (p.units[id].after || []).every((dep) => p.units[dep] && p.units[dep].status === 'verified');
}

// The unit S2 counts a re-entry against: the current unit while it is open,
// otherwise the first open unit whose dependencies are met, otherwise the
// first open unit at all.
function focusUnit(p) {
  if (p.current && p.units[p.current] && isOpen(p.units[p.current])) return p.current;
  const open = openUnits(p);
  return open.find((id) => depsMet(p, id)) || open[0] || null;
}

function readyUnits(p) {
  return openUnits(p).filter((id) => p.units[id].status !== 'running' && depsMet(p, id));
}

function pushHistory(unit, entry) {
  unit.history.push({ ts: new Date().toISOString(), ...entry });
  if (unit.history.length > 50) unit.history.splice(0, unit.history.length - 50);
}

function requireUnit(p, id) {
  const unit = p.units[id];
  if (!unit) throw new Error('unknown unit ' + id + ' (known: ' + Object.keys(p.units).join(', ') + ')');
  return unit;
}

// Apply one transition. Returns the mutated progress; the caller saves it.
function applyEvent(p, event, id, extra) {
  const by = (extra && extra.by) || 'shell';
  if (event === 'hold') {
    // A new hold, plain or external, replaces the previous one.
    const unit = id ? requireUnit(p, id) : null;
    const reason = (extra && extra.reason) || '';
    p.hold = { unit: unit ? id : null, reason, by, ts: new Date().toISOString() };
    const kind = holdKind(reason);
    if (kind) p.hold.kind = kind;
    if (unit) pushHistory(unit, { event: 'hold', by, note: p.hold.reason });
    return p;
  }
  const unit = requireUnit(p, id);
  // An external hold is released by the held unit's next transition; a plain
  // hold is consumed by S2 instead.
  if (p.hold && p.hold.kind === 'external' && p.hold.unit === id &&
      (event === 'start' || event === 'verified' || event === 'failed')) {
    p.hold = null;
  }
  if (event === 'start') {
    // Re-entries reset only on an explicit restart after the limit; a unit
    // that was merely pending or failed keeps its count (the per-unit
    // counters already give a fresh count whenever the focus unit changes).
    if (unit.status === 'limit') unit.reentries = 0;
    unit.status = 'running';
    p.current = id;
    pushHistory(unit, { event: 'start', by });
  } else if (event === 'claim') {
    const agent = extra && extra.agent_id;
    if (!agent) throw new Error('claim requires an agent id');
    if (unit.agent_id && unit.agent_id !== agent) {
      throw new Error('unit ' + id + ' is already claimed by agent ' + unit.agent_id);
    }
    if (!isOpen(unit)) throw new Error('unit ' + id + ' is ' + unit.status + ', not open');
    unit.agent_id = agent;
    if (unit.status === 'pending') unit.status = 'running';
    pushHistory(unit, { event: 'claim', by: agent });
  } else if (event === 'verified') {
    unit.status = 'verified';
    unit.agent_id = null;
    pushHistory(unit, Object.assign({ event: 'verified', by, note: (extra && extra.evidence) || '' },
      extra && extra.out_of_scope ? { out_of_scope: extra.out_of_scope } : {}));
  } else if (event === 'failed') {
    unit.status = 'failed';
    pushHistory(unit, { event: 'failed', by, note: (extra && extra.evidence) || '' });
  } else if (event === 'limit') {
    unit.status = 'limit';
    pushHistory(unit, { event: 'limit', by, note: 'reentry limit ' + REENTRY_LIMIT + ' reached' });
  } else {
    throw new Error('unknown unit event ' + event);
  }
  return p;
}

function unitByAgent(p, agentId) {
  return Object.keys(p.units).find((id) => p.units[id].agent_id === agentId) || null;
}

function summary(p) {
  const ids = Object.keys(p.units);
  const by = (status) => ids.filter((id) => p.units[id].status === status);
  const open = openUnits(p);
  const focus = focusUnit(p);
  const lines = [];
  lines.push('amber progress (' + (p.plan || 'progress.json') + '): ' + open.length + ' of ' + ids.length +
    ' unit(s) open - verified: ' + (by('verified').join(', ') || 'none') +
    '; running: ' + (by('running').join(', ') || 'none') +
    '; failed: ' + (by('failed').join(', ') || 'none') +
    '; limit: ' + (by('limit').join(', ') || 'none') + '.');
  if (focus) {
    const u = p.units[focus];
    lines.push('next: ' + focus + ' ' + u.title + ' [scope: ' + u.scope.join(', ') +
      (u.oracle ? '; oracle: ' + u.oracle : '') + '; re-entries: ' + u.reentries + '/' + REENTRY_LIMIT + ']');
  }
  const ready = readyUnits(p).filter((id) => id !== focus);
  if (ready.length) lines.push('also ready (dependencies met): ' + ready.join(', '));
  if (p.hold) {
    lines.push('hold: ' + (p.hold.unit || '-') + ' - ' +
      (p.hold.kind === 'external' ? 'external since ' + p.hold.ts + ' - ' : '') + p.hold.reason);
  }
  const sessions = Array.isArray(p.session_ids) ? p.session_ids : [];
  lines.push('driving sessions: ' + (sessions.length ? sessions.join(', ') : 'none registered yet'));
  return lines.join('\n');
}

module.exports = {
  REENTRY_LIMIT, globToRegExp, inScopes, parsePlanUnits, progressPath, loadProgress,
  saveProgress, initProgress, openUnits, focusUnit, readyUnits, applyEvent, unitByAgent, summary,
  holdKind,
};
