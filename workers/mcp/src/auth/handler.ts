import { boundedText } from '../bounded.ts';
import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Identity, McpEnv } from '../env.ts';
import { authorizationServer, isAllowed, SCOPES } from './provider.ts';
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function consentPage(d: ConsentDescription, handle: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Tones</title>
  <body><main><h1>Connect ${escape(d.clientName)} to Tones</h1>
  <p>${d.clientDomain ? `Published by <strong>${escape(d.clientDomain)}</strong>.` : 'This app registered itself. Its name is not verified.'}</p>
  <p>Access returns to <strong>${escape(d.redirectHost)}</strong>.</p>
  ${d.redirectIsLoopback ? '<p>Continue only if you started signing in from an app on this computer.</p>' : ''}
  <form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}">
  ${d.scope.map((s) => `<p><label><input type="checkbox" name="scope" value="${escape(s)}" checked> ${escape(s === 'style:read' ? 'Read my writing samples and style context' : s === 'style:write' ? 'Add and delete my writing samples' : s === 'offline_access' ? 'Stay connected until I revoke access' : s)}</label></p>`).join('')}
  <p><label><input type="checkbox" name="remember" value="yes"> Remember this app on this browser</label></p>
  <button name="decision" value="approve">Continue with Auth0</button> <button name="decision" value="deny">Cancel</button></form></main></body></html>`;
}
const random = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const s256 = async (s: string) =>
  Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
  ).toString('base64url');
function issuer(env: McpEnv) {
  if (!/^[a-z0-9.-]+$/i.test(env.AUTH0_DOMAIN))
    throw new Error('Invalid Auth0 domain configuration');
  return `https://${env.AUTH0_DOMAIN}/`;
}
async function begin(
  oauth: OAuthHelpers,
  env: McpEnv,
  request: AuthRequest,
  headers?: Headers,
) {
  const verifier = random();
  const nonce = random();
  const upstream = await oauth.beginUpstream(request, {
    data: { verifier, nonce },
    headers,
  });
  const target = new URL('authorize', issuer(env));
  const params = {
    response_type: 'code',
    client_id: env.AUTH0_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_ORIGIN}/callback`,
    scope: 'openid profile email',
    state: upstream.state,
    nonce,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
  };
  for (const [key, value] of Object.entries(params))
    target.searchParams.set(key, value);
  upstream.headers.set('Location', target.toString());
  return new Response(null, { status: 302, headers: upstream.headers });
}
export async function verifyIdentity(
  env: McpEnv,
  idToken: string,
  nonce: string,
): Promise<Identity> {
  const expectedIssuer = issuer(env);
  const { payload } = await jwtVerify(
    idToken,
    createRemoteJWKSet(new URL('.well-known/jwks.json', expectedIssuer)),
    {
      issuer: expectedIssuer,
      audience: env.AUTH0_CLIENT_ID,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
      clockTolerance: 5,
    },
  );
  if (
    payload.nonce !== nonce ||
    !payload.sub ||
    (payload.azp !== undefined && payload.azp !== env.AUTH0_CLIENT_ID)
  )
    throw new Error('Auth0 identity validation failed');
  return {
    userId: payload.sub,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
  };
}
export async function authRoutes(request: Request, env: McpEnv) {
  const oauth = authorizationServer(env).getOAuthApi(env);
  const url = new URL(request.url);
  try {
    if (url.pathname === '/authorize' && request.method === 'GET') {
      const parsed = await oauth.parseAuthRequest(request);
      if (!parsed.scope.length) parsed.scope = ['style:read', 'style:write'];
      if (parsed.scope.some((s) => !SCOPES.includes(s)))
        return new Response('Unsupported scope', { status: 400 });
      if (
        env.COOKIE_ENCRYPTION_KEY &&
        (await oauth.isConsentRemembered(request, parsed, {
          secret: env.COOKIE_ENCRYPTION_KEY,
        }))
      )
        return begin(oauth, env, parsed);
      const details = await oauth.describeConsent(parsed);
      const transaction = await oauth.beginConsent(parsed);
      transaction.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, transaction.handle), {
        headers: transaction.headers,
      });
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      if (Number(request.headers.get('content-length') ?? 0) > 8192)
        return new Response('Consent form too large', { status: 413 });
      const body = await boundedText(request, 8192);
      if (body.length > 8192)
        return new Response('Consent form too large', { status: 413 });
      const form = new URLSearchParams(body);
      const handle = form.get('handle') ?? '';
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, {
        scope: form.getAll('scope'),
        ...(form.get('remember') === 'yes'
          ? { remember: { secret: env.COOKIE_ENCRYPTION_KEY } }
          : {}),
      });
      return begin(oauth, env, approved.request, approved.headers);
    }
    if (url.pathname === '/callback' && request.method === 'GET') {
      const resumed = await oauth.finishUpstream<{
        verifier: string;
        nonce: string;
      }>(request);
      if (url.searchParams.has('error')) {
        resumed.headers.set(
          'Location',
          authorizationErrorRedirect(resumed.request, 'access_denied'),
        );
        return new Response(null, { status: 302, headers: resumed.headers });
      }
      const code = url.searchParams.get('code');
      if (!code)
        return new Response('Auth0 did not return an authorization code', {
          status: 400,
        });
      const response = await fetch(new URL('oauth/token', issuer(env)), {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: env.AUTH0_CLIENT_ID,
          client_secret: env.AUTH0_CLIENT_SECRET,
          redirect_uri: `${env.PUBLIC_ORIGIN}/callback`,
          code,
          code_verifier: resumed.data.verifier,
        }),
      });
      if (!response.ok)
        return new Response(
          'Auth0 sign-in could not be completed. Please start again.',
          { status: 502, headers: resumed.headers },
        );
      const tokens = JSON.parse(await boundedText(response, 65536)) as {
        id_token?: string;
      };
      if (!tokens.id_token) throw new Error('Missing Auth0 ID token');
      const identity = await verifyIdentity(
        env,
        tokens.id_token,
        resumed.data.nonce,
      );
      if (!isAllowed(env, identity.userId))
        return new Response('This account is not allowed to use Tones.', {
          status: 403,
          headers: resumed.headers,
        });
      const result = await oauth.completeAuthorization({
        request: resumed.request,
        userId: encodeURIComponent(identity.userId),
        metadata: {},
        scope: resumed.request.scope,
        props: identity,
      });
      resumed.headers.set('Location', result.redirectTo);
      return new Response(null, { status: 302, headers: resumed.headers });
    }
    return new Response('Not found', { status: 404 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo)
      return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError)
      return new Response(
        'This authorization request is invalid or expired. Please start again.',
        { status: 400 },
      );
    console.error('oauth_signin_failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
    });
    return new Response(
      'Sign-in is temporarily unavailable. Please start again.',
      { status: 503 },
    );
  }
}
