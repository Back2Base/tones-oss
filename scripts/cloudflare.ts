import { parse } from 'jsonc-parser';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const config = parse(
  readFileSync(
    new URL('../workers/ingest/wrangler.jsonc', import.meta.url),
    'utf8',
  ),
);
export const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? config.account_id;
export const databaseId = config.d1_databases[0].database_id as string;
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  // whoami refreshes an expired Wrangler OAuth session before auth token exports it.
  const refreshed = spawnSync('pnpm', ['exec', 'wrangler', 'whoami'], {
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  if (refreshed.status !== 0)
    throw new Error(
      'Cloudflare authentication unavailable. Run pnpm exec wrangler login.',
    );
  // Capture Wrangler's supported auth interface in memory; never log credentials or write them to disk.
  const result = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'auth', 'token', '--json'],
    {
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  if (result.status !== 0)
    throw new Error(
      'Cloudflare authentication unavailable. Run pnpm exec wrangler login.',
    );
  token = (JSON.parse(result.stdout) as { token: string }).token;
}
if (!accountId || !token)
  throw new Error('Set CLOUDFLARE_ACCOUNT_ID and sign in with Wrangler');
export async function api<T = unknown>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`,
    {
      method,
      signal: AbortSignal.timeout(60000),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body instanceof FormData
          ? {}
          : { 'content-type': 'application/json' }),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    result: T;
    errors?: { code: number; message: string }[];
  };
  if (!response.ok || !result.success)
    throw new Error(
      `Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(result.errors)}`,
    );
  return result.result;
}
export async function sql<T>(query: string, params: unknown[] = []) {
  const result = await api<{ results: T[] }[]>(
    `d1/database/${databaseId}/query`,
    'POST',
    { sql: query, params },
  );
  return result[0].results;
}
