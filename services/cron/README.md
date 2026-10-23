# flone-cron

Calls `POST /api/cron/reminders` once and exits. That endpoint runs both
schedulers, reminders and recurring tickets, and is safe to call at any rate.

Docker Compose does not use this: its `cron` service loops in place. This is
for Railway, where a cron service is a container started on a schedule.

## Railway

A service from this repository with:

| Setting | Value |
| --- | --- |
| Root directory | `services/cron` |
| Cron schedule | `*/5 * * * *` (Railway's minimum interval) |
| Start command | empty, so the image's entrypoint runs |
| Public networking | none |

and two variables, both references to the web service (named `flone` here):

```
CRON_SECRET=${{flone.CRON_SECRET}}
APP_URL=${{flone.APP_URL}}
```

Rotating `CRON_SECRET` on the web service updates this one too, because it is a
reference rather than a copy.

`APP_URL` must be `https://`: the script refuses plain HTTP rather than send
the secret in the clear. Only a `200` counts as a successful run, so a redirect
(say, to a `www.` host) fails visibly instead of silently skipping both
schedulers.

A missing variable fails the run with a message naming it. A `401` means the
two secrets differ; a `503` means the web service has no `CRON_SECRET` at all.
