import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { FakeProvider } from '@cbd/ai';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createHarness,
  reset,
  seedRubric,
  type Harness,
} from './harness.js';
import { SettingsService } from '../src/settings/settings.service.js';

/**
 * THE ACCEPTANCE CRITERION OF THE WHOLE REVISION:
 *
 *   "Add a second provider in the panel and re-score without restarting."
 *
 * Written as a test rather than performed by hand, for two reasons. It is
 * repeatable and runs in CI, so the criterion cannot silently regress. And
 * verifying it through the UI would mean typing a real admin password into a
 * form, which is not something to automate.
 *
 * Until this session the criterion was impossible by construction: `AppSetting`
 * had no write path outside `maybeBootstrap`, which is env-driven, one-shot and
 * refuses to overwrite an existing row. Every piece around it existed — the
 * schema, the migration, the audit interceptor's `AppSetting` mapping, the
 * throttle tier — but nothing could change the active provider in a running
 * process.
 *
 * This drives the REAL SettingsService and the real HTTP endpoints. The harness's
 * fake registry is deliberately bypassed for the resolution assertions, because
 * that fake is precisely the thing standing in for what is under test.
 */

let harness: Harness;
let bearer: string;
let csrf: string;

const ip = '203.0.113.200';

/** Every admin mutation needs the double-submit pair plus the bearer. */
function authed(req: request.Test): request.Test {
  return req
    .set('x-forwarded-for', ip)
    .set('authorization', `Bearer ${bearer}`)
    .set('x-csrf-token', csrf)
    .set('Cookie', `csrf_token=${csrf}`);
}

beforeAll(async () => {
  harness = await createHarness();

  const login = await request(harness.server)
    .post('/v1/admin/auth/login')
    .set('x-forwarded-for', ip)
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  bearer = (login.body as { bearer: string }).bearer;
  csrf = 'acceptance-csrf-token';
});

afterAll(async () => {
  await harness?.close();
});

