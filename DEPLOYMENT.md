# Deployment

## Topology

```
Browser ──▶ apps/web (Vercel, Next.js)  ──server-side fetch──▶  apps/api (container host)  ──▶  Postgres
```

`apps/web` is the only thing the browser talks to. Its route handlers under
`app/api/*` proxy server-side to `API_BASE_URL`; the API origin never needs to be
public, and no browser request carries a provider key.

**`apps/api` does not belong on Vercel.** It is a long-lived Nest server — it
calls `app.listen()`, exports no serverless handler, and streams SSE for 20–30
second scoring runs with 15s keepalives. Run it on a container host from
[apps/api/Dockerfile](apps/api/Dockerfile). Railway, Render and Fly all take that
Dockerfile as-is.

---

## 1. Postgres

Any Postgres 16. Neon and Supabase both work, and both need the pooled/unpooled
split below.

- `DATABASE_URL` — **pooled**. Runtime queries, through the driver adapter in
  `PrismaService`.
- `DIRECT_URL` — **unpooled**. Migrations only. They hold advisory locks and
  issue DDL, neither of which survives a transaction-mode pooler.

Pointing `DIRECT_URL` at the pooled URL is the classic first-deploy failure.

## 2. Migrations

The schema must exist **before** the API first boots. An API on an unmigrated
database boots fine and then fails its health check forever: the database
indicator passes (`SELECT 1` needs no tables), and `promptIntegrity` reports
down with `The table public.PromptVersion does not exist`. That is a 503 on
`/health`, which reads as "the API is broken" rather than "nobody ran the
migrations".

Three migrations must apply. The second one,
`20260731000001_database_level_constraints`, carries three constraints that are
not expressible in Prisma schema language and **must never be squashed away**.

**On Railway, this is automatic.** `deploy.preDeployCommand` in
[railway.json](railway.json) runs the migration and the rubric seed on every
deploy, against the platform's own `DATABASE_URL` — so the database never needs
public networking and no connection string ever leaves Railway. Both commands
are safe to repeat: `migrate deploy` applies only what is missing, and the seed
is idempotent by construction (see the header comment in
[prisma/seed/seed.ts](apps/api/prisma/seed/seed.ts)).

This works because railpack keeps devDependencies in the runtime image, so the
`prisma` CLI and `tsx` are both present. **The Dockerfile path cannot do this**:
`pnpm deploy --prod` prunes `prisma`, `dotenv` and `tsx`, and `prisma.config.ts`
reads a repo-root `.env` that does not exist in that container. On Render, Fly
or plain Docker, run it from a checkout instead:

```bash
DIRECT_URL='<unpooled-url>' pnpm --filter @cbd/api prisma:deploy
DIRECT_URL='<unpooled-url>' pnpm --filter @cbd/api seed
```

Note that `<unpooled-url>` must be reachable from wherever you run this. A
platform-internal hostname (`*.railway.internal`, and the equivalents elsewhere)
resolves only inside that network — reaching it from a laptop means exposing the
database publicly first, which is the main reason the Railway path above does it
in-network instead.

The gallery examples are genuinely optional and are not part of the pre-deploy
command:

```bash
DIRECT_URL='<unpooled-url>' pnpm --filter @cbd/api seed:examples
```

## 3. API — container host

Two supported ways in, both building from the **repo root** as context:

- **Railway** — [railway.json](railway.json) supplies the build, pre-deploy and
  start commands, the same way [apps/web/vercel.json](apps/web/vercel.json) does
  for the web app. Railpack builds it; no Dockerfile involved. Config-as-code
  wins over anything set in the dashboard, so the service needs no build or
  start command configured by hand.
- **Render, Fly, or plain Docker** — [apps/api/Dockerfile](apps/api/Dockerfile)
  as-is.

**Whatever runs the build must reach the repo root.** `pnpm --filter @cbd/api
build` on its own fails with ~80 TypeScript errors, because three of its inputs
are git-ignored build artefacts that nothing has produced yet:

| Missing artefact | How it surfaces |
|---|---|
| `packages/contracts/dist` | `TS2307: Cannot find module '@cbd/contracts'` |
| `packages/ai/dist` | `TS2307: Cannot find module '@cbd/ai'` |
| `apps/api/src/generated/prisma` | `TS2307` on `../generated/prisma/client.js`, then `PrismaService extends PrismaClient` resolves to nothing, so every `this.prisma.brief` is a `TS2339` and every inferred callback parameter a `TS7006` |

