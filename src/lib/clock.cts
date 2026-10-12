// The one place the plugin reads the current time for its records.

/** The current time as an ISO 8601 string. */
function isoNow(): string {
  return new Date().toISOString();
}

export = { isoNow };
