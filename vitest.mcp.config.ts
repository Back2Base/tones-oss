import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './workers/mcp/src/index.ts',
      remoteBindings: false,
      miniflare: {
        compatibilityDate: '2026-10-22',
        compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
        d1Databases: ['DB'],
        kvNamespaces: ['OAUTH_KV'],
        bindings: {
          PUBLIC_ORIGIN: 'https://tones.example.com',
          MODEL_EMBED: '@cf/qwen/qwen3-embedding-0.6b',
          MODEL_CLASSIFY: '@cf/zai-org/glm-4.7-flash',
          AI_GATEWAY_ID: 'style-mcp',
          AUTH0_DOMAIN: 'auth.example.com',
          AUTH0_CLIENT_ID: 'tones-client',
          AUTH0_CLIENT_SECRET: 'test-secret',
          COOKIE_ENCRYPTION_KEY: 'a'.repeat(43),
          ALLOWED_SUBS: 'auth0|allowed,auth0|second',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    }),
  ],
  test: { include: ['tests/mcp/**/*.test.ts'], testTimeout: 30000 },
});
