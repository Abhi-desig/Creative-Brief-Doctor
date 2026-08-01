import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHarness, reset, seedRubric, type Harness } from './harness.js';
import { KeyVaultService, toPrismaBytes } from '../src/ai/key-vault.service.js';

/**
 * One regression test per production-breaking bug the existing suite did not
 * catch.
 *
 * Every one of these passed a green suite before it was fixed, which is the point
 * of collecting them in one file: they are a record of what this suite was blind
 * to, not merely more coverage. Three blind spots recur:
 *
 *   - Nothing sent the SAME request twice. A tier that 429s on the sixth call
 *     looks perfect to a test that calls once.
 *   - Nothing varied the client IP, so per-IP behaviour was untestable.
 *   - The streaming tests buffered the whole response and asserted with
 *     `toContain`, which cannot see ordering or timing.
 */

let harness: Harness;

/** Distinct source IPs. `trust proxy` is on, so this actually separates buckets. */
const ip = (n: number) => `203.0.113.${n}`;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

describe('A1 — /health is not rate limited', () => {
  it('answers 20 consecutive probes from one IP', async () => {
    /**
     * `@SkipThrottle()` with no argument writes a skip for a tier named `default`,
     * and the guard only reads skips for CONFIGURED tiers. None of ours is called
     * `default`, so all four governed /health and the tightest — adminLogin, 5 per
     * 15 minutes — 429'd the 6th probe and stayed 429 for the window. A platform
     * health check on a 10-30s interval died inside two minutes and never
     * recovered, which is exactly the restart loop the degraded-not-down design
     * exists to prevent.
     *
     * Sequential and from ONE IP on purpose: the bug needs repetition against a
     * single bucket to appear at all.
     */
    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const response = await request(harness.server)
        .get('/health')
        .set('x-forwarded-for', ip(10));
      statuses.push(response.status);
    }

    expect(statuses.filter((s) => s === 429)).toEqual([]);
    // 200 or 503 are both legitimate health answers; 429 is never one.
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
  });
});

describe('A2 — the shareable report is not throttled like a scoring call', () => {
  it('serves 30 consecutive GETs of one report', async () => {
    /**
     * The report GET inherited the class's `diagnose` tier: 10 per HOUR, the
     * budget for spending a generation, applied to a plain read that spends
     * nothing. This endpoint exists precisely so any stakeholder can open the
     * link, and it was capped at ten opens an hour.
     */
    const brief = await harness.prisma.brief.create({
      data: { publicId: 'report-throttle-test', rawText: 'x'.repeat(200), charCount: 200 },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const response = await request(harness.server)
        .get(`/v1/briefs/${brief.publicId}`)
        .set('x-forwarded-for', ip(11));
      statuses.push(response.status);
    }

    expect(statuses.filter((s) => s === 429)).toEqual([]);
    expect(new Set(statuses)).toEqual(new Set([200]));
  });

  it('still throttles actual scoring at the diagnose tier', async () => {
    /**
     * Guards the fix against overcorrection, and this is the more important half.
     * If `diagnose` had simply been dropped from the controller, the test above
     * would pass and PUBLIC SCORING WOULD BE UNLIMITED — every visitor free to
     * exhaust a shared free-tier quota. The read is exempt; the write is not.
     */
    const statuses: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      const response = await request(harness.server)
        .post('/v1/briefs')
        .set('x-forwarded-for', ip(20))
        .send({ text: 'A brief long enough to pass DTO validation for throttle testing.' });
      statuses.push(response.status);
    }

    // 10 per hour, so the 11th onwards must be refused.
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
  });
});

