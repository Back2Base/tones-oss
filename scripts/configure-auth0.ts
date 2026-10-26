import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { publicOrigin, required } from './config.ts';
const callback = `${publicOrigin}/callback`;
const ownerEmail = required('TONES_OWNER_EMAIL');
const auth0Domain = required('AUTH0_DOMAIN');
const cli = process.env.AUTH0_CLI ?? 'auth0';
function run(args: string[]) {
  const r = spawnSync(cli, ['--agent-mode', ...args], {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(
      `Auth0 CLI command failed: ${args.slice(0, 3).join(' ')}\n${r.stderr}`,
    );
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const apps = run(['apps', 'list']) as { name: string; client_id: string }[];
const existing = apps.find((a) => a.name === 'Tones');
let clientId = existing?.client_id;
if (!clientId) {
  const created = run([
    'apps',
    'create',
    '--data',
    JSON.stringify({
      name: 'Tones',
      app_type: 'regular_web',
      token_endpoint_auth_method: 'client_secret_post',
      callbacks: [callback],
      grant_types: ['authorization_code'],
      oidc_conformant: true,
      is_first_party: true,
      jwt_configuration: { alg: 'RS256' },
    }),
  ]);
  clientId = (Array.isArray(created) ? created[0] : created).client_id;
}
if (!clientId) throw new Error('Auth0 did not return the new client ID');
const app = run(['apps', 'show', clientId, '--reveal-secrets']) as {
  client_secret?: string;
  callbacks?: string[];
  app_type?: string;
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  jwt_configuration?: { alg?: string };
};
if (
  !app.callbacks?.includes(callback) ||
  app.app_type !== 'regular_web' ||
  app.token_endpoint_auth_method !== 'client_secret_post' ||
  !app.grant_types?.includes('authorization_code') ||
  app.jwt_configuration?.alg !== 'RS256'
)
  throw new Error(
    'Existing Tones application has incompatible settings; inspect before changing it',
  );
if (!app.client_secret)
  throw new Error('Auth0 did not expose the client secret with this login');
const connections = run([
  'api',
  'get',
  'connections?fields=id,name,strategy&include_fields=true',
]) as { id: string; name: string; strategy: string }[];
for (const connection of connections.filter((c) =>
  ['auth0', 'github', 'google-oauth2'].includes(c.strategy),
)) {
  run([
    'connections',
    'enabled-clients',
    'update',
    connection.id,
    '--data',
    JSON.stringify([{ client_id: clientId, status: true }]),
  ]);
}
const users = run(['users', 'search-by-email', ownerEmail]) as {
  user_id: string;
  email_verified: boolean;
}[];
const allowed = users.filter((u) => u.email_verified).map((u) => u.user_id);
if (!allowed.length)
  throw new Error(
    'No verified identity was found for TONES_OWNER_EMAIL; do not enable access automatically',
  );
const path = new URL('../workers/mcp/.dev.vars', import.meta.url);
if (existsSync(path)) {
  const existingId = readFileSync(path, 'utf8').match(
    /^AUTH0_CLIENT_ID=(.+)$/m,
  )?.[1];
  if (!existingId || JSON.parse(existingId) !== clientId)
    throw new Error('Existing local secrets belong to a different application');
  console.log(
    'Tones application connections configured; existing local secrets preserved',
  );
  process.exit(0);
}
const secrets = {
  AUTH0_DOMAIN: auth0Domain,
  AUTH0_CLIENT_ID: clientId,
  AUTH0_CLIENT_SECRET: app.client_secret,
  COOKIE_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  ALLOWED_SUBS: allowed.join(','),
};
writeFileSync(
  path,
  Object.entries(secrets)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('\n') + '\n',
  { mode: 0o600 },
);
chmodSync(path, 0o600);
console.log(
  JSON.stringify({
    name: 'Tones',
    clientId,
    callback,
    allowedIdentities: allowed.length,
    secretsSaved: 'workers/mcp/.dev.vars',
  }),
);