Only the first three errors are real; the other ~77 are that cascade. They read
like broken source and are not — nothing needs fixing in `src`.

`pnpm turbo run build --filter @cbd/api` produces all three in dependency order,
because [turbo.json](turbo.json) already encodes the graph (`^build` for the two
packages, `prisma:generate` for the client). The Dockerfile spells the same three
steps out longhand.

Health check: `GET /health`. Listens on `PORT` (default 3000).

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Pooled connection string. |
| `DIRECT_URL` | ✅ | Unpooled. Still validated at boot even though only migrations use it. |
| `MASTER_ENCRYPTION_KEY` | ✅ | Exactly 32 bytes, base64 — `openssl rand -base64 32`. Encrypts provider API keys at rest. **Back this up off-platform: losing it means re-entering every provider key, with no recovery path.** |
| `ADMIN_EMAIL` | ✅ | Must be a valid email. |
| `SESSION_SECRET` | ✅ | Min 32 chars. `openssl rand -base64 32`. |
| `CORS_ORIGIN` | ✅ | The web origin, **exactly** — `https://your-app.vercel.app`, no trailing slash. Comma-separated for several. |
| `ADMIN_PASSWORD_HASH` | ➖ | argon2id, from `pnpm --filter @cbd/api hash-password`. Omit and the app boots with admin login refused rather than crashing. Single-quote it — the hash contains `$`. |
| `PORT` | ➖ | Platform-injected. Defaults to 3000. |
| `NODE_ENV` | ➖ | Set `production`; switches the logger to JSON. |
| `AI_BOOTSTRAP_PROVIDER` / `_API_KEY` / `_MODEL` | ➖ | First-boot provider seed. **All three or none** — a partial triple fails validation on purpose. Skip entirely if you'll add the key through the admin panel. |
| `WARM_CACHE_ON_BOOT` | ➖ | `true`/`false`, default `false`. |

No provider API key is required at boot. A fresh deploy comes up
healthy-but-degraded and reports `NO_ACTIVE_PROVIDER` until an admin configures
one in the panel.

## 4. Web — Vercel

Create the project with **Root Directory = `apps/web`**.
[apps/web/vercel.json](apps/web/vercel.json) already supplies the build and
install commands, which reach up to the repo root so the workspace packages
build first.

| Variable | Required | Notes |
|---|---|---|
| `API_BASE_URL` | ✅ | The API's public origin, no trailing slash. Server-only — never `NEXT_PUBLIC_*`, or the browser would talk to the API directly and bypass the proxy. |
| `SESSION_SECRET` | ✅ | 32 bytes base64. Encrypts the admin session cookie (AES-256-GCM). Independent of the API's cookie, but using the same value is fine and simplest. |
| `NEXT_PUBLIC_APP_URL` | ➖ | The web app's own origin. OG metadata on shared `/d/<publicId>` links. |

`API_BASE_URL` must not point at the web app itself — [lib/api.ts](apps/web/lib/api.ts)
has an `assertNotSelf` guard that fails loudly rather than letting every API call
404 against the proxy.

## 5. Order of operations

1. Provision Postgres; note the pooled and unpooled URLs.
2. Apply migrations with `DIRECT_URL`.
3. Deploy the API. Set `CORS_ORIGIN` to the web origin you're about to use.
4. Deploy the web app with `API_BASE_URL` set to the API origin.
5. Hit `GET /health` on the API, then load the web app.
6. Sign in at `/admin` and add a provider key.

If the web origin changes (a new Vercel preview domain, a custom domain), update
`CORS_ORIGIN` on the API — otherwise the browser sees CORS failures that look
like the API being down.

## Note on the existing Vercel setup

The `creative-brief-doctor-api` Vercel project was building `apps/api` into a
serverless function. That is what produced the `FUNCTION_INVOCATION_FAILED`
crashes. Delete or disconnect it — the API belongs on the container host, and
`/` on the API serves JSON and SSE, never HTML, so it would never have shown a
UI even once healthy.
