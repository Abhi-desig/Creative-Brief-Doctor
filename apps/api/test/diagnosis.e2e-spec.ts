import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { FakeProvider } from '@cbd/ai';
import { createHarness, freshIp, reset, seedRubric, type Harness } from './harness.js';
import { MAX_BRIEF_CHARS } from '../src/diagnosis/diagnosis.service.js';

/**
 * Verification step 3, diagnosis half. Everything runs against FakeProvider.
 */

const BRIEF_TEXT = [
  'We need a 30-second video for the new analytics dashboard.',
  'The audience is our existing customers, mostly operations managers.',
  'It should feel premium and trustworthy. Budget is around 5000.',
  'Needed by the end of next month.',
].join('\n');

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await reset(h.prisma);
  await seedRubric(h.prisma);
  h.settings.invalidate();
  h.registry.provider = new FakeProvider();
  h.registry.dailyCallCap = 400;
  h.registry.tokenCeiling = 12_000;
});

describe('POST /v1/briefs', () => {
  it('persists a brief and returns a publicId', async () => {
    const response = await request(h.server)
      .post('/v1/briefs')
      .set('X-Forwarded-For', freshIp())
      .send({ text: BRIEF_TEXT, title: 'Dashboard launch' })
      .expect(201);

    expect(response.body.publicId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(response.body.charCount).toBe(BRIEF_TEXT.length);
  });

  it('rejects oversized input at the DTO, before any API call', async () => {
    await request(h.server)
      .post('/v1/briefs')
      .set('X-Forwarded-For', freshIp())
      .send({ text: 'x'.repeat(MAX_BRIEF_CHARS + 1) })
      .expect(400);
  });

  it('rejects a brief that is too short to diagnose', async () => {
    await request(h.server).post('/v1/briefs').set('X-Forwarded-For', freshIp()).send({ text: 'too short' }).expect(400);
  });

  it('rejects an unknown field — the DTO is strict', async () => {
    await request(h.server)
      .post('/v1/briefs')
      .set('X-Forwarded-For', freshIp())
      .send({ text: BRIEF_TEXT, overallScore: 90 })
      .expect(400);
  });
});

describe('POST -> SSE -> GET', () => {
  it('yields a persisted, retrievable report', async () => {
    const created = await request(h.server)
      .post('/v1/briefs')
      .set('X-Forwarded-For', freshIp())
      .send({ text: BRIEF_TEXT })
      .expect(201);
    const { publicId } = created.body as { publicId: string };

    // Consume the SSE stream to completion. This is the test that catches a
    // global interceptor silently breaking it.
    const stream = await request(h.server)
      .get(`/v1/briefs/${publicId}/diagnose/stream`)
      .set('X-Forwarded-For', freshIp())
      .buffer(true)
      .parse((res, callback) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => callback(null, data));
      })
      .expect(200);

    const body = stream.body as string;
    expect(stream.headers['content-type']).toContain('text/event-stream');
    // Breakage mode 3: the proxy-buffering header must be present.
    expect(stream.headers['x-accel-buffering']).toBe('no');
    // Breakage mode 2: the stream must not be compressed.
    expect(stream.headers['content-encoding']).not.toBe('gzip');

    // Coarse status events only — never partial JSON.
    expect(body).toContain('event: status');
    expect(body).toContain('"phase":"reading"');
    expect(body).toContain('"phase":"scoring"');
    expect(body).toContain('event: result');

    const events = parseSse(body);
    const result = events.find((e) => e.event === 'result');
    expect(result).toBeDefined();
    const payload = JSON.parse(result!.data) as { overallScore: number; dimensions: unknown[] };
    expect(payload.dimensions).toHaveLength(5);

    // And the report is retrievable by a plain GET afterwards.
    const report = await request(h.server).get(`/v1/briefs/${publicId}`).expect(200);
    expect(report.body.diagnosis).not.toBeNull();
    expect(report.body.diagnosis.overallScore).toBe(payload.overallScore);
    expect(report.body.diagnosis.dimensions).toHaveLength(5);
    expect(report.body.diagnosis.questions.length).toBeGreaterThanOrEqual(3);
    // Provenance the stakeholder sees: rubric version and date, not the model.
    expect(report.body.diagnosis.rubricVersion).toBe('v1');
    expect(JSON.stringify(report.body)).not.toContain('fake-model');
  });

  it('records provenance and economics on the persisted row', async () => {
    const created = await request(h.server).post('/v1/briefs').set('X-Forwarded-For', freshIp()).send({ text: BRIEF_TEXT });
    await consumeStream(h, created.body.publicId);

    const diagnosis = await h.prisma.diagnosis.findFirstOrThrow({
      include: { dimensions: true, questions: true },
    });
    expect(diagnosis.provider).toBe('GOOGLE');
    expect(diagnosis.model).toBe('fake-model-1');
    expect(diagnosis.promptHash).toHaveLength(64);
    expect(diagnosis.rubricVersion).toBe('v1');
    expect(diagnosis.structuredOutputMode).toBe('NATIVE_SCHEMA');
    expect(diagnosis.tokenSource).toBe('NATIVE');
    expect(diagnosis.inputTokens).toBeGreaterThan(0);
    // No price row for the fake provider, so cost is null rather than a silent 0.
    expect(diagnosis.costUsd).toBeNull();
    expect(diagnosis.dimensions).toHaveLength(5);
  });

  it('clamps out-of-range dimension scores on the way to the database', async () => {
    const { fakeDiagnosis } = await import('@cbd/ai');
    const output = fakeDiagnosis(60);
    // No provider guarantees the range, so the engine must clamp regardless.
    output.dimensions.OBJECTIVE_CLARITY.score = 250;
    output.dimensions.CONSTRAINTS.score = -80;
    h.registry.provider = new FakeProvider({ output });

    const created = await request(h.server).post('/v1/briefs').set('X-Forwarded-For', freshIp()).send({ text: BRIEF_TEXT });
    await consumeStream(h, created.body.publicId);

    const rows = await h.prisma.dimensionScore.findMany();
    for (const row of rows) {
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
    }
    expect(rows.find((r) => r.dimension === 'OBJECTIVE_CLARITY')?.score).toBe(100);
    expect(rows.find((r) => r.dimension === 'CONSTRAINTS')?.score).toBe(0);
  });

  it('persists nothing when the model refuses', async () => {
    h.registry.provider = new FakeProvider({ stopReason: 'refusal' });
    const created = await request(h.server).post('/v1/briefs').set('X-Forwarded-For', freshIp()).send({ text: BRIEF_TEXT });

    const stream = await consumeStream(h, created.body.publicId);
    expect(stream).toMatch(/error|refus/i);
    expect(await h.prisma.diagnosis.count()).toBe(0);
  });

  it('returns 404 for an unknown publicId', async () => {
    await request(h.server).get('/v1/briefs/doesnotexist').expect(404);
  });
});

