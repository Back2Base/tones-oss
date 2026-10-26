import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { api, sql } from './cloudflare.ts';
import { required } from './config.ts';
const ingestOrigin = required('INGEST_ORIGIN');
const session = JSON.parse(readFileSync('.build/mcp-session.json', 'utf8')) as {
  origin: string;
  clientId: string;
  tokens: { access_token: string; refresh_token: string };
};
const client = new Client({ name: 'Tones live validation', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${session.origin}/mcp`), {
    authProvider: { token: async () => session.tokens.access_token },
  }),
);
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError)
    throw new Error(`${name}: ${JSON.stringify(result.content).slice(0, 600)}`);
  return result.structuredContent as Record<string, unknown>;
}
const text = Array.from(
  { length: 100 },
  () =>
    'I want a clear answer before we discuss the details. We can review the small change together and decide the next step.',
).join(' ');
const samples: string[] = [];
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  oauth: 'Auth0 browser sign-in with PKCE completed',
};
try {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 5);
  report.tools = tools.tools.map((t) => t.name);
  const started = Date.now();
  const added = await call('add_sample', {
    text,
    title: 'Phase 2 live acceptance',
    register: 'documentation',
  });
  const id = String(added.sampleId);
  report.validationSampleId = id;
  samples.push(id);
  console.log(`MCP add_sample accepted ${id}`);
  let status: Record<string, unknown> = {};
  while (Date.now() - started < 120000) {
    const r = await fetch(`${ingestOrigin}/samples/${id}`, {
      headers: { authorization: `Bearer ${session.tokens.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, 200, 'Private AuthService token validation failed');
    status = (await r.json()) as Record<string, unknown>;
    if (status.status === 'ready' || status.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.equal(status.status, 'ready', JSON.stringify(status));
  report.pasteReadyMs = Date.now() - started;
  console.log(`MCP pasted sample ready in ${report.pasteReadyMs} ms`);
  const listed = await call('list_samples', { register: 'documentation' });
  assert.ok((listed.samples as { id: string }[]).some((s) => s.id === id));
  const profile = await call('get_profile', { register: 'documentation' });
  assert.ok(Number(profile.sampleCount) > 0);
  report.profileSource = profile.source;
  let context: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) {
    context = await call('get_style_context', {
      text: 'Please make the next step clear and direct.',
      register: 'documentation',
      k: 6,
    });
    if (
      (context.exemplars as { sampleTitle: string }[]).some(
        (e) => e.sampleTitle === 'Phase 2 live acceptance',
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.ok(
    (context.exemplars as { sampleTitle: string }[]).some(
      (e) => e.sampleTitle === 'Phase 2 live acceptance',
    ),
  );
  report.retrieval = 'passed';
  // Verify the upload Worker accepts the exact MCP access token through AuthService RPC.
  const form = new FormData();
  form.set('file', new File([text], 'phase2-upload.txt'));
  form.set('register', 'documentation');
  form.set('title', 'Phase 2 upload acceptance');
  const upload = await fetch(`${ingestOrigin}/samples`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.tokens.access_token}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(upload.status, 202);
  const uploadId = String(
    ((await upload.json()) as { sampleId: string }).sampleId,
  );
  samples.push(uploadId);
  report.oauthUpload = 'passed';
  // Deleting a pending sample also tests that redelivery cannot revive it.
  for (const sampleId of samples) {
    const result = await call('delete_sample', { sampleId });
    assert.equal(result.deleted, true);
  }
  samples.length = 0;
  const [row] = await sql<{ user_id: string }>(
    'SELECT user_id FROM sample_deletions WHERE sample_id=?',
    [id],
  );
  assert.ok(row);
  const queryEmbedding = await api<{ data: number[][] }>(
    'ai/run/@cf/qwen/qwen3-embedding-0.6b',
    'POST',
    { queries: ['Please make the next step clear and direct.'] },
  );
  const deletedAt = Date.now();
  let remaining = 1;
  while (Date.now() - deletedAt < 60000) {
    const result = await api<{ matches: unknown[] }>(
      'vectorize/v2/indexes/style-chunks/query',
      'POST',
      {
        vector: queryEmbedding.data[0],
        namespace: row.user_id,
        topK: 12,
        returnMetadata: 'all',
        filter: { sampleId: id },
      },
    );
    remaining = result.matches.length;
    if (!remaining) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.equal(
    remaining,
    0,
    'Deleted vectors remained visible beyond 60 seconds',
  );
  report.vectorDeletionMs = Date.now() - deletedAt;
  const listAfter = await call('list_samples', {});
  assert.ok(!(listAfter.samples as { id: string }[]).some((s) => s.id === id));
  report.deletion = 'passed';
  const refreshed = await fetch(`${session.origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.tokens.refresh_token,
      client_id: session.clientId,
      resource: `${session.origin}/mcp`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(refreshed.status, 200);
  session.tokens = (await refreshed.json()) as typeof session.tokens;
  writeFileSync('.build/mcp-session.json', JSON.stringify(session), {
    mode: 0o600,
  });
  report.refreshToken = 'passed';
  report.status = 'passed';
  writeFileSync(
    'docs/phase2-live-acceptance.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const sampleId of samples) {
    try {
      await call('delete_sample', { sampleId });
    } catch {
      console.error(`Sample cleanup needs a retry: ${sampleId}`);
    }
  }
  await client.close();
}
