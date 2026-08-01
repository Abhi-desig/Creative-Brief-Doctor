import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * e2e tests run against the TEST database, never the dev one — the suite
 * truncates every table between files.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: path.join(root, '.env'), quiet: true });

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for e2e tests.');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DIRECT_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
