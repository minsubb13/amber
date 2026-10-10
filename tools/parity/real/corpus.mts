// The real-record corpus: zones with their contracts and plans, and the
// tool calls hosts actually made in those zones, read from the Claude Code
// transcripts and Codex rollouts. Everything stays in memory; paths inside a
// zone are rewritten to the <ZONE> placeholder so a call can be replayed in a
// scratch zone.

import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

import { isRecord, isStringArray } from '../../shared/guards.mjs';

export interface Zone {
  readonly root: string;
  /** Absolute paths of docs/*-contract.md files. */
  readonly contracts: readonly string[];
  /** Absolute paths of docs/*-plan.md files that carry unit rows. */
  readonly plans: readonly string[];
}

export type ToolName =
  'Bash' | 'Write' | 'Edit' | 'NotebookEdit' | 'apply_patch';

export interface ToolCall {
  readonly zone: string;
  readonly host: 'claude' | 'codex';
  /** cwd relative to the zone root, '' for the root itself. */
  readonly cwd: string;
  readonly tool: ToolName;
  /** Tool input with every zone-root path written as <ZONE>. */
  readonly input: Readonly<Record<string, string>>;
}

export const ZONE_PLACEHOLDER = '<ZONE>';

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', '.git']);

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Directories of a zone that hold its contracts and plans. */
const RECORD_DIRS = ['docs', 'contracts', 'plans'];

function recordFiles(root: string, suffix: string): string[] {
  return RECORD_DIRS.flatMap((sub) => {
    const dir = join(root, sub);
    return isDir(dir)
      ? listDir(dir)
          .filter((name) => name.endsWith(suffix))
          .sort()
          .map((name) => join(dir, name))
      : [];
  });
}

/** Zones under home (depth <= maxDepth) that hold at least one contract. */
export function discoverZones(home: string, maxDepth = 4): Zone[] {
  const zones: Zone[] = [];
  const walk = (dir: string, depth: number): void => {
    const contracts = recordFiles(dir, '-contract.md');
    if (contracts.length > 0) {
      const plans = recordFiles(dir, '-plan.md').filter((file) =>
        readFileSync(file, 'utf8').includes('[unit:'),
      );
      zones.push({ root: dir, contracts, plans });
    }
    if (depth >= maxDepth) return;
    for (const name of listDir(dir).sort()) {
      if (
        name.startsWith('.') ||
        SKIP_DIRS.has(name) ||
        name.startsWith('dist-')
      ) {
        continue;
      }
      const child = join(dir, name);
      if (isDir(child)) walk(child, depth + 1);
    }
  };
  walk(home, 0);
  return zones;
}

function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of listDir(current).sort()) {
      const path = join(current, name);
      if (name.endsWith('.jsonl')) out.push(path);
      else if (isDir(path)) walk(path);
    }
  };
  walk(dir);
  return out;
}

function zoneOf(zones: readonly Zone[], cwd: string): Zone | null {
  let best: Zone | null = null;
  for (const zone of zones) {
    if (cwd === zone.root || cwd.startsWith(zone.root + sep)) {
      if (best === null || zone.root.length > best.root.length) best = zone;
    }
  }
  return best;
}

function placeholder(text: string, root: string): string {
  return text.split(root).join(ZONE_PLACEHOLDER);
}

