# Multi-stage build using `pnpm deploy`, which produces a self-contained
# node_modules for one workspace package with no symlinks into the monorepo.
FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /repo

FROM base AS deps
# Only the manifests, so a source change does not invalidate the install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/ai/package.json packages/ai/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @cbd/contracts --filter @cbd/ai build \
 && pnpm --filter @cbd/api exec prisma generate \
 && pnpm --filter @cbd/api build \
 && pnpm deploy --filter @cbd/api --prod /out

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
# Migrations and the seed need the schema and the rubric file at runtime.
COPY --from=build /repo/apps/api/prisma ./prisma
COPY --from=build /repo/apps/api/prisma.config.ts ./prisma.config.ts

USER node
EXPOSE 3000
# tini reaps zombies and forwards SIGTERM, which matters because open SSE
# connections must be closed on shutdown rather than held until the platform
# kills the container.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
