// Test names out of node:test's TAP report and the legacy runner's output.

const TEST_LINE = /^\s*(?:not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/;
const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
};

function unescape(name: string): string {
  return name.replace(/\\(.)/g, (_, ch: string) => ESCAPES[ch] ?? ch);
}

/**
 * The name of every test point at any depth. Test points named by a file
 * the run was given (older Node versions report one per file) are left out.
 */
export function tapTestNames(tap: string, files: readonly string[]): string[] {
  const names: string[] = [];
  for (const line of tap.split('\n')) {
    const match = TEST_LINE.exec(line);
    const name = match?.[1];
    if (name === undefined) continue;
    const unescaped = unescape(name);
    if (!files.includes(unescaped)) names.push(unescaped);
  }
  return names;
}

/** The labels of the legacy runner's `PASS <label>` and `FAIL <label>` lines. */
export function runnerTestNames(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('PASS ')) names.push(line.slice('PASS '.length));
    else if (line.startsWith('FAIL ')) names.push(line.slice('FAIL '.length));
  }
  return names;
}
