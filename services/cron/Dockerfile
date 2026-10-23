# The reminders and recurring-tickets trigger, as a Railway cron service. See
# README.md next to this file.
#
# A Dockerfile rather than a start command, because Railway splits a start
# command into argv without a shell: `$CRON_SECRET` would reach curl as those
# literal characters. Here the shell in `tick.sh` expands it at run time, so the
# secret can be an ordinary (reference) variable.
FROM curlimages/curl:8.11.1

COPY tick.sh /tick.sh

# The image's ENTRYPOINT is curl itself; replace it, or the script would be
# passed to curl as an argument. Run through `sh` so no execute bit is needed --
# `COPY --chmod` is BuildKit-only.
ENTRYPOINT ["sh", "/tick.sh"]
