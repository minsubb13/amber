#!/bin/sh
# Amber hook launcher: resolve node, fail open, make failures visible.
# If node is unavailable the sensor cannot run; leave a breadcrumb so the
# next session opening (S0) and /amber:status can report it.
EVENT="$1"
SELF_DIR="$(dirname "$0")"
AMBER_HOME="${AMBER_HOME:-$HOME/.amber}"

if command -v node >/dev/null 2>&1; then
  exec node "$SELF_DIR/amber-hook.cjs" "$EVENT"
fi

umask 077
mkdir -p "$AMBER_HOME/state" 2>/dev/null
printf '%s node-not-found event=%s\n' "$(date -u +%FT%TZ)" "$EVENT" \
  >> "$AMBER_HOME/state/sensor-failures.log" 2>/dev/null
exit 0
