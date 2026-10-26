import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { api, sql } from './cloudflare.ts';
const base = process.env.INGEST_URL;
if (!base) throw new Error('Set INGEST_URL to the deployed style-ingest URL');
const fixture = spawnSync('python3', ['scripts/create-fixtures.py'], {
  stdio: 'inherit',
});
if (fixture.status !== 0) throw new Error('Fixture generation failed');
const secret = randomBytes(32).toString('hex');
const userId = `phase1-acceptance:${Date.now()}`;
const existing = await api<{ name: string }[]>(
  'workers/scripts/style-ingest/secrets',
);
if (existing.some((s) => ['UPLOAD_TOKEN', 'UPLOAD_USER_ID'].includes(s.name)))
  throw new Error(
    'Operator upload credentials already exist. Do not overwrite them; remove them or run against a separate deployment.',
  );
const createdSecrets: string[] = [];
const report: {
  startedAt: string;
  userId: string;
  samples: Record<string, unknown>[];
} = { startedAt: new Date().toISOString(), userId, samples: [] };
try {
  for (const [name, text] of [
    ['UPLOAD_TOKEN', secret],
    ['UPLOAD_USER_ID', userId],
  ]) {
    await api('workers/scripts/style-ingest/secrets', 'PUT', {
      name,
      text,
      type: 'secret_text',
    });
    createdSecrets.push(name);
  }
  // Allow secret deployment propagation. Retry only authentication failures before any accepted upload.
  const files = process.env.LIVE_FILES?.split(',') ?? [
    'sample.md',
    'sample.pdf',
    'sample.docx',
    'unsupported.bin',
  ];
  for (const file of files) {
    assert.ok(
      ['sample.md', 'sample.pdf', 'sample.docx', 'unsupported.bin'].includes(
        file,
      ),
      'Unknown fixture',
    );
    const started = Date.now();
    // The design's two-minute target is for pasted text; document conversion may take longer.
    const processingLimitMs = file === 'sample.md' ? 120000 : 360000;
    let result: { sampleId: string } | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const form = new FormData();
      form.set(
        'file',
        new File([readFileSync(`.build/fixtures/${file}`)], file),
      );
      form.set('register', 'documentation');
      form.set('title', `Phase 1 acceptance: ${file}`);
      const response: Response = await fetch(`${base}/samples`, {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${secret}` },
        body: form,
      });
      if (response.status === 503 || response.status === 401) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (response.status !== 202)
        throw new Error(
          `Upload failed: ${response.status} ${(await response.text()).slice(0, 500)}`,
        );
      result = (await response.json()) as { sampleId: string };
      break;
    }
    assert.ok(result, `Could not authenticate upload: ${file}`);
    console.log(`Uploaded ${file}: ${result.sampleId}`);
    let row:
      | {
          id: string;
          status: string;
          error: string | null;
          chunk_count: number;
          word_count: number;
          r2_key: string;
        }
      | undefined;
    while (Date.now() - started < processingLimitMs) {
      [row] = await sql<typeof row & {}>(
        'SELECT id,status,error,chunk_count,word_count,r2_key FROM samples WHERE id=? AND user_id=?',
        [result.sampleId, userId],
      );
      if (row?.status === 'ready' || row?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert.ok(row);
    const elapsedMs = Date.now() - started;
    const statusResponse: Response = await fetch(
      `${base}/samples/${result.sampleId}`,
      {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(30000),
      },
    );
    assert.equal(
      statusResponse.status,
      200,
      'Authenticated status polling failed',
    );
    const publicStatus = (await statusResponse.json()) as {
      status: string;
      chunk_count: number;
    };
    assert.equal(publicStatus.status, row.status);
    assert.equal(publicStatus.chunk_count, row.chunk_count);
    if (file === 'unsupported.bin') {
      assert.equal(row.status, 'failed');
      assert.match(row.error ?? '', /Unsupported file type/);
    } else {
      assert.equal(row.status, 'ready', JSON.stringify(row));
      assert.ok(
        elapsedMs < processingLimitMs,
        'Sample exceeded its processing deadline',
      );
      assert.ok(row.chunk_count > 0);
      assert.ok(row.word_count > 1500);
      const embedding = await api<{ data: number[][] }>(
        'ai/run/@cf/qwen/qwen3-embedding-0.6b',
        'POST',
        { queries: ['A clear answer and the next step'] },
      );
      let matches: { id: string }[] = [];
      for (let retry = 0; retry < 30; retry++) {
        const query = await api<{ matches: { id: string }[] }>(
          'vectorize/v2/indexes/style-chunks/query',
          'POST',
          {
            vector: embedding.data[0],
            namespace: userId,
            topK: 12,
            returnMetadata: 'all',
            filter: { sampleId: result.sampleId },
          },
        );
        matches = query.matches ?? [];
        if (matches.length) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      assert.ok(
        matches.length,
        'No vectors became queryable within 60 seconds',
      );
      const queues =
        await api<{ queue_id: string; queue_name: string }[]>('queues');
      const queue = queues.find((q) => q.queue_name === 'style-r2-events');
      assert.ok(queue);
      // Replay the same event twice to exercise at-least-once delivery after successful processing.
      for (let n = 0; n < 2; n++)
        await api(`queues/${queue.queue_id}/messages`, 'POST', {
          content_type: 'json',
          body: {
            action: 'PutObject',
            bucket: 'style-samples',
            object: { key: row.r2_key },
          },
        });
      await new Promise((r) => setTimeout(r, 6500));
      const [counts] = await sql<{ n: number; distinct_n: number }>(
        'SELECT COUNT(*) AS n,COUNT(DISTINCT id) AS distinct_n FROM chunks WHERE sample_id=?',
        [result.sampleId],
      );
      assert.equal(counts.n, row.chunk_count);
      assert.equal(counts.distinct_n, row.chunk_count);
      const workflow = await api<{ status: string }>(
        `workflows/ingest-sample/instances/${result.sampleId}`,
      );
      assert.equal(workflow.status, 'complete');
    }
    report.samples.push({
      file,
      sampleId: result.sampleId,
      status: row.status,
      chunkCount: row.chunk_count,
      wordCount: row.word_count,
      readyWithinMs: elapsedMs,
    });
    console.log(
      `${file}: ${row.status}, ${row.chunk_count} chunks, ${elapsedMs} ms`,
    );
  }
} finally {
  const cleanup = await Promise.allSettled(
    createdSecrets.map(async (name) => {
      for (let attempt = 0; ; attempt++) {
        try {
          await api(`workers/scripts/style-ingest/secrets/${name}`, 'DELETE');
          return;
        } catch (error) {
          if (attempt >= 2) throw error;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }),
  );
  mkdirSync('.build', { recursive: true });
  writeFileSync(
    '.build/acceptance-report.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  if (cleanup.some((r) => r.status === 'rejected'))
    throw new Error(
      'Temporary credential cleanup failed. Remove UPLOAD_TOKEN and UPLOAD_USER_ID from the Worker.',
    );
}
console.log(
  'Selected live checks passed. Temporary operator credentials removed.',
);
