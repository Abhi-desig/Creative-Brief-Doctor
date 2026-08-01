import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // The monorepo root, not apps/web — otherwise Turbopack infers it from the
  // nearest lockfile and warns about the workspace above.
  turbopack: { root: path.join(__dirname, '..', '..') },
  // packages/contracts ships TypeScript sources into the app build.
  transpilePackages: ['@cbd/contracts'],
  typedRoutes: true,
};

export default nextConfig;
