import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  GEMINI_TEST_KEY,
  createHarness,
  freshIp,
  loginAsAdmin,
  reset,
  seedRubric,
  type Harness,
} from './harness.js';

/**
 * Verification step 3, admin half.
 *
 * The two load-bearing assertions: a POSTed key is absent from every subsequent
 * GET body, and every mutation writes an audit row with secrets redacted.
 */

let h: Harness;
let auth: Awaited<ReturnType<typeof loginAsAdmin>>;

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
  auth = await loginAsAdmin(h.server);
});

const authed = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
  request(h.server)[method](path)
    .set('Authorization', `Bearer ${auth.bearer}`)
    .set('X-CSRF-Token', auth.csrf)
    .set('Cookie', auth.cookie)
    .set('Origin', 'http://localhost:3001')
    .set('X-Forwarded-For', freshIp());

describe('authentication', () => {
  it('returns 401 for unauthenticated /v1/admin/*', async () => {
    for (const path of ['/v1/admin/providers', '/v1/admin/prompts', '/v1/admin/status']) {
      await request(h.server).get(path).set('X-Forwarded-For', freshIp()).expect(401);
    }
  });

  it('rejects a forged bearer', async () => {
    await request(h.server)
      .get('/v1/admin/providers')
      .set('Authorization', 'Bearer not.a.real.token')
      .set('X-Forwarded-For', freshIp())
      .expect(401);
  });

  it('rejects a tampered signature', async () => {
    const [payload] = auth.bearer.split('.');
    await request(h.server)
      .get('/v1/admin/providers')
      .set('Authorization', `Bearer ${payload}.tamperedsignature`)
      .set('X-Forwarded-For', freshIp())
      .expect(401);
  });

  it('gives ONE generic message for a wrong email and a wrong password', async () => {
    const wrongEmail = await request(h.server)
      .post('/v1/admin/auth/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email: 'nobody@example.com', password: ADMIN_PASSWORD })
      .expect(401);
    const wrongPassword = await request(h.server)
      .post('/v1/admin/auth/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email: ADMIN_EMAIL, password: 'wrong' })
      .expect(401);

    expect(wrongEmail.body.message).toBe(wrongPassword.body.message);
    expect(wrongEmail.body.message).toBe('Invalid credentials.');
  });

  it('has no signup or password-reset route to attack', async () => {
    for (const path of [
      '/v1/admin/auth/signup',
      '/v1/admin/auth/register',
      '/v1/admin/auth/reset',
      '/v1/admin/auth/forgot-password',
      '/v1/admin/users',
    ]) {
      const response = await request(h.server)
        .post(path)
        .set('X-Forwarded-For', freshIp())
        .send({});
      expect([401, 404], `${path} should not exist`).toContain(response.status);
    }
  });

  it('throttles login at the 6th attempt from one IP', async () => {
    const ip = '203.0.113.7';
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const response = await request(h.server)
        .post('/v1/admin/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: ADMIN_EMAIL, password: 'wrong' });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('logout revokes server-side, so the bearer stops working', async () => {
    await authed('get', '/v1/admin/providers').expect(200);
    await request(h.server)
      .post('/v1/admin/auth/logout')
      .set('Authorization', `Bearer ${auth.bearer}`)
      .set('X-Forwarded-For', freshIp())
      .expect(204);
    await authed('get', '/v1/admin/providers').expect(401);
  });

  it('rejects a mutation with a missing or mismatched CSRF token', async () => {
    await request(h.server)
      .post('/v1/admin/providers')
      .set('Authorization', `Bearer ${auth.bearer}`)
      .set('X-Forwarded-For', freshIp())
      .send({ kind: 'GOOGLE', label: 'x', apiKey: GEMINI_TEST_KEY })
      .expect(403);

    await request(h.server)
      .post('/v1/admin/providers')
      .set('Authorization', `Bearer ${auth.bearer}`)
      .set('X-CSRF-Token', 'mismatched')
      .set('Cookie', auth.cookie)
      .set('X-Forwarded-For', freshIp())
      .send({ kind: 'GOOGLE', label: 'x', apiKey: GEMINI_TEST_KEY })
      .expect(403);
  });

  it('rejects a mutation from a foreign Origin', async () => {
    await request(h.server)
      .post('/v1/admin/providers')
      .set('Authorization', `Bearer ${auth.bearer}`)
      .set('X-CSRF-Token', auth.csrf)
      .set('Cookie', auth.cookie)
      .set('Origin', 'https://evil.example.com')
      .set('X-Forwarded-For', freshIp())
      .send({ kind: 'GOOGLE', label: 'x', apiKey: GEMINI_TEST_KEY })
      .expect(403);
  });
});

describe('a POSTed key is absent from EVERY subsequent GET body', () => {
  it('never returns the key, from any endpoint, in any shape', async () => {
    const created = await authed('post', '/v1/admin/providers')
      .send({ kind: 'GOOGLE', label: 'Gemini (free tier)', apiKey: GEMINI_TEST_KEY })
      .expect(201);

    const id = created.body.id as string;

    // The create response itself must not echo it.
    expectNoKey(created.body);
    expect(created.body.keyLast4).toBe(GEMINI_TEST_KEY.slice(-4));

    // Nor must any read.
    const responses = await Promise.all([
      authed('get', '/v1/admin/providers').expect(200),
      authed('get', `/v1/admin/providers/${id}`).expect(200),
      authed('get', '/v1/admin/status').expect(200),
    ]);
    for (const response of responses) expectNoKey(response.body);

    // Nor after a rotation.
    const rotated = await authed('patch', `/v1/admin/providers/${id}`)
      .send({ apiKey: 'AIzaSyD-rotatedKeyValue_zzzzzzzzzzzzz' })
      .expect(200);
    expectNoKey(rotated.body);
    expect(rotated.body.keyVersion).toBe(2);
    expect(rotated.body.keyLast4).toBe('zzzz');

    // And the old key is gone too — overwritten, not archived.
    const afterRotation = await authed('get', `/v1/admin/providers/${id}`).expect(200);
    expect(JSON.stringify(afterRotation.body)).not.toContain(GEMINI_TEST_KEY);

    // There is no reveal endpoint.
    for (const path of [
      `/v1/admin/providers/${id}/key`,
      `/v1/admin/providers/${id}/reveal`,
      `/v1/admin/providers/${id}/secret`,
    ]) {
      const response = await authed('get', path);
      expect([404, 401]).toContain(response.status);
    }

    // The ciphertext IS in the database, and it is not the plaintext.
    const row = await h.prisma.aiProvider.findUniqueOrThrow({ where: { id } });
    expect(row.keyCiphertext).not.toBeNull();
    expect(Buffer.from(row.keyCiphertext!).toString('utf8')).not.toContain(GEMINI_TEST_KEY);
    expect(row.keyIv).toHaveLength(12);
    expect(row.keyTag).toHaveLength(16);
  });

  it('binds the ciphertext to its row, so moving it between providers fails', async () => {
    const a = await authed('post', '/v1/admin/providers')
      .send({ kind: 'GOOGLE', label: 'A', apiKey: GEMINI_TEST_KEY })
      .expect(201);
    const b = await authed('post', '/v1/admin/providers')
      .send({ kind: 'GOOGLE', label: 'B', apiKey: 'AIzaSyD-anotherKey_yyyyyyyyyyyyyyy' })
      .expect(201);

    const rowA = await h.prisma.aiProvider.findUniqueOrThrow({ where: { id: a.body.id } });
    // Copy A's credential wholesale onto B — the exact attack the AAD stops.
    await h.prisma.aiProvider.update({
      where: { id: b.body.id },
      data: {
        keyCiphertext: rowA.keyCiphertext,
        keyIv: rowA.keyIv,
        keyTag: rowA.keyTag,
        keyLast4: rowA.keyLast4,
      },
    });

    const result = await authed('post', `/v1/admin/providers/${b.body.id}/test-connection`)
      .send({})
      .expect(201);
    expect(result.body.ok).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain(GEMINI_TEST_KEY);
  });
});

describe('the audit log', () => {
  it('writes a row for every mutation, with the key redacted', async () => {
    const created = await authed('post', '/v1/admin/providers')
      .send({ kind: 'GOOGLE', label: 'Gemini', apiKey: GEMINI_TEST_KEY })
      .expect(201);

    await authed('patch', `/v1/admin/providers/${created.body.id}`)
      .send({ label: 'Gemini renamed' })
      .expect(200);

    const rows = await h.prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => r.action)).toContain('provider.create');
    expect(rows.map((r) => r.action)).toContain('provider.update');

    for (const row of rows) {
      expect(row.actor).toBe(ADMIN_EMAIL);
      const serialised = JSON.stringify({ before: row.before, after: row.after });
      // The whole point: an audit row is a thing you export and hand to someone.
      expect(serialised).not.toContain(GEMINI_TEST_KEY);
      expect(serialised).not.toContain(GEMINI_TEST_KEY.slice(-12));
    }
    // And it recorded that a key WAS supplied, just not what it was.
    const createRow = rows.find((r) => r.action === 'provider.create');
    expect(JSON.stringify(createRow?.before)).toContain('REDACTED');
  });

  it('does not audit reads', async () => {
    await authed('get', '/v1/admin/providers').expect(200);
    expect(await h.prisma.adminAuditLog.count()).toBe(0);
  });

  it('audits a FAILED mutation too', async () => {
    await authed('patch', '/v1/admin/providers/does-not-exist')
      .send({ label: 'x' })
      .expect(404);
    const rows = await h.prisma.adminAuditLog.findMany();
    expect(rows.some((r) => r.action.endsWith('.failed'))).toBe(true);
  });
});

describe('test-connection', () => {
  it('reports failure and marks the provider FAILING on a bad key', async () => {
    const created = await authed('post', '/v1/admin/providers')
      .send({ kind: 'GOOGLE', label: 'Bad key', apiKey: 'AIzaNotARealKey00000000000000000000000' })
      .expect(201);

    const result = await authed('post', `/v1/admin/providers/${created.body.id}/test-connection`)
      .send({})
      .expect(201);

    expect(result.body.ok).toBe(false);
    const row = await h.prisma.aiProvider.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.status).toBe('FAILING');
    expect(row.lastPingAt).not.toBeNull();
  });

  it('refuses an unimplemented provider kind loudly rather than falling back', async () => {
    const created = await authed('post', '/v1/admin/providers')
      .send({ kind: 'ANTHROPIC', label: 'Claude', apiKey: 'sk-ant-placeholder-key-value-here' })
      .expect(201);
    const result = await authed('post', `/v1/admin/providers/${created.body.id}/test-connection`)
      .send({})
      .expect(201);
    expect(result.body.ok).toBe(false);
    expect(JSON.stringify(result.body)).toMatch(/not implemented/i);
  });
});

function expectNoKey(body: unknown): void {
  const serialised = JSON.stringify(body);
  expect(serialised).not.toContain(GEMINI_TEST_KEY);
  // No suffix long enough to be useful, either.
  for (let length = 12; length <= GEMINI_TEST_KEY.length; length += 4) {
    expect(serialised, `leaked a ${length}-char suffix`)
      .not.toContain(GEMINI_TEST_KEY.slice(-length));
  }
  for (const field of ['keyCiphertext', 'keyIv', 'keyTag', 'apiKey']) {
    expect(serialised, `${field} must never be serialised`).not.toContain(`"${field}"`);
  }
}
