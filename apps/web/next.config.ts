import path from 'node:path';
import type { NextConfig } from 'next';

/* The repository root, so the landing can read the deployment records in packages/contracts. */
const root = path.resolve(process.cwd(), '..', '..');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default config;
