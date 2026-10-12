// The record a parity run keeps for one product process, or for one call a
// test makes into a plugin module it required (see capture.cts).

export interface FileEffect {
  readonly path: string;
  /** File content (after the process, or before it in `before`), or null when the file is absent. */
  readonly content: string | null;
}

export interface CaptureRecord {
  /** The script under the plugin, or `call <module>#<export>` for a direct call. */
  readonly entry: string;
  /** The arguments: argv, or for a direct call one JSON text of the call's arguments. */
  readonly args: readonly string[];
  readonly cwd: string;
  /** The environment variables Amber reads, null where unset. */
  readonly env: Readonly<Record<string, string | null>>;
  /** What the process found before it ran: the zone's .amber files, the contract they name, and Amber's state files. Empty for a direct call. */
  readonly before: readonly FileEffect[];
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
