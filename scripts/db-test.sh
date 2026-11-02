#!/bin/sh
# Runs the DB-backed integration suites serially against the configured
# disposable database (`npm run db:test`; extra arguments pass to vitest).
#
# On macOS the run holds sleep assertions (`caffeinate -i -s`) for its whole
# length. The suite takes minutes and needs no keyboard, so an unattended run
# lets the host sleep mid-file: idle sleep while the display is off, and
# maintenance sleep out of a dark wake, which `-i` alone does not stop (`-s`
# does, on AC power). Suspension freezes the worker and MySQL together; on wake
# vitest's timers fire at once and whichever test or hook was in flight is
# reported as "timed out" — a failure that rotates between unrelated files and
# passes alone. Raising timeouts cannot fix that; staying awake does. On battery
# `-s` is not honoured, so run the suite on AC power.
set -e
cd "$(dirname "$0")/.."

export RUN_DB_TESTS=1
if [ "$(uname -s)" = "Darwin" ] && command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -i -s npx vitest run --no-file-parallelism test/*.integration.test.ts "$@"
fi
exec npx vitest run --no-file-parallelism test/*.integration.test.ts "$@"
