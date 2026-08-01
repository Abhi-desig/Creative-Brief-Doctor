import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Nest needs `emitDecoratorMetadata` for DI, which esbuild (vitest's default
 * transformer) does not implement. unplugin-swc supplies it, which is what lets
 * the whole workspace share one test runner instead of adding Jest just here.
 */
const swcPlugin = () => swc.vite({ module: { type: 'es6' } });

export default defineConfig({
  plugins: [swcPlugin()],
  test: {
    globals: true,
    /**
     * e2e files share ONE database and truncate it between tests, so they must
     * run strictly one at a time. This has to be set at the ROOT to take effect —
     * setting it only inside a project is silently ignored, which shows up as
     * one file's TRUNCATE landing in the middle of another's seed and surfacing
     * as a spurious foreign-key or unique violation.
     */
    fileParallelism: false,
    projects: [
      {
        plugins: [swcPlugin()],
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [swcPlugin()],
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e-spec.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          setupFiles: ['test/setup.ts'],
          // One fork for the whole project, so no two files ever hold a
          // connection to the shared test database at the same time.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
