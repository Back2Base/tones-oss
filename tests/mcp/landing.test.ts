import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { handleMcp } from '../../workers/mcp/src/index.ts';
import { TOOLS } from '../../workers/mcp/src/landing.ts';
import { REGISTER_DESCRIPTIONS } from '../../packages/shared/src/index.ts';
import type { McpEnv } from '../../workers/mcp/src/env.ts';
const bindings = env as unknown as McpEnv;
const origin = 'https://tones.example.com';
const contexts: ExecutionContext[] = [];
async function send(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  contexts.push(ctx);
  return handleMcp(new Request(new URL(path, origin), init), bindings, ctx);
}
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(waitOnExecutionContext));
});
const digest = async (s: string) =>
  `'sha256-${Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('base64')}'`;
it('serves the landing page at / with a hash-based CSP', async () => {
  const response = await send('/');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('cache-control')).toContain('max-age');
  const html = await response.text();
  expect(html).toContain(`${origin}/mcp`);
  expect(html).toContain(`claude mcp add --transport http tones ${origin}/mcp`);
  for (const name of Object.keys(TOOLS)) expect(html).toContain(name);
  for (const [name, description] of Object.entries(REGISTER_DESCRIPTIONS)) {
    expect(html).toContain(`<code>${name}</code>`);
    expect(html).toContain(description.split(':')[0]);
  }
  expect(html.includes('\u2014')).toBe(false);
  expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet/);
  const csp = response.headers.get('content-security-policy') ?? '';
  expect(csp).toContain("default-src 'none'");
  const style = html.match(/<style>([\s\S]*?)<\/style>/)![1];
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  expect(csp).toContain(`style-src ${await digest(style)}`);
  expect(csp).toContain(`script-src ${await digest(script)}`);
  const head = await send('/', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-security-policy')).toBe(csp);
  expect(await head.text()).toBe('');
});
it('leaves health, OAuth, discovery, and MCP routes unchanged', async () => {
  expect(await (await send('/health')).json()).toEqual({
    service: 'style-mcp',
    status: 'ok',
  });
  const mcp = await send('/mcp', { method: 'POST' });
  expect(mcp.status).toBe(401);
  expect(mcp.headers.get('www-authenticate')).toContain('resource_metadata');
  const metadata = (await (
    await send('/.well-known/oauth-authorization-server')
  ).json()) as Record<string, string>;
  expect(metadata.issuer).toBe(origin);
  expect(metadata.registration_endpoint).toBe(`${origin}/oauth/register`);
  const resource = (await (
    await send('/.well-known/oauth-protected-resource/mcp')
  ).json()) as { resource: string };
  expect(resource.resource).toBe(`${origin}/mcp`);
  for (const path of ['/authorize', '/callback']) {
    const response = await send(path);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type') ?? '').not.toContain(
      'text/html',
    );
  }
  const token = await send(new URL(metadata.token_endpoint).pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=authorization_code&code=bogus',
  });
  expect(token.status).toBeGreaterThanOrEqual(400);
  expect(token.status).toBeLessThan(500);
  expect((await send('/', { method: 'POST' })).status).not.toBe(200);
  expect((await send('/nope')).status).toBe(404);
});
