// Parse the native apply_patch envelope before E1 checks every affected path.
// Update bodies preserve leading spaces because those are context lines.
function patchPaths(command) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('tool_input.command must contain the patch text');
  }
  let lines = command.trim().split(/\r?\n/);
  if (/^<<(?:EOF|'EOF'|"EOF")$/.test(lines[0]) && lines.at(-1).endsWith('EOF')) {
    lines = lines.slice(1, -1);
  }
  if (lines[0]?.trim() !== '*** Begin Patch' || lines.at(-1)?.trim() !== '*** End Patch') {
    throw new Error('include *** Begin Patch and *** End Patch around the patch');
  }
  const targets = [];
  let operation = null;
  let moved = false;
  let chunkStarted = false;
  let chunkHasLines = false;
  let chunkEnded = false;
  let environmentSeen = false;
  function requireUpdateLines() {
    if (operation === 'Update' && !chunkHasLines) {
      throw new Error('each Update File section needs a nonempty update hunk');
    }
  }
  function addTarget(target) {
    if (!target || target.includes('\0')) throw new Error('file paths must be nonempty and contain no NUL');
    targets.push(target);
  }
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = operation === 'Update' ? line.trimEnd() : line.trim();
    if (i === lines.length - 1) {
      requireUpdateLines();
      return targets;
    }
    if (operation === null && marker.startsWith('*** Environment ID:')) {
      if (environmentSeen || !marker.slice('*** Environment ID:'.length).trim()) {
        throw new Error('Environment ID must be nonempty and appear only once');
      }
      environmentSeen = true;
      continue;
    }
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(marker);
    if (header) {
      requireUpdateLines();
      addTarget(header[2]);
      operation = header[1];
      moved = false;
      chunkStarted = false;
      chunkHasLines = false;
      chunkEnded = false;
      continue;
    }
    if (operation === 'Add' && line.startsWith('+')) continue;
    if (operation !== 'Update') throw new Error('invalid patch section at line ' + (i + 1));
    if (chunkEnded && marker === '') continue;
    if (marker === '@@' || marker.startsWith('@@ ')) {
      if (chunkStarted && !chunkHasLines) throw new Error('empty update hunk at line ' + (i + 1));
      chunkStarted = true;
      chunkHasLines = false;
      chunkEnded = false;
      continue;
    }
    if (chunkEnded) throw new Error('expected an @@ context marker at line ' + (i + 1));
    if (!chunkStarted && !moved && marker.startsWith('*** Move to: ')) {
      addTarget(marker.slice('*** Move to: '.length));
      moved = true;
      continue;
    }
    if (marker === '*** End of File') {
      requireUpdateLines();
      chunkEnded = true;
      continue;
    }
    if (line === '' || /^[ +\-]/.test(line)) {
      chunkStarted = true;
      chunkHasLines = true;
      continue;
    }
    throw new Error('invalid update line at line ' + (i + 1));
  }
  throw new Error('patch has no end marker');
}

module.exports = { patchPaths };