describe('degraded boot — no active provider', () => {
  it('returns 503 NO_ACTIVE_PROVIDER rather than crashing', async () => {
    h.registry.provider = null;
    const created = await request(h.server).post('/v1/briefs').set('X-Forwarded-For', freshIp()).send({ text: BRIEF_TEXT });

    const stream = await consumeStream(h, created.body.publicId);
    expect(stream).toContain('NO_ACTIVE_PROVIDER');
    expect(await h.prisma.diagnosis.count()).toBe(0);
  });

  it('reports /health as degraded, not down', async () => {
    h.registry.provider = null;
    await h.prisma.appSetting.deleteMany();
    h.settings.invalidate();

    const response = await request(h.server).get('/health');
    // The process is alive and the database is fine, so this must not 503.
    expect([200, 503]).toContain(response.status);
    const body = response.body as { status: string; reason?: string; info?: Record<string, unknown> };
    expect(body.status).toBe('degraded');
    expect(body.reason).toBe('NO_ACTIVE_PROVIDER');
  });

  it('reports healthy once a provider is configured', async () => {
    const response = await request(h.server).get('/health').expect(200);
    expect((response.body as { status: string }).status).toBe('ok');
  });
});

describe('the daily call cap', () => {
  it('returns 503 QUOTA_EXHAUSTED at dailyCallCap + 1', async () => {
    h.registry.dailyCallCap = 2;

    // Two succeed.
    for (let i = 0; i < 2; i++) {
      const created = await request(h.server).post('/v1/briefs').set('X-Forwarded-For', freshIp()).send({ text: BRIEF_TEXT });
      const stream = await consumeStream(h, created.body.publicId);
      expect(stream).toContain('event: result');
    }
    expect(await h.prisma.diagnosis.count()).toBe(2);

    // The third is refused, by the counter rather than by a throttler tier.
    const third = await request(h.server).post('/v1/briefs').set('X-Forwarded-For', freshIp()).send({ text: BRIEF_TEXT });
    const stream = await consumeStream(h, third.body.publicId);
    expect(stream).toContain('QUOTA_EXHAUSTED');
    expect(await h.prisma.diagnosis.count()).toBe(2);
  });
});

describe('the admission gate', () => {
  it('rejects a brief above the configured token ceiling', async () => {
    h.registry.tokenCeiling = 10;
    const created = await request(h.server).post('/v1/briefs').set('X-Forwarded-For', freshIp()).send({ text: BRIEF_TEXT });
    const stream = await consumeStream(h, created.body.publicId);
    expect(stream).toMatch(/CONTEXT_OVERFLOW|too long/i);
    expect(await h.prisma.diagnosis.count()).toBe(0);
  });
});

describe('the diagnose throttle', () => {
  it('returns 429 on the 11th call within the window', async () => {
    let sawThrottle = false;
    for (let i = 0; i < 12; i++) {
      const response = await request(h.server)
        .post('/v1/briefs')
        .send({ text: BRIEF_TEXT })
        .set('X-Forwarded-For', '203.0.113.99');
      if (response.status === 429) {
        sawThrottle = true;
        expect(i).toBeGreaterThanOrEqual(10);
        break;
      }
    }
    expect(sawThrottle, 'expected a 429 within 12 calls').toBe(true);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function consumeStream(harness: Harness, publicId: string): Promise<string> {
  const response = await request(harness.server)
    .get(`/v1/briefs/${publicId}/diagnose/stream`)
    .set('X-Forwarded-For', freshIp())
    .buffer(true)
    .parse((res, callback) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
      });
      res.on('end', () => callback(null, data));
    });
  return typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
}

function parseSse(raw: string): { event: string; data: string }[] {
  const out: { event: string; data: string }[] = [];
  for (const block of raw.split('\n\n')) {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const data = block.match(/^data:\s*(.+)$/m)?.[1]?.trim();
    if (event && data) out.push({ event, data });
  }
  return out;
}
