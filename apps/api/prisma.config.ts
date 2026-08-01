import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// The .env lives at the repo root, not next to this file — dotenv's default of
// "cwd/.env" finds nothing when the CLI runs from apps/api.
loadEnv({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

/**
 * Prisma 7 configuration.
 *
 * IMPORTANT CHANGE FROM THE DESIGN DOC: Prisma 7 removed both `url` and
 * `directUrl` from the datasource block in schema.prisma, and `directUrl` no
 * longer exists as a concept at all. The pooled/unpooled split the doc calls for
 * is still necessary on Neon and Supabase — it has just moved:
 *
 *   migrations & introspection  ->  `datasource.url` here, the UNPOOLED url
 *   runtime queries             ->  the driver adapter in PrismaService,
 *                                   constructed with the POOLED url
 *
 * So `DIRECT_URL` is read here and `DATABASE_URL` is read by PrismaService.
 * Pointing this at the pooled URL is the Prisma 7 form of the classic
 * first-deploy failure on Neon.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed/seed.ts',
  },
  datasource: {
    // Unpooled. Migrations hold advisory locks and issue DDL, neither of which
    // survives a transaction-mode pooler.
    url: env('DIRECT_URL'),
  },
});
