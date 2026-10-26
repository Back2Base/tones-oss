import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
const migrations = await readD1Migrations('./migrations');
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './workers/ingest/src/index.ts',
      remoteBindings: false,
      miniflare: {
        compatibilityDate: '2026-10-22',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['SAMPLES'],
        workflows: {
          INGEST_WORKFLOW: { name: 'ingest-sample', className: 'IngestSample' },
        },
        bindings: {
          MODEL_EMBED: '@cf/qwen/qwen3-embedding-0.6b',
          AI_GATEWAY_ID: 'style-mcp',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: { include: ['tests/integration/**/*.test.ts'], testTimeout: 30000 },
});
