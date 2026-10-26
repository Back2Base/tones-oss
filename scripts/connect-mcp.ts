/** Browser OAuth connection check. No production test-token endpoint is used. */
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { publicOrigin as origin } from './config.ts';
const redirect = 'http://127.0.0.1:8795/callback';
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(32).toString('base64url');
const registration = await fetch(`${origin}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  signal: AbortSignal.timeout(30000),
  body: JSON.stringify({
    client_name: 'Tones validation',
    redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }),
});
if (!registration.ok)
  throw new Error(
    `Client registration failed: ${registration.status} ${(await registration.text()).slice(0, 500)}`,
  );
const client = (await registration.json()) as { client_id: string };
const authorization = new URL('/authorize', origin);
for (const [key, value] of Object.entries({
  client_id: client.client_id,
  redirect_uri: redirect,
  response_type: 'code',
  scope: 'style:read style:write offline_access',
  resource: `${origin}/mcp`,
  state,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
}))
  authorization.searchParams.set(key, value);
mkdirSync('.build', { recursive: true });
writeFileSync('.build/authorization-url.txt', authorization.toString() + '\n', {
  mode: 0o600,
});
await new Promise<void>((resolve, reject) => {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', redirect);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get('state') !== state)
        throw new Error('OAuth state mismatch');
      if (url.searchParams.get('iss') !== origin)
        throw new Error('OAuth issuer mismatch');
      const code = url.searchParams.get('code');
      if (!code)
        throw new Error(
          'OAuth authorization failed: ' +
            (url.searchParams.get('error') ?? 'missing_code'),
        );
      const response = await fetch(`${origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(30000),
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: `${origin}/mcp`,
        }),
      });
      if (!response.ok)
        throw new Error(`Token exchange failed: ${response.status}`);
      const tokens = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      if (!tokens.access_token) throw new Error('Missing access token');
      writeFileSync(
        '.build/mcp-session.json',
        JSON.stringify({
          origin,
          clientId: client.client_id,
          tokens,
          createdAt: Date.now(),
        }),
        { mode: 0o600 },
      );
      res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        })
        .end(
          '<!doctype html><title>Tones connected</title><h1>Tones is connected</h1><p>The OAuth check succeeded. You can close this tab.</p>',
        );
      console.log(
        'Auth0 OAuth, issuer validation, PKCE code exchange, and token issuance passed. Credentials saved in ignored .build/mcp-session.json.',
      );
      server.close();
      clearTimeout(timeout);
      resolve();
    } catch (error) {
      res
        .writeHead(400, { 'content-type': 'text/plain' })
        .end('The connection check failed. Please return to the chat.');
      server.close();
      clearTimeout(timeout);
      reject(error);
    }
  });
  const timeout = setTimeout(
    () => {
      server.close();
      reject(new Error('Timed out waiting for browser authorization'));
    },
    10 * 60 * 1000,
  );
  server.on('error', reject);
  server.listen(8795, '127.0.0.1', () =>
    console.log(
      `Open this sign-in URL and approve Tones validation:\n${authorization}`,
    ),
  );
});
