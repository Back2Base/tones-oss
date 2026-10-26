import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { ulid } from 'ulid';
import { extractFeatures } from '../packages/stylometry/src/index.ts';
import { api, sql } from './cloudflare.ts';

// Admin-only synthetic load fixture. No server-side bypass or real writing is used.
const session = JSON.parse(readFileSync('.build/mcp-session.json', 'utf8'));
const acceptance = JSON.parse(
  readFileSync('docs/phase2-live-acceptance.json', 'utf8'),
);
assert.ok(acceptance.validationSampleId, 'Run the live check first');
const [owner] = await sql<{ user_id: string }>(
  'SELECT user_id FROM sample_deletions WHERE sample_id=?',
  [acceptance.validationSampleId],
);
assert.ok(owner, 'The live check must have deleted its validation sample');
const userId = owner.user_id;
const ids = Array.from({ length: 200 }, () => ulid());
const text =
  'We can review the small change together. Start with a clear answer, explain the reason, and give the next step. Keep the useful detail close to the decision.';
const features = JSON.stringify(extractFeatures(text));
const client = new Client({ name: 'Tones performance check', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${session.origin}/mcp`), {
    authProvider: { token: async () => session.tokens.access_token },
  }),
);
async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, JSON.stringify(r.content));
  return r.structuredContent as Record<string, unknown>;
}
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  samples: 200,
  chunksPerSample: 1,
  fixture:
    'Synthetic ready D1 rows and real Vectorize embeddings; no learned profile',
  register: 'documentation',
  k: 6,
};
try {
  const embedding = await api<{ data: number[][] }>(
    'ai/run/@cf/qwen/qwen3-embedding-0.6b',
    'POST',
    { text: [text] },
  );
  assert.equal(embedding.data[0].length, 1024);
  for (let i = 0; i < ids.length; i += 8) {
    const batch = ids.slice(i, i + 8);
    await sql(
      `INSERT INTO samples(id,user_id,title,register,r2_key,mime,bytes,status,chunk_count,created_at,updated_at) VALUES ${batch.map(() => "(?,?,?,'documentation',?,'text/plain',200,'ready',1,?,?)").join(',')}`,
      batch.flatMap((id) => [
        id,
        userId,
        'Synthetic latency fixture',
        `benchmark/${id}`,
        Date.now(),
        Date.now(),
      ]),
    );
    await sql(
      `INSERT INTO chunks(id,sample_id,user_id,register,ord,text,tokens,features_json) VALUES ${batch.map(() => "(?,?,?,'documentation',0,?,40,?)").join(',')}`,
      batch.flatMap((id) => [`${id}-0`, id, userId, text, features]),
    );
  }
  const form = new FormData();
  form.set(
    'vectors',
    new File(
      [
        ids
          .map((id) =>
            JSON.stringify({
              id: `${id}-0`,
              namespace: userId,
              values: embedding.data[0],
              metadata: { sampleId: id, register: 'documentation', text },
            }),
          )
          .join('\n') + '\n',
      ],
      'vectors.ndjson',
    ),
  );
  await api('vectorize/v2/indexes/style-chunks/upsert', 'POST', form);
  console.log('Seeded 200 synthetic samples; waiting for Vectorize visibility');
  const deadline = Date.now() + 120000;
  while (true) {
    const result = await api<{ matches: unknown[] }>(
      'vectorize/v2/indexes/style-chunks/query',
      'POST',
      {
        vector: embedding.data[0],
        namespace: userId,
        topK: 6,
        filter: { sampleId: ids[0] },
      },
    );
    if (result.matches.length) break;
    assert.ok(Date.now() < deadline, 'Vectorize did not index the fixture');
    await new Promise((r) => setTimeout(r, 3000));
  }
  const profile = await call('get_profile', { register: 'documentation' });
  assert.ok(Number(profile.sampleCount) >= 200);
  report.loadedSampleCount = profile.sampleCount;
  const visibleBy = Date.now() + 120000;
  while (true) {
    const context = await call('get_style_context', {
      text: 'Please make the next step clear and direct.',
      register: 'documentation',
      k: 6,
    });
    if ((context.exemplars as unknown[]).length === 6) break;
    assert.ok(
      Date.now() < visibleBy,
      'Current fixtures are not visible through MCP yet',
    );
    await new Promise((r) => setTimeout(r, 3000));
  }
  const repeated: number[] = [];
  const distinct: number[] = [];
  for (let i = 0; i < 30; i++) {
    const started = performance.now();
    const result = await call('get_style_context', {
      text:
        i < 20
          ? 'Please make the next step clear and direct.'
          : `Explain decision ${i} clearly and give the next step.`,
      register: 'documentation',
      k: 6,
    });
    assert.equal((result.exemplars as unknown[]).length, 6);
    (i < 20 ? repeated : distinct).push(
      Math.round(performance.now() - started),
    );
  }
  const stats = (values: number[]) => ({
    calls: values.length,
    latenciesMs: values,
    p50Ms: [...values].sort((a, b) => a - b)[
      Math.ceil(values.length * 0.5) - 1
    ],
    p95Ms: [...values].sort((a, b) => a - b)[
      Math.ceil(values.length * 0.95) - 1
    ],
  });
  report.repeatedQuery = stats(repeated);
  report.distinctQueries = stats(distinct);
  report.targetP95Ms = 800;
  report.targetMet = stats(repeated).p95Ms < 800 && stats(distinct).p95Ms < 800;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Benchmark failed';
  throw error;
} finally {
  for (let i = 0; i < ids.length; i += 100)
    await api('vectorize/v2/indexes/style-chunks/delete_by_ids', 'POST', {
      ids: ids.slice(i, i + 100).map((id) => `${id}-0`),
    });
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const marks = batch.map(() => '?').join(',');
    await sql(
      `DELETE FROM chunks WHERE user_id=? AND sample_id IN (${marks})`,
      [userId, ...batch],
    );
    await sql(`DELETE FROM samples WHERE user_id=? AND id IN (${marks})`, [
      userId,
      ...batch,
    ]);
  }
  report.fixtureCleanup = 'completed';
  await client.close();
  writeFileSync(
    'docs/phase2-retrieval-benchmark.json',
    JSON.stringify(report, null, 2) + '\n',
  );
}
console.log(JSON.stringify(report, null, 2));
if (!report.targetMet) process.exitCode = 1;
