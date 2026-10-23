#!/bin/sh
# One scheduler tick: POST /api/cron/reminders, then exit. Railway's cron runs
# this container on a schedule and skips the next run if this one never ends.
set -eu

: "${APP_URL:?APP_URL is not set}"
: "${CRON_SECRET:?CRON_SECRET is not set}"

exec curl -fsS --retry 3 --retry-delay 5 --max-time 60 -X POST \
  -H "authorization: Bearer ${CRON_SECRET}" \
  "${APP_URL%/}/api/cron/reminders"