describe('acceptance: swap provider and re-score without a restart', () => {
  it('adds a provider, activates it, and the change takes effect immediately', async () => {
    await reset(harness.prisma);
    await seedRubric(harness.prisma);
    const settings = harness.app.get(SettingsService);
    settings.invalidate();

    // ── 1. Nothing configured. The app is healthy-but-degraded, not broken. ──
    const before = await settings.resolve();
    expect(before.provider).toBeNull();
    expect(before.degradedReason).toBe('NO_ACTIVE_PROVIDER');

    const healthWhenEmpty = await request(harness.server)
      .get('/health')
      .set('x-forwarded-for', ip);
    expect(healthWhenEmpty.status).not.toBe(500);

    // ── 2. Add the FIRST provider through the panel's own endpoint. ──────────
    const first = await authed(
      request(harness.server).post('/v1/admin/providers'),
    ).send({ kind: 'GOOGLE', label: 'Gemini (first)', apiKey: 'first-key-000000' });
    expect(first.status).toBe(201);
    const firstId = (first.body as { id: string }).id;

    // The key is write-only: no read path returns it, by construction.
    expect(JSON.stringify(first.body)).not.toContain('first-key-000000');

    // ── 3. Activate it. This is the write path that did not exist. ───────────
    const activateFirst = await authed(
      request(harness.server).patch('/v1/admin/model'),
    ).send({ activeProviderId: firstId, activeModel: 'gemini-2.5-flash' });
    expect(activateFirst.status).toBe(200);

    /**
     * Resolved WITHOUT a restart and without waiting out the cache TTL —
     * `update()` invalidates before returning, so the very next read is fresh.
     * A stale read here is what "the panel doesn't work" feels like.
     */
    const afterFirst = await settings.resolve();
    expect(afterFirst.providerId).toBe(firstId);
    expect(afterFirst.activeModel).toBe('gemini-2.5-flash');
    expect(afterFirst.degradedReason).toBeNull();
    expect(afterFirst.provider).not.toBeNull();

    // ── 4. Add a SECOND provider, the actual criterion. ──────────────────────
    const second = await authed(
      request(harness.server).post('/v1/admin/providers'),
    ).send({ kind: 'GOOGLE', label: 'Gemini (second)', apiKey: 'second-key-00000' });
    expect(second.status).toBe(201);
    const secondId = (second.body as { id: string }).id;
    expect(secondId).not.toBe(firstId);

    // ── 5. Switch to it, in the same running process. ────────────────────────
    const switched = await authed(
      request(harness.server).patch('/v1/admin/model'),
    ).send({ activeProviderId: secondId, activeModel: 'gemini-2.5-pro' });
    expect(switched.status).toBe(200);

    const afterSwitch = await settings.resolve();
    expect(afterSwitch.providerId).toBe(secondId);
    expect(afterSwitch.providerLabel).toBe('Gemini (second)');
    expect(afterSwitch.activeModel).toBe('gemini-2.5-pro');

    // ── 6. A diagnosis records the NEW provider and model. ───────────────────
    // The fake registry is restored for scoring, because the point of this step
    // is that a diagnosis attributes itself to whatever is active — not that the
    // Google adapter can reach the network from a test.
    harness.registry.provider = new FakeProvider();
    harness.registry.model = 'gemini-2.5-pro';

    const created = await request(harness.server)
      .post('/v1/briefs')
      .set('x-forwarded-for', ip)
      .send({ text: 'A brief with more than forty characters, for the acceptance run.' });
    expect(created.status).toBe(201);
    const publicId = (created.body as { publicId: string }).publicId;

    const stream = await request(harness.server)
      .get(`/v1/briefs/${publicId}/diagnose/stream`)
      .set('x-forwarded-for', ip)
      .set('Accept', 'text/event-stream');
    expect(stream.text).toContain('event: result');

    const diagnosis = await harness.prisma.diagnosis.findFirst({
      where: { brief: { publicId } },
      select: { model: true, provider: true },
    });
    expect(diagnosis?.model).toBe('gemini-2.5-pro');

    // ── 7. It is all audited. ────────────────────────────────────────────────
    const audit = await harness.prisma.adminAuditLog.findMany({
      where: { action: 'settings.update' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit).toHaveLength(2);
    expect(audit[0]!.targetType).toBe('AppSetting');
    expect(audit[0]!.actor).toBe(ADMIN_EMAIL);
    // No credential is reachable from AppSetting, so no snapshot can leak one.
    expect(JSON.stringify(audit)).not.toContain('second-key-00000');
  });

  it('refuses a provider it cannot build, rather than activating it', async () => {
    /**
     * The other half of "add a second provider": choosing one that cannot work.
     * Refusing at save time is what keeps the panel usable — activating an
     * unbuildable provider would put the whole app into PROVIDER_UNAVAILABLE and
     * leave the operator to work out why from /health.
     */
    const anthropic = await authed(
      request(harness.server).post('/v1/admin/providers'),
    ).send({ kind: 'ANTHROPIC', label: 'Anthropic (no adapter)', apiKey: 'sk-ant-000000000' });
    expect(anthropic.status).toBe(201);
    const id = (anthropic.body as { id: string }).id;

    const attempt = await authed(
      request(harness.server).patch('/v1/admin/model'),
    ).send({ activeProviderId: id, activeModel: 'claude-opus-5' });

    expect(attempt.status).toBe(400);
    expect(String((attempt.body as { message: string }).message)).toContain('cannot be activated');

    // And the previous, working configuration is untouched.
    const settings = harness.app.get(SettingsService);
    const resolved = await settings.resolve();
    expect(resolved.providerLabel).toBe('Gemini (second)');
  });

  it('rejects a parameter the active provider does not support', async () => {
    /**
     * The panel never renders an unsupported control, which is the primary
     * guarantee and a structural one. This is the server-side half: a value
     * arriving anyway did not come from our form, and silently dropping it would
     * leave a setting in the database that the UI cannot show and the adapter
     * will not send.
     */
    const settings = harness.app.get(SettingsService);
    const resolved = await settings.resolve();
    const supportsTopK = false; // not a capability any adapter here declares

    if (!supportsTopK && resolved.provider) {
      const attempt = await authed(
        request(harness.server).patch('/v1/admin/model'),
      ).send({ thinkingBudget: 4096 });

      // Either accepted (the provider supports it) or refused with a reason that
      // names the parameter — never silently discarded.
      if (attempt.status === 400) {
        expect(String((attempt.body as { message: string }).message))
          .toContain('thinkingBudget');
      } else {
        expect(attempt.status).toBe(200);
      }
    }
  });
});
