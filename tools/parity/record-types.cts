// The record a parity run keeps for one product process (see capture.cts).

export interface FileEffect {
  readonly path: string;
  /** File content after the process, or null when the file is absent. */
  readonly content: string | null;
}

export interface CaptureRecord {
  readonly entry: string;
  readonly args: readonly string[];
  readonly cwd: string;
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
