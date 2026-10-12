// The one place the plugin reads the current time.

/** The current time as an ISO 8601 string. */
function isoNow(): string {
  return new Date().toISOString();
}

/** The current time in milliseconds since the epoch. */
function nowMs(): number {
  return Date.now();
}

/** The current time as a Date, for file timestamps. */
function currentDate(): Date {
  return new Date();
}

export = { isoNow, nowMs, currentDate };
