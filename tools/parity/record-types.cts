// The record a parity run keeps for one product process, or for one call a
// test makes into a plugin module it required (see capture.cts).

export interface FileEffect {
  readonly path: string;
  /** File content after the process, or null when the file is absent. */
  readonly content: string | null;
}

/**
 * One input the product took during a run or a call: a file's text, a
 * directory's sorted entries, whether a path exists, the kind of entry a stat
 * found, or a command's stdout, each with its target; `error <code>` where
 * the read threw.
 */
export interface InputRead {
  readonly op: string;
  readonly target: string;
  readonly result: string;
}

export interface CaptureRecord {
  /** The script under the plugin, or `call <module>#<export>` for a direct call. */
  readonly entry: string;
  /** The arguments: argv, or for a direct call one JSON text of the call's arguments. */
  readonly args: readonly string[];
  readonly cwd: string;
  /** The environment variables Amber reads, null where unset. */
  readonly env: Readonly<Record<string, string | null>>;
  /** Every input the product read, in order (see recordReads in capture.cts). */
  readonly reads: readonly InputRead[];
  readonly stdin: string;
  readonly stdout: string;
  readonly stderr: string;
  /** Exit code, or null when the process ended by a signal. */
  readonly exitCode: number | null;
  /** The signal that ended the process, or null. */
  readonly signal: string | null;
  readonly ledger: string;
  readonly state: readonly FileEffect[];
  readonly zone: readonly FileEffect[];
}
