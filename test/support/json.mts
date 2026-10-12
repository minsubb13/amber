// Reading what the plugin writes (hook answers, ledger rows, state files) in
// the suites. Values stay unknown: a path that is not there reads as
// undefined, so the assertion on it fails and names the case.

/** JSON.parse with the result kept unknown. */
export function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

/** value[k1][k2]..., or undefined from the first step that is not there. */
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
