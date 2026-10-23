# Self-hosting

## Self-hosting with Docker

`docker-compose.yml` runs four things: the app, Postgres 16, a tiny scheduler that triggers reminders and recurring tickets once a minute, and (behind the `mailpit` profile) a local inbox for trying it out. Migrations are applied every time the app container starts, so upgrading is a pull and a rebuild.

1. Copy the template and fill it in. Every variable is explained inline.

   ```bash
   cp .env.docker.example .env
   ```

   The ones that matter:

   | Variable | What to set |
   | --- | --- |
   | `POSTGRES_PASSWORD` | A long random string. Read only when the database volume is first created. |
   | `APP_URL` | The public URL, e.g. `https://flone.example.com`. Every emailed link is built from it. |
   | `EMAIL_FROM` + `SMTP_*` *or* `RESEND_API_KEY` | Email is required: an account cannot sign in until its address is confirmed. |
   | `CRON_SECRET` | Any random string. Without it reminders and recurring tickets never run. |
   | `S3_*` | Optional, for image attachments. Any private S3-compatible bucket. |

2. Start it:

   ```bash
   docker compose up -d
   ```

3. Put it behind HTTPS. The app listens on `PORT` (default `3000`) over plain HTTP, and in production its session cookie is `Secure`, so browsers only keep it over HTTPS or on `localhost`. Any reverse proxy works. With [Caddy](https://caddyserver.com), the whole config is:

   ```
   flone.example.com {
     reverse_proxy localhost:3000
   }
   ```

4. Register. The first account becomes the site administrator, and can close public registration from `/admin`.

**Upgrading:** `git pull && docker compose up -d --build`. **Backups:** everything lives in Postgres (plus the bucket, if you use attachments): `docker compose exec db pg_dump -U flone flone > flone.sql`.

**Attachments behind Docker:** images are served by redirecting the browser to a short-lived signed URL on the bucket, so `S3_ENDPOINT` must be reachable from people's browsers as well as from the container. Its origin is also compiled into the Content-Security-Policy, so rebuild (`--build`) after changing it.

## Deploying to Railway

**One click:** [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/flone) creates the app, Postgres and the reminders cron service, wired together. You fill in the email settings on the deploy screen. The steps below are the same setup by hand.

One service running the Next.js app, one Postgres database, and an optional cron service for reminders, all in the same project. Railway builds the app from the root `Dockerfile`, which it always prefers when one exists, and that image applies migrations before it starts, so the dashboard needs no build or start command — only the health check path, `/login`.

`railway.json` is Railway's older Config as Code format. Railway now reads it only for services created before IaC replaced it, and stops reading it on 2026-12-01; a new service ignores it.

**Commit your migrations first.** The container runs `prisma migrate deploy` on start, which only *applies* migrations that already exist in `prisma/migrations/` — it never creates them. Run `bun run db:migrate` locally and commit the generated folder before your first deploy, or the container will start against an empty database and every request will fail.

`prisma` is a runtime dependency rather than a dev dependency on purpose: the runtime image installs production dependencies only, and `prisma migrate deploy` runs from it on every start.

1. Create a Railway project and point it at this repository (or run `railway init` and `railway up` from the repo root).
2. In that project, add a database: **New → Database → Add PostgreSQL**.
3. On the **app service**, open **Variables** and add a reference variable so the app always reads the database's current credentials rather than a copied-and-pasted snapshot:

   ```bash
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

   If you renamed the database service, replace `Postgres` with its name.
4. On the same **Variables** tab, add the three email variables:

   ```bash
   RESEND_API_KEY=re_...
   EMAIL_FROM=Flone <no-reply@yourdomain.com>
   APP_URL=https://your-flone.example.com
   ```

   `EMAIL_FROM`'s domain must be verified in Resend first, or every send is rejected. `APP_URL` must be the public origin with no trailing path — it is what every emailed link is built from, and it is deliberately not taken from the request. Set it *before* the first real signup: with a key present but `APP_URL` missing, the app logs `[email] not_configured` and sends nothing, so nobody can confirm an address.
5. Optional, for image attachments: add a bucket with **New → Storage → Bucket**, name it `flone-attachments`, and add five more reference variables on the app service:

   ```bash
   S3_BUCKET=${{flone-attachments.BUCKET}}
   S3_ENDPOINT=${{flone-attachments.ENDPOINT}}
   S3_REGION=${{flone-attachments.REGION}}
   S3_ACCESS_KEY_ID=${{flone-attachments.ACCESS_KEY_ID}}
   S3_SECRET_ACCESS_KEY=${{flone-attachments.SECRET_ACCESS_KEY}}
   ```

   Keep the bucket **private** — the app never publishes an object URL, and a public bucket would make every screenshot in every organization readable by link. `S3_ENDPOINT` is read at *build* time as well as at runtime, because the endpoint's origin has to be in the page's `img-src`: a CSP fetch directive is re-checked on every redirect hop, and the serve route is a redirect. Adding these variables triggers a redeploy, which is what puts the origin in the header — if images ever come back blocked with a console CSP violation and no server error, that build did not have the variable. Any S3-compatible bucket works (R2, B2, MinIO, S3); there is no SDK to configure.
6. Under **Settings → Deploy**, set the health check path to `/login`, then deploy. Railway builds the root `Dockerfile`; the container runs `prisma migrate deploy` and then `bun run start`, so a new version never serves against an old schema.
7. Under **Settings → Networking**, generate a public domain. Railway injects `PORT` and `next start` listens on it, so the domain's **target port must be that injected value** (usually 8080), not the image's fallback of 3000. The deploy log's `Local: http://localhost:<port>` line shows which it is. A mismatch surfaces as a 502 from the Railway edge even though the container is healthy.
8. For reminders and recurring tickets, add a `CRON_SECRET` variable on the app service (`openssl rand -base64 32`), then a second service from this repository with root directory `services/cron`, cron schedule `*/5 * * * *`, no start command and no public domain. Give it two reference variables:

   ```bash
   CRON_SECRET=${{flone.CRON_SECRET}}
   APP_URL=${{flone.APP_URL}}
   ```

   Replace `flone` with your app service's name. See [`services/cron`](../services/cron/README.md).

The health check hits `/login`, which renders without a session and without a database round-trip, so a slow or unavailable database does not cause a restart loop while the app itself is healthy.

`NODE_ENV` is set to `production` by the build, and that is what switches the session cookie to the `__Host-` prefix and turns on the `Secure` flag. Do not override it.
