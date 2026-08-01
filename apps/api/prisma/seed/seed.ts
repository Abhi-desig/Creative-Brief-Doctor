import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * Loaded here, before the client is constructed.
 *
 * `prisma db seed` reads prisma.config.ts, which loads this file itself — but
 * `pnpm --filter @cbd/api seed` runs `tsx prisma/seed/seed.ts` directly and skips
 * that entirely, leaving DATABASE_URL undefined. The adapter then fell back to a
 * database named after the OS user and failed with "DatabaseDoesNotExist", which
 * points at the wrong problem.
 */
loadEnv({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env'),
  quiet: true,
});

/**
 * Seeds the rubric from apps/api/prisma/seed/rubric-v1.md and the price rows.
 *
 * The file IS the prompt, byte for byte: nothing is stripped, no front matter is
 * parsed, and nothing is interpolated. That is what makes the stored hash
 * reproducible from git, and it is why the boot-time hash check is meaningful.
 *
 * Idempotent. Re-running does not fork a version or change an active one — the
 * trigger would refuse the latter anyway.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUBRIC_PATH = path.join(HERE, 'rubric-v1.md');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main(): Promise<void> {
  const content = await readFile(RUBRIC_PATH, 'utf8');
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');

  const template = await prisma.promptTemplate.upsert({
    where: { key: 'rubric' },
    create: { key: 'rubric', name: 'Brief diagnosis rubric' },
    update: {},
  });

  const existing = await prisma.promptVersion.findUnique({
    where: { templateId_label: { templateId: template.id, label: 'v1' } },
  });

  if (!existing) {
    await prisma.promptVersion.create({
      data: {
        templateId: template.id,
        label: 'v1',
        content,
        contentHash,
        status: 'ACTIVE',
        changeNote: 'Initial rubric, seeded from the Step 0 calibration spike.',
        createdBy: 'system',
        activatedAt: new Date(),
        activatedBy: 'system',
        activations: {
          create: { actor: 'system', reason: 'Initial seed.' },
        },
      },
    });
    console.log(`Seeded rubric v1 (sha256 ${contentHash.slice(0, 12)}, ${content.length} chars).`);
  } else if (existing.contentHash !== contentHash) {
    // The seed file changed after v1 was activated. Do NOT mutate the active
    // version — that is what the trigger forbids and what would break
    // attribution. Fork a draft and let an admin activate it.
    const label = `v1-file-${contentHash.slice(0, 8)}`;
    await prisma.promptVersion.upsert({
      where: { templateId_label: { templateId: template.id, label } },
      create: {
        templateId: template.id,
        label,
        content,
        contentHash,
        status: 'DRAFT',
        changeNote: 'rubric-v1.md changed on disk after v1 was activated.',
        createdBy: 'system',
      },
      update: {},
    });
    console.log(
      `rubric-v1.md no longer matches active v1. Created DRAFT "${label}" instead of `
      + 'mutating the active version. Activate it from /admin/prompts when ready.',
    );
  } else {
    console.log('Rubric v1 already seeded and unchanged.');
  }

  // Price rows. Gemini free tier has no price table, so the absence of a row is
  // correct rather than missing — costUsd stays null and the admin card says
  // "pricing not configured" instead of showing a silent zero.
  const prices = [
    { provider: 'ANTHROPIC' as const, model: 'claude-opus-5', inputPerMTok: 5, outputPerMTok: 25 },
  ];
  for (const price of prices) {
    const effectiveFrom = new Date('2026-01-01T00:00:00Z');
    await prisma.modelPricing.upsert({
      where: {
        provider_model_effectiveFrom: {
          provider: price.provider,
          model: price.model,
          effectiveFrom,
        },
      },
      create: { ...price, effectiveFrom },
      update: {},
    });
  }
  console.log(`Seeded ${prices.length} price row(s).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
