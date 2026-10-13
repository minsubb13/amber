// Runtime checks that turn unknown values (parsed JSON, process output) into
// typed ones without type assertions.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === 'string')
  );
}

export function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
