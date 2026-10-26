import { OAuthAuthorizationServer } from '@cloudflare/workers-oauth-provider';
import type { Identity, McpEnv } from '../env.ts';
export const SCOPES = ['style:read', 'style:write', 'offline_access'];
export const resource = (env: McpEnv) => `${env.PUBLIC_ORIGIN}/mcp`;
export function authorizationServer(env: McpEnv) {
  return new OAuthAuthorizationServer<McpEnv>({
    issuer: env.PUBLIC_ORIGIN,
    resources: [resource(env)],
    scopesSupported: SCOPES,
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: '/oauth/register',
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    cookiePrefix: '__Host-tones-',
  });
}
export function isAllowed(env: Pick<McpEnv, 'ALLOWED_SUBS'>, userId: string) {
  return (
    Boolean(userId) &&
    (env.ALLOWED_SUBS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(userId)
  );
}
export async function validateAccessToken(env: McpEnv, token: string) {
  if (!token || token.length > 8192) return null;
  const valid = await authorizationServer(env).validateToken<Identity>(
    resource(env),
    token,
    env,
  );
  if (!valid || !isAllowed(env, valid.props.userId)) return null;
  return valid;
}
