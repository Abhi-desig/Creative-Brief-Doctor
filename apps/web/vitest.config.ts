import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the web app's pure logic.
 *
 * The app had NO tests at all until now — every one of the project's ~235 lived
 * in the API, contracts or the AI package. That is how a title-clobbering bug in
 * the device-list hook survived: the whole client surface, including the code
 * that decides what a report's questions are numbered and what the device list
 * remembers, had nothing asserting anything about it.
 *
 * Deliberately NOT a component-rendering setup. No jsdom, no Testing Library, no
 * React renderer — those bring a large surface for little return here. Everything
 * worth testing on this side is a pure function that was previously buried inside
 * a component or a hook, so the fix was to lift those out and test them directly.
 * A rendering harness can come later if there is ever a component whose behaviour
 * cannot be reached that way.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**'],
  },
  resolve: {
    // Mirrors the `@/*` path alias from tsconfig, so tests import exactly the way
    // the app does rather than through a parallel set of relative paths.
    alias: { '@': path.resolve(import.meta.dirname, '.') },
  },
});
