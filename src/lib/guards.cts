// Narrowing helpers for values that arrive as unknown.

/** A non-null object whose properties can be read by name. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `value[key]` for a value parsed from JSON, with JavaScript's own outcome:
 * reading a field of null fails with the engine's TypeError, and a field of
 * a string, number or boolean is absent. Adapters for foreign formats read
 * through this so that a malformed record fails or passes exactly as the
 * hand-written code did.
 */
function readField(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(
      `Cannot read properties of ${String(value)} (reading '${key}')`,
    );
  }
  return isObject(value) ? value[key] : undefined;
}

/**
 * `String(value)` for a value parsed from JSON - what concatenation, regular
 * expression tests and JSON.parse do to a non-string.
 */
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => (item === null || item === undefined ? '' : toText(item)))
      .join(',');
  }
  return '[object Object]';
}

/**
 * `target[key] = value` on a value parsed from JSON, as non-strict JavaScript
 * did it: an object gets the field, a string, number or boolean silently
 * keeps none, and null fails with the engine's TypeError. The state files the
 * hand-written hook rewrote are written through this.
 */
function writeField(target: unknown, key: string, value: unknown): void {
  if (target === null || target === undefined) {
    throw new TypeError(
      `Cannot set properties of ${String(target)} (setting '${key}')`,
    );
  }
  if (isObject(target)) target[key] = value;
}

/** `delete target[key]` on a value parsed from JSON, with the same outcomes. */
function deleteField(target: unknown, key: string): void {
  if (target === null || target === undefined) {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  if (isObject(target)) Reflect.deleteProperty(target, key);
}

export = { isObject, readField, toText, writeField, deleteField };
