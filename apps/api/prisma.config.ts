import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

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
/**
 * The unpooled URL, resolved without `env()` from prisma/config.
 *
 * `env()` throws while the config file is being LOADED, which happens for every
 * prisma command — including `generate`, which only reads the schema and never
 * opens a connection. That broke two builds that legitimately have no database:
 * the Docker build (`prisma generate` runs between the tsc build and
 * `pnpm deploy`) and CI. Failing there is wrong; failing when something actually
 * tries to connect is right, and Prisma already does that clearly.
 *
 * The fallbacks are the names Neon's Vercel integration injects. Accepting them
 * directly removes a manual aliasing step, and more importantly removes a chance
 * to alias the POOLED url here by mistake — which is the exact first-deploy
 * failure the comment below is about.
 */
function directUrl(): string {
  return (
    process.env.DIRECT_URL
    ?? process.env.DATABASE_URL_UNPOOLED
    ?? process.env.POSTGRES_URL_NON_POOLING
    // Not a real host. `generate` never resolves it; anything that connects
    // fails immediately rather than silently reaching the wrong database.
    ?? 'postgresql://DIRECT_URL-is-not-set/'
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed/seed.ts',
  },
  datasource: {
    // Unpooled. Migrations hold advisory locks and issue DDL, neither of which
    // survives a transaction-mode pooler.
    url: directUrl(),
  },
});
