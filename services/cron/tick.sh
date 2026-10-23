#!/bin/sh
# One scheduler tick: POST /api/cron/reminders, then exit. Railway's cron runs
# this container on a schedule and skips the next run if this one never ends.
set -eu

: "${APP_URL:?APP_URL is not set}"
: "${CRON_SECRET:?CRON_SECRET is not set}"

body=$(mktemp)
trap 'rm -f "$body"' EXIT

# HTTPS only: the bearer token must never cross the network in the clear.
# The header arrives on stdin, so the secret is not in curl's argv. Redirects
# are not followed, and only a 200 counts: `-f` alone would call a 3xx success
# while neither scheduler ran.
status=$(printf 'authorization: Bearer %s\n' "$CRON_SECRET" |
  curl -sS --proto '=https' --retry 3 --retry-delay 5 --max-time 60 -X POST \
    -H @- -o "$body" -w '%{http_code}' \
    "${APP_URL%/}/api/cron/reminders") || status="curl-error"

cat "$body"
echo

if [ "$status" != "200" ]; then
  echo "tick failed: HTTP $status" >&2
  exit 1
fi
