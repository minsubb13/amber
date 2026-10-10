// Global type tightening for the Amber sources. External JSON (hook input,
// .amber/*.json, the ledger, transcripts) arrives as unknown and has to pass
// a check before use; Array.isArray narrows to unknown[] instead of any[].
// Later-declared overloads of a merged interface are tried first, so these
// shadow the lib signatures that return any.

interface JSON {
  parse(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown;
}

interface ArrayConstructor {
  isArray(arg: unknown): arg is unknown[];
}