function shellText(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (!isStringArray(command)) return null;
  const [shell, flag, script] = command;
  if (
    command.length === 3 &&
    shell !== undefined &&
    /(^|\/)(ba|z)?sh$/.test(shell) &&
    (flag === '-c' || flag === '-lc') &&
    script !== undefined
  ) {
    return script;
  }
  return command.join(' ');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface RawCall {
  readonly tool: ToolName;
  readonly input: Record<string, string>;
}

function claudeCalls(line: unknown): { cwd: string; calls: RawCall[] } | null {
  if (!isRecord(line)) return null;
  const { cwd, message } = line;
  if (typeof cwd !== 'string' || !isRecord(message)) return null;
  const content = message['content'];
  if (!Array.isArray(content)) return null;
  const calls: RawCall[] = [];
  for (const item of content) {
    if (!isRecord(item) || item['type'] !== 'tool_use') continue;
    const { name, input } = item;
    if (!isRecord(input)) continue;
    const pick = (key: string): string | null => {
      const value = input[key];
      return typeof value === 'string' ? value : null;
    };
    if (name === 'Bash') {
      const command = pick('command');
      if (command !== null) calls.push({ tool: 'Bash', input: { command } });
    } else if (name === 'Write' || name === 'Edit') {
      const file = pick('file_path');
      if (file !== null) calls.push({ tool: name, input: { file_path: file } });
    } else if (name === 'NotebookEdit') {
      const file = pick('notebook_path');
      if (file !== null) {
        calls.push({ tool: 'NotebookEdit', input: { notebook_path: file } });
      }
    }
  }
  return { cwd, calls };
}

function codexCall(payload: Record<string, unknown>): RawCall | null {
  const { type, name } = payload;
  if (type === 'function_call') {
    const args = parseJson(
      typeof payload['arguments'] === 'string' ? payload['arguments'] : '',
    );
    if (!isRecord(args)) return null;
    if (name === 'exec_command' || name === 'shell') {
      const command = shellText(args['cmd'] ?? args['command']);
      return command === null ? null : { tool: 'Bash', input: { command } };
    }
    if (name === 'write_file' || name === 'append_to_file') {
      const file = args['path'];
      return typeof file === 'string'
        ? { tool: 'Write', input: { file_path: file } }
        : null;
    }
    return null;
  }
  if (type === 'custom_tool_call' && name === 'apply_patch') {
    const input = payload['input'];
    return typeof input === 'string'
      ? { tool: 'apply_patch', input: { command: input } }
      : null;
  }
  if (type === 'item_completed') {
    const item = payload['item'];
    if (isRecord(item) && item['type'] === 'CommandExecution') {
      const command = shellText(item['command']);
      return command === null ? null : { tool: 'Bash', input: { command } };
    }
  }
  return null;
}

export function callKey(call: ToolCall): string {
  return JSON.stringify([call.zone, call.cwd, call.tool, call.input]);
}

export function stableHash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function addCall(
  out: Map<string, ToolCall>,
  zones: readonly Zone[],
  host: ToolCall['host'],
  cwd: string,
  raw: RawCall,
): void {
  const zone = zoneOf(zones, cwd);
  if (zone === null) return;
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.input)) {
    input[key] = placeholder(value, zone.root);
  }
  const call: ToolCall = {
    zone: zone.root,
    host,
    cwd: relative(zone.root, cwd).split(sep).join('/'),
    tool: raw.tool,
    input,
  };
  out.set(callKey(call), call);
}

async function eachLine(
  file: string,
  visit: (line: string) => void,
): Promise<void> {
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) visit(line);
}

export interface Sources {
  readonly claudeProjects: string;
  readonly codexDirs: readonly string[];
}

/** Unique tool calls in zones, from every transcript under the sources. */
export async function harvestCalls(
  zones: readonly Zone[],
  sources: Sources,
): Promise<Map<string, ToolCall>> {
  const out = new Map<string, ToolCall>();
  for (const file of jsonlFiles(sources.claudeProjects)) {
    await eachLine(file, (line) => {
      if (!line.includes('"tool_use"')) return;
      const parsed = claudeCalls(parseJson(line));
      if (parsed === null) return;
      for (const raw of parsed.calls) {
        addCall(out, zones, 'claude', parsed.cwd, raw);
      }
    });
  }
  for (const dir of sources.codexDirs) {
    for (const file of jsonlFiles(dir)) {
      let cwd: string | null = null;
      await eachLine(file, (line) => {
        if (
          !line.includes('"cwd"') &&
          !line.includes('_call"') &&
          !line.includes('CommandExecution')
        ) {
          return;
        }
        const record = parseJson(line);
        if (!isRecord(record)) return;
        const payload = record['payload'];
        if (!isRecord(payload)) return;
        const where = payload['cwd'];
        if (typeof where === 'string') cwd = where;
        const raw = codexCall(payload);
        if (raw !== null && cwd !== null) {
          addCall(out, zones, 'codex', cwd, raw);
        }
      });
    }
  }
  return out;
}

/**
 * A deterministic sample, stratified so the rare file-writing tools are not
 * crowded out by shell commands: per zone and tool, the calls with the
 * smallest key hashes, at most perGroup of them (Bash) or perGroup / 2 (every
 * other tool).
 */
export function sampleCalls(
  calls: ReadonlyMap<string, ToolCall>,
  perGroup: number,
): ToolCall[] {
  const groups = new Map<string, { hash: string; call: ToolCall }[]>();
  for (const [key, call] of calls) {
    const group = `${call.zone}\u0000${call.tool}`;
    const list = groups.get(group) ?? [];
    list.push({ hash: stableHash(key), call });
    groups.set(group, list);
  }
  const out: ToolCall[] = [];
  for (const group of [...groups.keys()].sort()) {
    const list = (groups.get(group) ?? []).sort((a, b) =>
      a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0,
    );
    const cap = group.endsWith('\u0000Bash')
      ? perGroup
      : Math.ceil(perGroup / 2);
    out.push(...list.slice(0, cap).map((entry) => entry.call));
  }
  return out;
}
