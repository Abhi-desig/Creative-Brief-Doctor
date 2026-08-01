import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as argon2 from 'argon2';
import { FakeProvider, type AIProvider } from '@cbd/ai';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { ProviderRegistry, type ActiveProvider } from '../src/ai/provider-registry.service.js';
import { STREAMING_ROUTE_PATTERN } from '../src/common/sse.js';

/**
 * e2e harness.
 *
 * ProviderRegistry is overridden with a FakeProvider-backed stub. No SDK is
 * stubbed, because the engine imports none — overriding this one class is the
 * entire mocking strategy.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'correct-horse-battery-staple';

export interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  settings: SettingsService;
  registry: FakeRegistry;
  server: Server;
  close: () => Promise<void>;
}

/**
 * Stands in for ProviderRegistry. `provider` is swappable per test so a suite can
 * make the model refuse, rate-limit, or vanish entirely without touching the
 * database.
 */
export class FakeRegistry {
  provider: AIProvider | null = new FakeProvider();
  model = 'fake-model-1';
  tokenCeiling = 12_000;
  dailyCallCap = 400;

  async requireActive(): Promise<ActiveProvider> {
    if (!this.provider) {
      const { NoActiveProviderException } = await import(
        '../src/ai/provider-registry.service.js'
      );
      throw new NoActiveProviderException(
        'NO_ACTIVE_PROVIDER',
        'No AI provider is configured yet.',
      );
    }
    return {
      provider: this.provider,
      providerId: 'fake-provider-row',
      providerKind: 'GOOGLE',
      model: this.model,
      settings: {
        maxTokens: 16_000,
        temperature: undefined,
        topP: undefined,
        thinkingBudget: undefined,
        timeoutMs: 120_000,
        maxRetries: 3,
        tokenCeiling: this.tokenCeiling,
        dailyCallCap: this.dailyCallCap,
        costCeilingUsd: 0.5,
      },
      params: { maxTokens: 16_000 },
    };
  }

  async tryActive(): Promise<ActiveProvider | null> {
    return this.provider ? this.requireActive() : null;
  }
}

export async function createHarness(): Promise<Harness> {
  const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  process.env.MASTER_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  process.env.SESSION_SECRET ??= randomBytes(32).toString('base64');
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD_HASH = passwordHash;
  process.env.CORS_ORIGIN = 'http://localhost:3001';
  // Bootstrap must not fire during tests.
  delete process.env.AI_BOOTSTRAP_PROVIDER;
  delete process.env.AI_BOOTSTRAP_API_KEY;
  delete process.env.AI_BOOTSTRAP_MODEL;

  const registry = new FakeRegistry();

  /**
   * Imported HERE, not at the top of the file.
   *
   * `ConfigModule.forRoot()` is evaluated when app.module.ts is imported — it is
   * a decorator argument — so it snapshots the environment at import time. A
   * static import would capture the developer's real .env (a real ADMIN_EMAIL, a
   * real DATABASE_URL) before any of the assignments above had run, and the
   * tests would authenticate against the wrong credentials.
   */
  const { AppModule } = await import('../src/app.module.js');

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    // The one override. Everything else is the real application.
    .overrideProvider(ProviderRegistry)
    .useValue(registry)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: new ConsoleLogger({ logLevels: ['error'] }),
    forceCloseConnections: true,
  });

  // Mirror main.ts for the parts that affect behaviour under test.
  const compression = (await import('compression')).default;
  app.use(
    compression({
      filter: (req, res) => {
        if (STREAMING_ROUTE_PATTERN.test(req.path)) return false;
        if (res.getHeader('Content-Type') === 'text/event-stream') return false;
        return compression.filter(req, res);
      },
    }),
  );

  // Mirrors main.ts: without this the per-IP throttle tiers cannot be tested,
  // because every request would share the same bucket.
  app.set('trust proxy', 1);

  await app.init();

  const prisma = app.get(PrismaService);
  const settings = app.get(SettingsService);
  await reset(prisma);
  await seedRubric(prisma);
  settings.invalidate();

  return {
    app,
    prisma,
    settings,
    registry,
    server: app.getHttpServer() as Server,
    close: async () => {
      await app.close();
    },
  };
}

/** Truncate everything between files. fileParallelism is off, so this is safe. */
export async function reset(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      "FollowUpQuestion", "DimensionScore", "Diagnosis", "Brief",
      "PromptActivation", "PromptTestRun", "PromptVersion", "PromptTemplate",
      "AdminAuditLog", "AppSetting", "AiProvider", "ModelPricing"
    RESTART IDENTITY CASCADE
  `);
}

export async function seedRubric(prisma: PrismaService): Promise<{ id: string; hash: string }> {
  const content = await readFile(
    path.join(HERE, '..', 'prisma', 'seed', 'rubric-v1.md'),
    'utf8',
  );
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');

  const template = await prisma.promptTemplate.upsert({
    where: { key: 'rubric' },
    create: { key: 'rubric', name: 'Brief diagnosis rubric' },
    update: {},
  });
  const version = await prisma.promptVersion.create({
    data: {
      templateId: template.id,
      label: 'v1',
      content,
      contentHash,
      status: 'ACTIVE',
      changeNote: 'seed',
      createdBy: 'system',
      activatedAt: new Date(),
      activatedBy: 'system',
    },
  });
  return { id: version.id, hash: contentHash };
}

/** Logs in and returns the bearer plus a matching CSRF token pair. */
export async function loginAsAdmin(server: Server): Promise<{
  bearer: string;
  csrf: string;
  cookie: string;
}> {
  const request = (await import('supertest')).default;
  // A fresh IP per login: the admin-login tier is 5 per 15 minutes, and a
  // beforeEach that logs in would otherwise exhaust it after five tests.
  const response = await request(server as never)
    .post('/v1/admin/auth/login')
    .set('X-Forwarded-For', freshIp())
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (response.status !== 200) {
    throw new Error(
      `admin login failed with ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }

  const csrf = randomBytes(16).toString('hex');
  return {
    bearer: (response.body as { bearer: string }).bearer,
    csrf,
    cookie: `csrf_token=${csrf}`,
  };
}

export const GEMINI_TEST_KEY = 'AIzaSyD-e2eTestGeminiKey_abcdefghijklmn';

/**
 * A unique client IP per call.
 *
 * The throttler's in-memory store lives for the whole test file, and the
 * diagnose tier is 10 per hour — so tests that are not specifically exercising
 * the throttle must not share a bucket with each other.
 */
let ipCounter = 0;
export function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250 + 1}`;
}