describe('A3 — admin routes are not governed by the wrong tier', () => {
  it('allows more than 5 session checks in a row', async () => {
    /**
     * `adminLogin` (5 per 15 minutes) governed `logout` and `session` as well as
     * `login`, so the sixth session check locked an admin out of their own panel
     * for a quarter of an hour.
     */
    const login = await request(harness.server)
      .post('/v1/admin/auth/login')
      .set('x-forwarded-for', ip(12))
      .send({ email: 'admin@example.com', password: 'correct-horse-battery-staple' });
    expect(login.status).toBe(200);
    const bearer = (login.body as { bearer: string }).bearer;

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await request(harness.server)
        .get('/v1/admin/auth/session')
        .set('x-forwarded-for', ip(12))
        .set('authorization', `Bearer ${bearer}`);
      statuses.push(response.status);
    }

    expect(statuses.filter((s) => s === 429)).toEqual([]);
    expect(new Set(statuses)).toEqual(new Set([200]));
  });

  it('still brute-force limits login itself', async () => {
    /**
     * The counterpart to the test above, and the one that matters more.
     * `login` opts back INTO `adminLogin` with an explicit `@SkipThrottle({
     * adminLogin: false })`, because a handler-level skip overrides the
     * class-level one — without that line, relaxing the class would have silently
     * removed brute-force protection from the only route that takes a password.
     */
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await request(harness.server)
        .post('/v1/admin/auth/login')
        .set('x-forwarded-for', ip(13))
        .send({ email: 'admin@example.com', password: 'wrong-password' });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
    // And it must bite within the configured 5, not eventually.
    expect(statuses.indexOf(429)).toBeLessThanOrEqual(5);
  });

  it('allows sustained polling of the admin status card', async () => {
    // `promptTest` (20/hour, meant for live model runs) governed every admin
    // read, so a status page refreshing once a minute went dead after 20 minutes.
    const login = await request(harness.server)
      .post('/v1/admin/auth/login')
      .set('x-forwarded-for', ip(14))
      .send({ email: 'admin@example.com', password: 'correct-horse-battery-staple' });
    const bearer = (login.body as { bearer: string }).bearer;

    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const response = await request(harness.server)
        .get('/v1/admin/status')
        .set('x-forwarded-for', ip(14))
        .set('authorization', `Bearer ${bearer}`);
      statuses.push(response.status);
    }

    expect(statuses.filter((s) => s === 429)).toEqual([]);
  });
});

describe('A4 — an unbuildable provider degrades rather than 500ing', () => {
  it('reports /health as degraded when the active provider has no adapter', async () => {
    /**
     * `buildAdapter` throws for ANTHROPIC, and it was called OUTSIDE the try/catch
     * that degrades an unreadable credential — so a single env var
     * (`AI_BOOTSTRAP_PROVIDER=anthropic` is accepted by the schema) turned
     * /health, requireActive, QuotaService and the admin status page into 500s,
     * with no way to reach the panel to fix it.
     *
     * Uses the REAL SettingsService rather than the harness's fake registry,
     * because the fake is exactly what stands in for the code under test here.
     */
    await reset(harness.prisma);
    await seedRubric(harness.prisma);

    const provider = await harness.prisma.aiProvider.create({
      data: { kind: 'ANTHROPIC', label: 'Anthropic (no adapter)' },
    });
    /**
     * A readable credential must exist, or resolution stops one step earlier at
     * NO_CREDENTIAL and never reaches `buildAdapter` — the test would pass while
     * exercising none of the code it exists to cover.
     */
    const vault = harness.app.get(KeyVaultService);
    const sealed = vault.seal('sk-ant-not-a-real-key', provider.id);
    await harness.prisma.aiProvider.update({
      where: { id: provider.id },
      data: {
        keyCiphertext: toPrismaBytes(sealed.keyCiphertext),
        keyIv: toPrismaBytes(sealed.keyIv),
        keyTag: toPrismaBytes(sealed.keyTag),
        keyLast4: sealed.keyLast4,
      },
    });
    await harness.prisma.appSetting.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        activeProviderId: provider.id,
        activeModel: 'claude-opus-5',
        updatedBy: 'test',
      },
      update: { activeProviderId: provider.id, activeModel: 'claude-opus-5' },
    });
    harness.settings.invalidate();

    const resolved = await harness.settings.resolve();
    expect(resolved.degradedReason).toBe('PROVIDER_UNAVAILABLE');
    expect(resolved.provider).toBeNull();

    const response = await request(harness.server)
      .get('/health')
      .set('x-forwarded-for', ip(15));

    // The contract: never a 500. Degraded is a working answer.
    expect(response.status).not.toBe(500);
    expect(['degraded', 'ok', 'error']).toContain(
      (response.body as { status: string }).status,
    );
  });
});

