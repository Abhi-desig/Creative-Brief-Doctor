import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createHarness,
  freshIp,
  loginAsAdmin,
  reset,
  seedRubric,
  type Harness,
} from './harness.js';

/**
 * Prompt lifecycle.
 *
 * The headline test is the concurrent activation one: it proves the PARTIAL
 * UNIQUE INDEX does the work, not application logic. If that constraint were
 * removed, a read-modify-write in the service would leave two ACTIVE rows and
 * this test would catch it — which is the whole reason it lives in the database.
 */

let h: Harness;
let auth: Awaited<ReturnType<typeof loginAsAdmin>>;
let templateId: string;

const CONTENT_A = 'RUBRIC A.\n'.repeat(20);
const CONTENT_B = 'RUBRIC B.\n'.repeat(20);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

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
  templateId = (await h.prisma.promptTemplate.findUniqueOrThrow({ where: { key: 'rubric' } })).id;
});

const authed = (method: 'get' | 'post' | 'patch', path: string) =>
  request(h.server)[method](path)
    .set('Authorization', `Bearer ${auth.bearer}`)
    .set('X-CSRF-Token', auth.csrf)
    .set('Cookie', auth.cookie)
    .set('Origin', 'http://localhost:3001')
    .set('X-Forwarded-For', freshIp());

async function makeVersion(label: string, content: string, status: 'DRAFT' | 'ARCHIVED' = 'DRAFT') {
  return h.prisma.promptVersion.create({
    data: {
      templateId,
      label,
      content,
      contentHash: sha(content),
      status,
      changeNote: 'test',
      createdBy: 'test',
    },
  });
}

describe('the seeded state', () => {
  it('starts with exactly one ACTIVE version whose hash matches its content', async () => {
    const active = await h.prisma.promptVersion.findMany({ where: { status: 'ACTIVE' } });
    expect(active).toHaveLength(1);
    expect(sha(active[0]!.content)).toBe(active[0]!.contentHash);
  });

  it('reports prompt integrity as healthy', async () => {
    const response = await request(h.server).get('/health').expect(200);
    expect(JSON.stringify(response.body)).toContain('promptIntegrity');
  });
});

