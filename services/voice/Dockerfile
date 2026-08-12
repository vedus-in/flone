# Railpack does not detect Bun projects, so Railway builds this from a
# Dockerfile -- the method Railway's own Bun guide prescribes. Without it the
# builder provisions Node, and the start command dies with `bun: not found`.
#
# No install step and no lockfile COPY: this service has zero dependencies, and
# `bun install` on an empty dependency list deletes the lockfile it just wrote.
FROM oven/bun:1-alpine

WORKDIR /app

COPY . .

# `index.ts` directly, not `bun run start`: one less process in the tree, so
# Railway's stop signal reaches the server rather than a package-manager shim.
CMD ["bun", "index.ts"]
