# Quickstart — verifying provider-agnostic configuration

**Feature**: Provider-agnostic AI configuration | **Date**: 2026-08-01

How to confirm the acceptance criterion yourself, and what to look at if it fails.

## The fastest check

```bash
pnpm --filter @cbd/api test:e2e -- acceptance
```

`apps/api/test/acceptance.e2e-spec.ts` performs the criterion end to end: it adds
two providers through the panel's own endpoints, activates each in turn, scores a
brief, and asserts the diagnosis records the second provider's model — all in one
running process. It also asserts the negative cases: an unbuildable provider is
refused and the previous configuration survives.

Written as a test rather than as a manual checklist for two reasons. It runs in
CI, so the criterion cannot silently regress. And verifying it through the browser
means typing a real administrator password into a form, which is not something to
automate.

## By hand, through the panel

```bash
pnpm --filter @cbd/api prisma:deploy
pnpm --filter @cbd/api seed
pnpm dev                      # API on 3000, web on 3001
```

1. Open `http://localhost:3001/admin`. With no session you are redirected to
   `/admin/login`.
2. Sign in with `ADMIN_EMAIL` and the password whose argon2 hash is in
   `ADMIN_PASSWORD_HASH`. (`pnpm --filter @cbd/api hash-password` generates one.)
3. **Providers** → add a Google provider with a real Gemini key. Press *Test
   connection*; the status should become `Working`.
4. **Model** → select that provider. The model list is fetched live from it. Pick
   one and save.
5. Open `http://localhost:3001` in another tab and score a brief. It works, with
   no restart.
6. Return to **Providers**, add a second provider, then **Model** → switch to it
   and save.
7. Score another brief. Check the row:

```bash
psql "$DATABASE_URL" -c 'SELECT provider, model, "createdAt" FROM "Diagnosis" ORDER BY "createdAt" DESC LIMIT 2'
```

The two rows should name different models, with no process restart between them.

## What to look at when it does not work

**The save is refused with "cannot be activated".** Expected for an `ANTHROPIC`
provider — there is no adapter in this build. That is the FR-006 path working.
Select a Google provider.

**The save is refused naming the model.** The provider does not offer that model
id. The error lists what it does offer.

**A parameter you expected is missing from the form.** That is FR-004 working:
the selected provider does not honour it. The *What this provider supports* card
below the form says which ones it does.

**The model list is empty and the field is free text.** The provider's list
endpoint failed. Deliberately not a blocker — enter the model id directly.

**Everything 401s and you are bounced to login.** The session cookie is sealed
with `SESSION_SECRET`. If that value changed, existing cookies no longer decrypt
and every session is invalid. Sign in again.

**`/admin` returns a server error.** Check the Next dev log for an Edge Runtime
complaint. `middleware.ts` runs on the edge and must import cookie names from
`lib/admin-cookies.ts`, never from `lib/admin-session.ts` — the latter pulls in
`node:crypto`, which the edge runtime does not provide, and the middleware then
fails to compile for every route it matches.

**The API cannot find the database.** `.env` lives at the repository root, not in
`apps/api`. `ConfigModule` is pointed at both locations; if you moved it, that is
why.

## Confirming the degraded paths

```bash
# Nothing configured at all.
psql "$DATABASE_URL" -c 'DELETE FROM "AppSetting"'
curl -s localhost:3000/health | jq '.status, .reason'
# → "degraded", "NO_ACTIVE_PROVIDER"  — and NOT a 500
```

The admin panel must remain reachable throughout. That is the property that makes
every other configuration action safe to attempt.
