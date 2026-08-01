import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createHarness,
  reset,
  seedRubric,
  type Harness,
} from './harness.js';

/**
 * End-to-end coverage for the two features whose wiring the unit tests cannot
 * reach: cost accounting (B2) and the prompt test-draft endpoint (B3).
 *
 * The pricing ARITHMETIC is unit-tested against a stub, which is the right place
 * for it. What that cannot show is whether the calculation is actually connected:
 * `costUsd` was a hardcoded `null` at the one call site for the entire life of the
 * project, and a perfect PricingService with no call site would look identical
 * from a unit test. The assertion that matters here is that a real diagnosis,
 * written by the real service, lands with a real number in the column.
 *
 * The existing diagnosis e2e asserts `costUsd` is null — correct, because no price
 * row is seeded there. That test passes equally against a version with no pricing
 * at all, so it proves nothing about B2.
 */

let harness: Harness;
let bearer: string;
const csrf = 'cost-and-test-csrf';
const ip = '203.0.113.210';

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
  bearer = (login.body as { bearer: string }).bearer;
});

afterAll(async () => {
  await harness?.close();
});

describe('B2 — cost is computed and persisted', () => {
  it('writes a real cost when a price row covers the active model', async () => {
    await reset(harness.prisma);
    await seedRubric(harness.prisma);

    /**
     * The harness's fake registry reports `GOOGLE` / `fake-model-1`, so the price
     * row has to match that pair — a row for any other model would leave costUsd
     * null and the test would pass for the wrong reason.
     */
    await harness.prisma.modelPricing.create({
      data: {
        provider: 'GOOGLE',
        model: 'fake-model-1',
        inputPerMTok: 5,
        outputPerMTok: 25,
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      },
    });

    const created = await request(harness.server)
      .post('/v1/briefs')
      .set('x-forwarded-for', ip)
      .send({ text: 'A brief long enough to pass validation, for a costed run.'.repeat(2) });
    const publicId = (created.body as { publicId: string }).publicId;

    await request(harness.server)
      .get(`/v1/briefs/${publicId}/diagnose/stream`)
      .set('x-forwarded-for', ip)
      .set('Accept', 'text/event-stream');

    const diagnosis = await harness.prisma.diagnosis.findFirst({
      where: { brief: { publicId } },
      select: { costUsd: true, inputTokens: true, outputTokens: true },
    });

    expect(diagnosis).not.toBeNull();
    // The point: not null, and not zero either. A zero would mean the lookup ran
    // and found nothing, which is the failure this is guarding.
    expect(diagnosis!.costUsd).not.toBeNull();
    expect(Number(diagnosis!.costUsd)).toBeGreaterThan(0);

    // And it is arithmetically the right number, not merely a number.
    const expected =
      (diagnosis!.inputTokens / 1_000_000) * 5 + (diagnosis!.outputTokens / 1_000_000) * 25;
    expect(Number(diagnosis!.costUsd)).toBeCloseTo(expected, 6);
  });

  it('surfaces the day\'s spend on the admin status card', async () => {
    // The other half of B2: `spendUsd` could never be anything but null before,
    // because nothing wrote a cost for it to sum.
    const status = await request(harness.server)
      .get('/v1/admin/status')
      .set('x-forwarded-for', ip)
      .set('authorization', `Bearer ${bearer}`);

    expect(status.status).toBe(200);
    const spend = (status.body as { today: { spendUsd: number | null } }).today.spendUsd;
    expect(spend).not.toBeNull();
    expect(spend).toBeGreaterThan(0);
  });

  it('leaves cost null — never zero — when no price row covers the model', async () => {
    await reset(harness.prisma);
    await seedRubric(harness.prisma);
    // Deliberately a row for a DIFFERENT model, so the lookup runs and misses.
    await harness.prisma.modelPricing.create({
      data: {
        provider: 'GOOGLE',
        model: 'some-other-model',
        inputPerMTok: 5,
        outputPerMTok: 25,
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      },
    });

    const created = await request(harness.server)
      .post('/v1/briefs')
      .set('x-forwarded-for', ip)
      .send({ text: 'A brief long enough to pass validation, for an unpriced run.'.repeat(2) });
    const publicId = (created.body as { publicId: string }).publicId;

    await request(harness.server)
      .get(`/v1/briefs/${publicId}/diagnose/stream`)
      .set('x-forwarded-for', ip)
      .set('Accept', 'text/event-stream');

    const diagnosis = await harness.prisma.diagnosis.findFirst({
      where: { brief: { publicId } },
      select: { costUsd: true },
    });
    // A free tier genuinely has no price table. Null says "not priced"; zero
    // would say "this was free", and the two are not the same claim.
    expect(diagnosis!.costUsd).toBeNull();
  });
});