describe('C — the scoring event arrives before the model call resolves', () => {
  it('emits `scoring` while generation is still in flight, not after it', async () => {
    /**
     * ORDERING AND TIMING, asserted with timestamps rather than `toContain`.
     *
     * `runStreaming` used to push the `scoring` event into an array from inside
     * `onFirstToken` and drain it after `await run(...)` returned — a callback
     * nested in an await cannot yield from the enclosing generator. The client sat
     * on "Reading the brief" for the whole generation and then received scoring,
     * saving and result within milliseconds of each other.
     *
     * The old code produced an IDENTICAL event sequence, so every order-only
     * assertion passed against it. What distinguishes the two is when `scoring`
     * arrives relative to the model finishing — hence the deliberate delay in the
     * provider below and the elapsed-time assertion.
     */
    await reset(harness.prisma);
    await seedRubric(harness.prisma);

    const { FakeProvider } = await import('@cbd/ai');
    /**
     * `latencyMs` is applied TWICE by the fake's streaming path: once before it
     * yields `first-token`, and again inside `generateStructured` before the
     * result. So first-token lands at ~LATENCY and the result at ~2x LATENCY,
     * giving a window of LATENCY ms in which `scoring` must arrive.
     */
    const LATENCY = 400;
    harness.registry.provider = new FakeProvider({ latencyMs: LATENCY });

    const created = await request(harness.server)
      .post('/v1/briefs')
      .set('x-forwarded-for', ip(16))
      .send({ text: 'A brief that is comfortably long enough to pass validation. '.repeat(3) });
    expect(created.status).toBe(201);
    const publicId = (created.body as { publicId: string }).publicId;

    const startedAt = Date.now();
    const arrivals: { event: string; at: number }[] = [];

    await new Promise<void>((resolve, reject) => {
      const req = request(harness.server)
        .get(`/v1/briefs/${publicId}/diagnose/stream`)
        .set('x-forwarded-for', ip(16))
        .set('Accept', 'text/event-stream')
        .buffer(false)
        .parse((res, done) => {
          res.on('data', (chunk: Buffer) => {
            // Timestamped AS THEY ARRIVE. Buffering the stream and parsing it at
            // the end — what the existing suite does — destroys exactly the
            // information this test needs.
            for (const line of chunk.toString('utf8').split('\n')) {
              const match = /^event:\s*(.+)$/.exec(line.trim());
              if (match) arrivals.push({ event: match[1]!, at: Date.now() - startedAt });
            }
          });
          res.on('end', () => done(null, null));
          res.on('error', done);
        });
      req.end((error) => (error ? reject(error) : resolve()));
    });

    const result = arrivals.find((a) => a.event === 'result');
    expect(result, 'the stream produced no result frame').toBeDefined();

    // The `reading` status is emitted immediately, so the SECOND status frame is
    // `scoring` — the one that used to be stranded behind the await.
    const statuses = arrivals.filter((a) => a.event === 'status');
    expect(statuses.length, 'expected reading, scoring and saving').toBeGreaterThanOrEqual(3);
    const scoring = statuses[1]!;

    /**
     * The load-bearing assertion, and the only one that separates the fixed
     * implementation from the broken one. Under the old code `scoring` was
     * drained after `await run(...)` and therefore arrived within a millisecond or
     * two of `result`, at ~2x LATENCY. It should now arrive around 1x LATENCY.
     *
     * The midpoint is a generous threshold: it tolerates a slow CI box while
     * still failing hard against drain-after-await.
     */
    expect(
      scoring.at,
      `scoring arrived at ${scoring.at}ms and result at ${result!.at}ms — `
      + 'scoring should arrive DURING generation, not after it',
    ).toBeLessThan(result!.at - LATENCY / 2);
  });
});

describe('A7 — a truncated stream is distinguishable from success', () => {
  it('produces an error frame rather than a silent end when scoring fails', async () => {
    /**
     * The client-side half of this lives in `lib/sse-client.ts`, which now tracks
     * `sawResult` and throws when a stream ends without one. This asserts the
     * server's side of the same contract: a failure is a terminal `event: error`
     * frame, never a stream that simply stops. An EventSource treats a dropped
     * connection as something to RECONNECT to, so an unmapped error would
     * silently re-run the whole diagnosis.
     */
    await reset(harness.prisma);
    await seedRubric(harness.prisma);

    const { FakeProvider } = await import('@cbd/ai');
    harness.registry.provider = new FakeProvider({ failWith: 'rate_limit' });

    const created = await request(harness.server)
      .post('/v1/briefs')
      .set('x-forwarded-for', ip(17))
      .send({ text: 'Another brief that is long enough to pass DTO validation. '.repeat(3) });
    const publicId = (created.body as { publicId: string }).publicId;

    const response = await request(harness.server)
      .get(`/v1/briefs/${publicId}/diagnose/stream`)
      .set('x-forwarded-for', ip(17))
      .set('Accept', 'text/event-stream');

    expect(response.text).toContain('event: error');
    expect(response.text).not.toContain('event: result');

    harness.registry.provider = new FakeProvider();
  });
});
