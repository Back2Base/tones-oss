import { parse } from 'jsonc-parser';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function wrangler(args: string[], quiet = false) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `wrangler ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`,
    );
  if (!quiet) process.stdout.write(result.stdout);
  return result.stdout;
}
function hasName(output: string, name: string) {
  return new RegExp(`(?:^|[\\s│"'])${name}(?:$|[\\s│"'])`, 'm').test(output);
}
function ensure(list: string[], name: string, create: string[]) {
  if (!hasName(wrangler(list, true), name)) wrangler(create);
  else console.log(`Using existing ${name}`);
}
ensure(['r2', 'bucket', 'list'], 'style-samples', [
  'r2',
  'bucket',
  'create',
  'style-samples',
]);
ensure(['d1', 'list'], 'style', ['d1', 'create', 'style']);
const databases = JSON.parse(wrangler(['d1', 'list', '--json'], true)) as {
  name: string;
  uuid: string;
}[];
const db = databases.find((x) => x.name === 'style');
if (!db) throw new Error('D1 database not found after provisioning');
const configPath = new URL('../workers/ingest/wrangler.jsonc', import.meta.url);
const config = parse(readFileSync(configPath, 'utf8'));
config.d1_databases[0].database_id = db.uuid;
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
ensure(['kv', 'namespace', 'list'], 'style-oauth', [
  'kv',
  'namespace',
  'create',
  'style-oauth',
]);
const namespaces = JSON.parse(wrangler(['kv', 'namespace', 'list'], true)) as {
  id: string;
  title: string;
}[];
const oauth = namespaces.find((n) => n.title === 'style-oauth');
if (!oauth) throw new Error('OAuth KV namespace not found after provisioning');
const mcpPath = new URL('../workers/mcp/wrangler.jsonc', import.meta.url);
const mcp = parse(readFileSync(mcpPath, 'utf8'));
mcp.d1_databases[0].database_id = db.uuid;
mcp.kv_namespaces.find(
  (n: { binding: string }) => n.binding === 'OAUTH_KV',
).id = oauth.id;
writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
ensure(['vectorize', 'list'], 'style-chunks', [
  'vectorize',
  'create',
  'style-chunks',
  '--dimensions=1024',
  '--metric=cosine',
]);
const indexes = wrangler(
  ['vectorize', 'list-metadata-index', 'style-chunks'],
  true,
);
for (const property of ['register', 'sampleId'])
  if (!hasName(indexes, property)) {
    wrangler([
      'vectorize',
      'create-metadata-index',
      'style-chunks',
      `--property-name=${property}`,
      '--type=string',
    ]);
  }
for (const queue of ['style-r2-events', 'style-r2-events-dlq'])
  ensure(['queues', 'list'], queue, ['queues', 'create', queue]);
wrangler([
  'd1',
  'migrations',
  'apply',
  'style',
  '--remote',
  '--config',
  'workers/ingest/wrangler.jsonc',
]);
console.log(
  'Resources ready. Configure Auth0 and secrets, deploy both Workers, then inspect R2 notifications before configuring them.',
);
