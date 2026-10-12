// Narrowing helpers for values that arrive as unknown.

/** A non-null object whose properties can be read by name. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export = { isObject };