describe('B3 — the prompt test-draft endpoint', () => {
  it('runs a version against a brief and records the run', async () => {
    await reset(harness.prisma);
    const { id: versionId } = await seedRubric(harness.prisma);

    const response = await authed(
      request(harness.server).post(`/v1/admin/prompts/${versionId}/test`),
    ).send({ briefText: 'A brief with more than forty characters to satisfy the DTO floor.' });

    expect(response.status).toBe(200);
    const body = response.body as {
      scores: { overallScore: number };
      rawOutput: string;
      stopReason: string;
      latencyMs: number;
      degradations: unknown[];
    };

    // The whole reason to run a draft: seeing what the model actually said,
    // including its raw text and whatever the engine had to compromise on.
    expect(body.rawOutput.length).toBeGreaterThan(0);
    expect(body.stopReason).toBe('complete');
    expect(body.scores.overallScore).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.degradations)).toBe(true);

    const runs = await harness.prisma.promptTestRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.promptVersionId).toBe(versionId);
    expect(runs[0]!.createdBy).toBe(ADMIN_EMAIL);
  });

  it('writes NO Diagnosis, so a test cannot appear in a public report', async () => {
    // The property that keeps prompt tuning separate from the product: a test run
    // must not surface on /examples, in a device list, or in the diagnosis count.
    const diagnoses = await harness.prisma.diagnosis.count();
    expect(diagnoses).toBe(0);
  });

  it('records a failed run rather than swallowing it', async () => {
    const { FakeProvider } = await import('@cbd/ai');
    const previous = harness.registry.provider;
    harness.registry.provider = new FakeProvider({ failWith: 'rate_limit' });

    const version = await harness.prisma.promptVersion.findFirst({ where: { status: 'ACTIVE' } });
    const before = await harness.prisma.promptTestRun.count();

    const response = await authed(
      request(harness.server).post(`/v1/admin/prompts/${version!.id}/test`),
    ).send({ briefText: 'Another brief with more than forty characters for a failing run.' });

    expect(response.status).toBeGreaterThanOrEqual(400);

    // "This draft makes the model produce unparseable output" is the single most
    // valuable thing a test can report, and it is exactly the case with no result
    // to return — so it has to be persisted or it is lost.
    const after = await harness.prisma.promptTestRun.findMany({ orderBy: { createdAt: 'desc' } });
    expect(after.length).toBe(before + 1);
    expect(after[0]!.error).toContain('rate_limit');
    expect(after[0]!.stopReason).toBe('error');

    harness.registry.provider = previous;
  });

  it('is governed by the promptTest tier, not the class-level skip', async () => {
    /**
     * The tier is 20/hour and this is the one route it was ever meant for — it
     * was applied to every OTHER admin route by omission and to this one not at
     * all. Asserting from a fresh IP so the count starts at zero.
     */
    const version = await harness.prisma.promptVersion.findFirst({ where: { status: 'ACTIVE' } });
    const statuses: number[] = [];

    for (let i = 0; i < 23; i += 1) {
      const response = await request(harness.server)
        .post(`/v1/admin/prompts/${version!.id}/test`)
        .set('x-forwarded-for', '203.0.113.211')
        .set('authorization', `Bearer ${bearer}`)
        .set('x-csrf-token', csrf)
        .set('Cookie', `csrf_token=${csrf}`)
        .send({ briefText: 'A brief with more than forty characters for the throttle check.' });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
    // And it bites at the tier's limit rather than eventually.
    expect(statuses.filter((s) => s !== 429).length).toBeLessThanOrEqual(20);
  });
});
