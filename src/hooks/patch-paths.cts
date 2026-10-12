// Parse the native apply_patch envelope before E1 checks every affected path.
// Update bodies preserve leading spaces because those are context lines.

/** What a `*** <Operation> File: <path>` header does to its path. */
type Operation = 'Add' | 'Update' | 'Delete';

const HEREDOC_OPEN = /^<<(?:EOF|'EOF'|"EOF")$/;
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ENVIRONMENT = '*** Environment ID:';
const HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_TO = '*** Move to: ';
const END_OF_FILE = '*** End of File';
const UPDATE_LINE = /^[ +-]/;

function parseHeader(
  marker: string,
): { operation: Operation; target: string } | null {
  const match = HEADER.exec(marker);
  if (match === null) return null;
  const [, name, target = ''] = match;
  return name === 'Add' || name === 'Update' || name === 'Delete'
    ? { operation: name, target }
    : null;
}

/**
 * The paths an apply_patch command adds, updates, deletes or moves to, in
 * order. Throws with a message naming the first malformed part.
 */
function patchPaths(command: unknown): string[] {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('tool_input.command must contain the patch text');
  }
  let lines = command.trim().split(/\r?\n/);
  if (
    HEREDOC_OPEN.test(lines[0] ?? '') &&
    (lines.at(-1) ?? '').endsWith('EOF')
  ) {
    lines = lines.slice(1, -1);
  }
  if (lines[0]?.trim() !== BEGIN || lines.at(-1)?.trim() !== END) {
    throw new Error(
      'include *** Begin Patch and *** End Patch around the patch',
    );
  }
  const targets: string[] = [];
  let operation: Operation | null = null;
  let moved = false;
  let chunkStarted = false;
  let chunkHasLines = false;
  let chunkEnded = false;
  let environmentSeen = false;
  const requireUpdateLines = (): void => {
    if (operation === 'Update' && !chunkHasLines) {
      throw new Error('each Update File section needs a nonempty update hunk');
    }
  };
  const addTarget = (target: string): void => {
    if (!target || target.includes('\0')) {
      throw new Error('file paths must be nonempty and contain no NUL');
    }
    targets.push(target);
  };
  const last = lines.length - 1;
  for (const [offset, line] of lines.slice(1).entries()) {
    const i = offset + 1;
    const marker = operation === 'Update' ? line.trimEnd() : line.trim();
    if (i === last) {
      requireUpdateLines();
      return targets;
    }
    if (operation === null && marker.startsWith(ENVIRONMENT)) {
      if (environmentSeen || !marker.slice(ENVIRONMENT.length).trim()) {
        throw new Error('Environment ID must be nonempty and appear only once');
      }
      environmentSeen = true;
      continue;
    }
    const header = parseHeader(marker);
    if (header !== null) {
      requireUpdateLines();
      addTarget(header.target);
      operation = header.operation;
      moved = false;
      chunkStarted = false;
      chunkHasLines = false;
      chunkEnded = false;
      continue;
    }
    if (operation === 'Add' && line.startsWith('+')) continue;
    if (operation !== 'Update') {
      throw new Error('invalid patch section at line ' + String(i + 1));
    }
    if (chunkEnded && marker === '') continue;
    if (marker === '@@' || marker.startsWith('@@ ')) {
      if (chunkStarted && !chunkHasLines) {
        throw new Error('empty update hunk at line ' + String(i + 1));
      }
      chunkStarted = true;
      chunkHasLines = false;
      chunkEnded = false;
      continue;
    }
    if (chunkEnded) {
      throw new Error('expected an @@ context marker at line ' + String(i + 1));
    }
    if (!chunkStarted && !moved && marker.startsWith(MOVE_TO)) {
      addTarget(marker.slice(MOVE_TO.length));
      moved = true;
      continue;
    }
    if (marker === END_OF_FILE) {
      requireUpdateLines();
      chunkEnded = true;
      continue;
    }
    if (line === '' || UPDATE_LINE.test(line)) {
      chunkStarted = true;
      chunkHasLines = true;
      continue;
    }
    throw new Error('invalid update line at line ' + String(i + 1));
  }
  throw new Error('patch has no end marker');
}

export = { patchPaths };
