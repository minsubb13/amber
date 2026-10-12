// Reading JSON the plugin or a host writes (hook answers, ledger rows, state
// files, CLI output) in the suites and the QA tools. Values stay unknown.
// The strict readers (get, list, text) fail where plain JavaScript would - a
// property read on null or undefined, an array or string method on another
// value - so a check ported from `row.trigger` or `ids.length` keeps failing
// where it failed. The lenient readers (at, textAt, items) stand for `?.`,
// `|| ''` and `|| []` in the code they port.

/** JSON.parse with the result kept unknown. */
export function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

/**
 * value.k1.k2... as JavaScript reads it: a step on null or undefined throws
 * the engine's TypeError; a string has its length; another primitive has no
 * properties the suites read.
 */
export function get(
  value: unknown,
  ...path: readonly (string | number)[]
): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || current === undefined) {
      throw new TypeError(
        `Cannot read properties of ${current === null ? 'null' : 'undefined'} (reading '${String(key)}')`,
      );
    }
    if (typeof current === 'object' || typeof current === 'function') {
      current = Reflect.get(current, key);
    } else if (typeof current === 'string' && key === 'length') {
      current = current.length;
    } else {
      current = undefined;
    }
  }
  return current;
}

/**
 * String(value) the way Array#join writes it (null and undefined give ''),
 * for ports of `x || ''` that go on to be read as text.
 */
export function asText(value: unknown): string {
  return [value].join('');
}

/** value as an array, or the TypeError an array method on it would throw. */
export function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${show(value)} is not an array`);
  }
  return value;
}

/** value as a string, or the TypeError a string method on it would throw. */
export function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${show(value)} is not a string`);
  }
  return value;
}

/** value?.k1?.k2..., or undefined from the first step that is not there. */
export function at(
  value: unknown,
  ...path: readonly (string | number)[]
): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/** The text at a path, or '' where it is absent or not a string. */
export function textAt(
  value: unknown,
  ...path: readonly (string | number)[]
): string {
  const found = at(value, ...path);
  return typeof found === 'string' ? found : '';
}

/** The elements of value when it is an array, else none. */
export function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A short printable form of any value, for assertion messages. */
export function show(value: unknown): string {
  if (typeof value === 'string') return value;
  // JSON.stringify has no text for these three.
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return typeof value;
  }
  return JSON.stringify(value);
}