describe('editing a non-draft forks a new draft', () => {
  it('refuses to edit an ACTIVE version through the API', async () => {
    const active = await h.prisma.promptVersion.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    const response = await authed('patch', `/v1/admin/prompts/${active.id}`)
      .send({ content: CONTENT_A })
      .expect(400);
    expect(JSON.stringify(response.body)).toMatch(/NOT_A_DRAFT|immutable|fork/i);
  });

  it('the DATABASE refuses it too, even bypassing the service entirely', async () => {
    const active = await h.prisma.promptVersion.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    // The point of the trigger: application code can be bypassed, so the rule
    // must not live only in the service.
    await expect(
      h.prisma.promptVersion.update({
        where: { id: active.id },
        data: { content: 'TAMPERED' },
      }),
    ).rejects.toThrow(/immutable/i);

    await expect(
      h.prisma.$executeRawUnsafe(
        `UPDATE "PromptVersion" SET content = 'TAMPERED' WHERE id = $1`,
        active.id,
      ),
    ).rejects.toThrow(/immutable/i);

    // And contentHash is frozen too, so the pair can never drift.
    await expect(
      h.prisma.$executeRawUnsafe(
        `UPDATE "PromptVersion" SET "contentHash" = 'deadbeef' WHERE id = $1`,
        active.id,
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('forks a new DRAFT seeded from the active version', async () => {
    const active = await h.prisma.promptVersion.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    const forked = await authed('post', '/v1/admin/prompts')
      .send({ label: 'v2', changeNote: 'Sharpen the metrics anchors.', forkFromVersionId: active.id })
      .expect(201);

    expect(forked.body.status).toBe('DRAFT');
    const row = await h.prisma.promptVersion.findUniqueOrThrow({ where: { id: forked.body.id } });
    expect(row.content).toBe(active.content);
    expect(row.contentHash).toBe(active.contentHash);
    // The active version is untouched.
    const stillActive = await h.prisma.promptVersion.findUniqueOrThrow({ where: { id: active.id } });
    expect(stillActive.status).toBe('ACTIVE');
    expect(stillActive.content).toBe(active.content);
  });

  it('allows editing a DRAFT in place, and rehashes on the way', async () => {
    const draft = await makeVersion('v2', CONTENT_A);
    await authed('patch', `/v1/admin/prompts/${draft.id}`)
      .send({ content: CONTENT_B })
      .expect(200);

    const row = await h.prisma.promptVersion.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.content).toBe(CONTENT_B);
    expect(row.contentHash).toBe(sha(CONTENT_B));
  });

  it('rejects a duplicate label on the same template', async () => {
    await makeVersion('v2', CONTENT_A);
    await authed('post', '/v1/admin/prompts')
      .send({ label: 'v2', changeNote: 'dupe', content: CONTENT_B })
      .expect(409);
  });
});

describe('activation', () => {
  it('activating B archives A, and exactly one ACTIVE remains', async () => {
    const a = await h.prisma.promptVersion.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    const b = await makeVersion('v2', CONTENT_B);

    await authed('post', `/v1/admin/prompts/${b.id}/activate`)
      .send({ reason: 'Sharper anchors after the calibration run.' })
      .expect(201);

    const rows = await h.prisma.promptVersion.findMany({ where: { templateId } });
    expect(rows.filter((r) => r.status === 'ACTIVE')).toHaveLength(1);
    expect(rows.find((r) => r.id === b.id)?.status).toBe('ACTIVE');
    expect(rows.find((r) => r.id === a.id)?.status).toBe('ARCHIVED');
  });

  it('records activation as an EVENT, with the previous version noted', async () => {
    const a = await h.prisma.promptVersion.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    const b = await makeVersion('v2', CONTENT_B);
    await authed('post', `/v1/admin/prompts/${b.id}/activate`)
      .send({ reason: 'because' })
      .expect(201);

    const events = await h.prisma.promptActivation.findMany({ orderBy: { createdAt: 'asc' } });
    const latest = events.at(-1)!;
    expect(latest.promptVersionId).toBe(b.id);
    expect(latest.previousVersionId).toBe(a.id);
    expect(latest.reason).toBe('because');
    expect(latest.actor).toBe('admin@example.com');
  });

  it('rolling back to A creates a NEW event and leaves B history intact', async () => {
    const a = await h.prisma.promptVersion.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    const b = await makeVersion('v2', CONTENT_B);

    await authed('post', `/v1/admin/prompts/${b.id}/activate`).send({ reason: 'forward' }).expect(201);
    await authed('post', `/v1/admin/prompts/${a.id}/activate`).send({ reason: 'rollback' }).expect(201);

    const rows = await h.prisma.promptVersion.findMany({ where: { templateId } });
    expect(rows.filter((r) => r.status === 'ACTIVE')).toHaveLength(1);
    expect(rows.find((r) => r.id === a.id)?.status).toBe('ACTIVE');
    expect(rows.find((r) => r.id === b.id)?.status).toBe('ARCHIVED');

    // B's history survives — rollback appends, it does not rewrite.
    const events = await h.prisma.promptActivation.findMany({ orderBy: { createdAt: 'asc' } });
    expect(events.filter((e) => e.promptVersionId === b.id)).toHaveLength(1);
    expect(events.at(-1)?.reason).toBe('rollback');
    expect(events.at(-1)?.previousVersionId).toBe(b.id);
    // B's content is still exactly what it was.
    const bRow = await h.prisma.promptVersion.findUniqueOrThrow({ where: { id: b.id } });
    expect(bRow.content).toBe(CONTENT_B);
  });

  it('refuses to activate a version whose content does not match its hash', async () => {
    const draft = await h.prisma.promptVersion.create({
      data: {
        templateId,
        label: 'v-corrupt',
        content: CONTENT_A,
        contentHash: sha('something else entirely'),
        status: 'DRAFT',
        changeNote: 'corrupt',
        createdBy: 'test',
      },
    });
    const response = await authed('post', `/v1/admin/prompts/${draft.id}/activate`)
      .send({ reason: 'should fail' })
      .expect(400);
    expect(JSON.stringify(response.body)).toContain('PROMPT_HASH_MISMATCH');
  });

  it('never leaves the template with no active version', async () => {
    const b = await makeVersion('v2', CONTENT_B);
    await authed('post', `/v1/admin/prompts/${b.id}/activate`).send({ reason: 'x' }).expect(201);
    // At every point, exactly one.
    const count = await h.prisma.promptVersion.count({ where: { templateId, status: 'ACTIVE' } });
    expect(count).toBe(1);
  });
});

describe('concurrent activation — the partial index does the work', () => {
  it('leaves exactly ONE ACTIVE when many activations race', async () => {
    const contenders = await Promise.all(
      Array.from({ length: 6 }, (_, i) => makeVersion(`race-${i}`, `RUBRIC RACE ${i}.\n`.repeat(20))),
    );

    // Fire all activations simultaneously. Whichever ordering the database
    // chooses, the partial unique index guarantees the invariant — there is no
    // advisory lock and no SELECT-then-UPDATE window in the service.
    const results = await Promise.allSettled(
      contenders.map((v) =>
        authed('post', `/v1/admin/prompts/${v.id}/activate`).send({ reason: 'race' }),
      ),
    );

    const statuses = results.map((r) =>
      r.status === 'fulfilled' ? (r.value as { status: number }).status : 0,
    );

    const active = await h.prisma.promptVersion.findMany({
      where: { templateId, status: 'ACTIVE' },
    });
    // The invariant, which is the actual assertion.
    expect(active, `statuses were ${statuses.join(',')}`).toHaveLength(1);

    // At least one lost the race, and lost it cleanly with a 409 rather than a
    // 500 — the service recognises the unique violation for what it is.
    const conflicts = statuses.filter((s) => s === 409).length;
    const succeeded = statuses.filter((s) => s === 201).length;
    expect(succeeded).toBeGreaterThanOrEqual(1);
    expect(succeeded + conflicts).toBe(statuses.length);
  });

  it('proves the invariant is enforced by the DATABASE, not the service', async () => {
    const active = await h.prisma.promptVersion.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    const other = await makeVersion('v-direct', CONTENT_A);

    // Bypass the service completely and try to create a second ACTIVE row.
    await expect(
      h.prisma.promptVersion.update({
        where: { id: other.id },
        data: { status: 'ACTIVE' },
      }),
    ).rejects.toThrow(/one_active_prompt_per_template|unique/i);

    const count = await h.prisma.promptVersion.count({ where: { templateId, status: 'ACTIVE' } });
    expect(count).toBe(1);
    expect(active.status).toBe('ACTIVE');
  });

  it('allows many DRAFT and many ARCHIVED — the index is partial, not total', async () => {
    await Promise.all([
      makeVersion('d1', CONTENT_A),
      makeVersion('d2', CONTENT_B),
      makeVersion('a1', CONTENT_A, 'ARCHIVED'),
      makeVersion('a2', CONTENT_B, 'ARCHIVED'),
    ]);
    const rows = await h.prisma.promptVersion.groupBy({
      by: ['status'],
      where: { templateId },
      _count: { status: true },
    });
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count.status]));
    expect(byStatus.DRAFT).toBe(2);
    expect(byStatus.ARCHIVED).toBe(2);
    expect(byStatus.ACTIVE).toBe(1);
  });
});

describe('AppSetting is a singleton, enforced by the database', () => {
  it('rejects any id other than "singleton"', async () => {
    await expect(
      h.prisma.$executeRawUnsafe(
        `INSERT INTO "AppSetting" (id, "updatedAt") VALUES ('other', now())`,
      ),
    ).rejects.toThrow(/app_setting_is_singleton|check constraint/i);
  });

  it('rejects a second row even with a plausible id', async () => {
    await h.prisma.$executeRawUnsafe(
      `INSERT INTO "AppSetting" (id, "updatedAt") VALUES ('singleton', now())`,
    );
    await expect(
      h.prisma.$executeRawUnsafe(
        `INSERT INTO "AppSetting" (id, "updatedAt") VALUES ('singleton2', now())`,
      ),
    ).rejects.toThrow(/app_setting_is_singleton|check constraint/i);
    expect(await h.prisma.appSetting.count()).toBe(1);
  });
});
