# The web app. `docker compose up` uses this; see "Self-hosting with Docker" in
# the README. Railway does not: it builds with Railpack from `railway.json`.
#
# Debian rather than Alpine because Prisma's schema pins `debian-openssl-3.0.x`
# as its deploy engine, and that is what this image provides.
FROM oven/bun:1.3-slim AS base
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Build: every dependency, dev included, because the build needs TypeScript and
# Tailwind.
# ---------------------------------------------------------------------------
FROM base AS build

# `prisma/` before the install: `postinstall` runs `prisma generate`.
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

COPY . .

# The bucket's origin goes into the Content-Security-Policy, which Next compiles
# into the build. Without it attachments upload and then refuse to render. A
# build ARG is visible to RUN as an environment variable, which is all
# `next.config.ts` needs.
ARG S3_ENDPOINT=""
ENV NEXT_TELEMETRY_DISABLED=1
# The build cache is ~400 MB and only speeds up the next build, which never
# happens inside this image.
RUN bun run build && rm -rf .next/cache

# ---------------------------------------------------------------------------
# Runtime: production dependencies only. `prisma` is one of them on purpose --
# migrations run from this image on start.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000

COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile --production

COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.ts ./next.config.ts

USER bun
EXPOSE 3000

# Migrations first, so a new image never serves against an old schema. `exec`
# replaces the shell with the server, so `docker stop`'s signal reaches it.
CMD ["sh", "-c", "bun run db:deploy && exec bun run start"]
