import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  OAuthResourceServer,
  insufficientScope,
} from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import type { Identity, McpEnv } from './env.ts';
import { authRoutes } from './auth/handler.ts';
import {
  authorizationServer,
  resource,
  validateAccessToken,
} from './auth/provider.ts';
import { createServer } from './tools/index.ts';
import { landing } from './landing.ts';
export class AuthService extends WorkerEntrypoint<McpEnv> {
  async validateToken(token: string) {
    const valid = await validateAccessToken(this.env, token);
    return valid?.scope.includes('style:write')
      ? { userId: valid.props.userId }
      : null;
  }
}
export async function handleMcp(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext,
) {
  const path = new URL(request.url).pathname;
  if (path === '/health')
    return Response.json({ service: 'style-mcp', status: 'ok' });
  if (path === '/' && (request.method === 'GET' || request.method === 'HEAD'))
    return landing(request, env.PUBLIC_ORIGIN);
  if (path === '/authorize' || path === '/callback')
    return authRoutes(request, env);
  const server = authorizationServer(env);
  if (
    path === '/mcp' ||
    path.startsWith('/.well-known/oauth-protected-resource')
  ) {
    const resourceServer = new OAuthResourceServer<McpEnv, Identity>({
      resourceMetadata: {
        resource: resource(env),
        authorization_servers: [env.PUBLIC_ORIGIN],
        resource_name: 'Tones writing style',
      },
      requiredScopes: ['style:read', 'style:write'],
      validateToken: (env) => (_resource, token) =>
        validateAccessToken(env, token),
      handler: {
        fetch(request, env, ctx) {
          if (!ctx.auth.scope.includes('style:read'))
            return insufficientScope(ctx.auth, ['style:read']);
          return createMcpHandler(() => createServer(env, ctx.auth.scope), {
            route: '/mcp',
            authContext: { props: { userId: ctx.props.userId } },
            allowedHostnames: [new URL(env.PUBLIC_ORIGIN).hostname],
            allowedOriginHostnames: [
              new URL(env.PUBLIC_ORIGIN).hostname,
              'claude.ai',
              'www.claude.ai',
            ],
          })(request, env, ctx);
        },
      },
    });
    return resourceServer.fetch(request, env, ctx);
  }
  return server.fetch(request, env, ctx);
}
export default { fetch: handleMcp } satisfies ExportedHandler<McpEnv>;
