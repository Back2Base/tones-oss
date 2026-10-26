import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  introspectWorkflowInstance,
  type D1Migration,
} from 'cloudflare:test';
import { handleHttp } from '../../workers/ingest/src/http.ts';
import {
  addSample,
  storeSample,
  artifactKey,
} from '../../workers/ingest/src/storage.ts';
import {
  consumeQueue,
  startIngestion,
} from '../../workers/ingest/src/queue.ts';
import {
  extract,
  embedBatch,
  indexBatch,
  persist,
  truncateUtf8,
} from '../../workers/ingest/src/pipeline.ts';
import type { IngestEnv } from '../../workers/ingest/src/env.ts';
const bindings = env as unknown as IngestEnv & {
  TEST_MIGRATIONS: D1Migration[];
};
const text =
  'I want a clear answer before we discuss the details. Here is the next step we can take together. '.repeat(
    120,
  );
const makeEnv = () => ({
  ...bindings,
  AI: {
    run: vi.fn(async (_model: unknown, input: { documents: string[] }) => ({
      data: input.documents.map(() => Array(1024).fill(0.1)),
    })),
    toMarkdown: vi.fn(async () => ({ format: 'text', data: text })),
  } as unknown as Ai,
  VECTORIZE: {
    upsert: vi.fn(async () => ({ mutationId: 'm1' })),
    deleteByIds: vi.fn(async () => ({ mutationId: 'm2' })),
  } as unknown as VectorizeIndex,
});
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await bindings.DB.exec(
    'DELETE FROM chunks; DELETE FROM samples; DELETE FROM sample_deletions; DELETE FROM profile_rebuild_requests;',
  );
});
async function uploaded(e = makeEnv(), ext = '.md') {
  const result = await storeSample(e, 'auth0|writer', {
    body: text,
    title: 'A sample',
    register: 'professional',
    ext,
  });
  const row = await e.DB.prepare('SELECT r2_key FROM samples WHERE id=?')
    .bind(result.sampleId)
    .first<{ r2_key: string }>();
  return {
    e,
    p: {
      userId: 'auth0|writer',
      sampleId: result.sampleId,
      key: row!.r2_key,
      register: 'professional' as const,
    },
  };
}
it('writes pasted text to R2 with metadata and a pending D1 row', async () => {
  const e = makeEnv();
  const result = await addSample(e, 'auth0|writer', {
    text,
    title: 'Paste',
    register: 'documentation',
  });
  const row = await e.DB.prepare('SELECT * FROM samples WHERE id=?')
    .bind(result.sampleId)
    .first<{ r2_key: string; status: string }>();
  expect(row?.status).toBe('pending');
  const object = await e.SAMPLES.get(row!.r2_key);
  expect(await object!.text()).toBe(text);
  expect(object!.customMetadata!.userId).toBe('auth0|writer');
});
it('returns the existing sample for identical text instead of adding a duplicate', async () => {
  const e = makeEnv();
  const input = { text, title: 'Paste', register: 'documentation' as const };
  const first = await addSample(e, 'auth0|writer', input);
  expect(first.duplicate).toBe(false);
  const again = await addSample(e, 'auth0|writer', {
    ...input,
    text: `\n${text.replace(/\n/g, '\r\n')}  `,
  });
  expect(again).toEqual({
    sampleId: first.sampleId,
    status: 'pending',
    duplicate: true,
  });
  const other = await addSample(e, 'auth0|someone', input);
  expect(other.duplicate).toBe(false);
  await e.DB.prepare("UPDATE samples SET status='failed' WHERE id=?")
    .bind(first.sampleId)
    .run();
  const retry = await addSample(e, 'auth0|writer', input);
  expect(retry.duplicate).toBe(false);
  expect(retry.sampleId).not.toBe(first.sampleId);
});
it('removes an artifact whose R2 write finishes after deletion starts', async () => {
  const { e, p } = await uploaded();
  const bucket = e.SAMPLES;
  let written = '';
  e.SAMPLES = {
    get: bucket.get.bind(bucket),
    delete: bucket.delete.bind(bucket),
    put: async (key: string, body: string) => {
      await bucket.put(key, body);
      written = key;
      await e.DB.prepare(
        'INSERT INTO sample_deletions(sample_id,user_id,requested_at) VALUES (?,?,?)',
      )
        .bind(p.sampleId, p.userId, Date.now())
        .run();
    },
  } as unknown as R2Bucket;
  await expect(extract(e, p)).rejects.toThrow('Sample has been deleted');
  expect(written).toContain('extracted.txt');
  expect(await bucket.get(written)).toBeNull();
});
it('requires credentials, enforces user-scoped polling, and accepts a multipart upload', async () => {
  const e = makeEnv();
  expect(
    (
      await handleHttp(
        new Request('https://test/samples', { method: 'POST' }),
        e,
      )
    ).status,
  ).toBe(401);
  const form = new FormData();
  form.set('file', new File([text], 'writing.txt'));
  form.set('register', 'professional');
  e.AUTH = {
    validateToken: async (token) =>
      token === 'valid' ? { userId: 'writer' } : null,
  };
  const response = await handleHttp(
    new Request('https://test/samples', {
      method: 'POST',
      headers: { authorization: 'Bearer valid' },
      body: form,
    }),
    e,
  );
  expect(response.status).toBe(202);
  const result = (await response.json()) as { sampleId: string };
  e.AUTH = { validateToken: async () => ({ userId: 'other' }) };
  expect(
    (
      await handleHttp(
        new Request(`https://test/samples/${result.sampleId}`, {
          headers: { authorization: 'Bearer other' },
        }),
        e,
      )
    ).status,
  ).toBe(404);
});
it('fails closed without auth configuration and rejects invalid register or oversized upload', async () => {
  const e = makeEnv();
  expect(
    (
      await handleHttp(
        new Request('https://test/samples', {
          method: 'POST',
          headers: { authorization: 'Bearer x' },
        }),
        e,
      )
    ).status,
  ).toBe(503);
  e.AUTH = { validateToken: async () => ({ userId: 'u' }) };
  const f = new FormData();
  f.set('file', new File([text], 'writing.txt'));
  f.set('register', 'unknown');
  expect(
    (
      await handleHttp(
        new Request('https://test/samples', {
          method: 'POST',
          headers: { authorization: 'Bearer x' },
          body: f,
        }),
        e,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleHttp(
        new Request('https://test/samples', {
          method: 'POST',
          headers: {
            authorization: 'Bearer x',
            'content-type': 'multipart/form-data; boundary=a',
            'content-length': String(26 * 1024 * 1024),
          },
          body: 'x',
        }),
        e,
      )
    ).status,
  ).toBe(413);
});
it.each(['.pdf', '.docx', '.html'])(
  'extracts %s with text output and excludes PDF metadata',
  async (ext) => {
    const { e, p } = await uploaded(makeEnv(), ext);
    await extract(e, p);
    expect(e.AI.toMarkdown).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversionOptions: {
          output: { format: 'text' },
          pdf: { metadata: false },
        },
      }),
    );
  },
);
it('does not mistake transient Workflow failures for duplicates', async () => {
  const { e, p } = await uploaded();
  e.INGEST_WORKFLOW = {
    create: vi.fn(async () => {
      throw new Error('Unavailable');
    }),
    get: vi.fn(async () => {
      throw new Error('Not found');
    }),
  } as unknown as Workflow;
  await expect(startIngestion(e, p)).rejects.toThrow('Unavailable');
});
it('runs the actual Workflow, persists chunks once, and handles repeated notifications', async () => {
  const { e, p } = await uploaded();
  const instance = await introspectWorkflowInstance(
    bindings.INGEST_WORKFLOW,
    p.sampleId,
  );
  try {
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      // Cloud inference and Vectorize have no local emulation. All extraction, D1 and R2 steps run for real.
      for (let offset = 0; offset < 128; offset += 32) {
        await m.mockStepResult({ name: `embed-${offset}` }, { key: 'unused' });
        await m.mockStepResult(
          { name: `index-${offset}` },
          { mutationId: 'm' },
        );
      }
    });
    await startIngestion(e, p);
    expect((await startIngestion(e, p)).id).toBe(p.sampleId);
    await instance.waitForStatus('complete');
    const row = await e.DB.prepare(
      'SELECT status,chunk_count FROM samples WHERE id=?',
    )
      .bind(p.sampleId)
      .first<{ status: string; chunk_count: number }>();
    expect(row!.status).toBe('ready');
    expect(row!.chunk_count).toBeGreaterThan(1);
    const message = {
      id: 'redelivery',
      attempts: 2,
      body: { action: 'PutObject', object: { key: p.key } },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeQueue(
      {
        queue: 'style-r2-events',
        messages: [message],
      } as unknown as MessageBatch<unknown>,
      e,
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    const count = await e.DB.prepare(
      'SELECT COUNT(*) AS n FROM chunks WHERE sample_id=?',
    )
      .bind(p.sampleId)
      .first<{ n: number }>();
    expect(count!.n).toBe(row!.chunk_count);
    // The persistence step is also safe if replayed after its side effects succeeded.
    e.PROFILE_WORKFLOW = {
      create: vi.fn().mockRejectedValue(new Error('Unavailable')),
    } as unknown as IngestEnv['PROFILE_WORKFLOW'];
    await persist(
      e,
      p,
      `processed/auth0%7Cwriter/${p.sampleId}/features.json`,
      `processed/auth0%7Cwriter/${p.sampleId}/sample-features.json`,
    );
    expect(e.PROFILE_WORKFLOW.create).toHaveBeenCalledOnce();
    expect(
      (await e.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE sample_id=?')
        .bind(p.sampleId)
        .first<{ n: number }>())!.n,
    ).toBe(row!.chunk_count);
  } finally {
    await instance.dispose();
  }
});
it('marks unsupported input failed with a readable error through the actual Workflow', async () => {
  const { e, p } = await uploaded(makeEnv(), '.exe');
  const instance = await introspectWorkflowInstance(
    bindings.INGEST_WORKFLOW,
    p.sampleId,
  );
  try {
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await startIngestion(e, p);
    expect((await startIngestion(e, p)).id).toBe(p.sampleId);
    await instance.waitForStatus('errored');
    const row = await e.DB.prepare(
      'SELECT status,error FROM samples WHERE id=?',
    )
      .bind(p.sampleId)
      .first<{ status: string; error: string }>();
    expect(row!.status).toBe('failed');
    expect(row!.error).toContain('Unsupported file type');
  } finally {
    await instance.dispose();
  }
});
it('validates vector dimensions and writes isolated Vectorize namespaces', async () => {
  const { e, p } = await uploaded();
  const key = 'test/features';
  await e.SAMPLES.put(
    key,
    JSON.stringify([{ id: p.sampleId + '-0', text: 'Hello', ord: 0 }]),
  );
  const embedded = await embedBatch(e, p, key, 0);
  await indexBatch(e, embedded.key, p);
  expect(e.VECTORIZE.upsert).toHaveBeenCalledWith([
    expect.objectContaining({
      namespace: p.userId,
      id: p.sampleId + '-0',
      metadata: expect.objectContaining({ register: 'professional' }),
    }),
  ]);
  e.AI.run = vi.fn(async () => ({
    data: [[1, 2]],
  })) as unknown as typeof e.AI.run;
  await expect(embedBatch(e, p, key, 0)).rejects.toThrow('1024-dimensional');
  expect(
    new TextEncoder().encode(truncateUtf8('🙂'.repeat(3000), 8192)).length,
  ).toBeLessThanOrEqual(8192);
});
it('retries queue delivery when Workflow creation is unavailable', async () => {
  const { e, p } = await uploaded();
  e.INGEST_WORKFLOW = {
    create: async () => {
      throw new Error('Temporary failure');
    },
    get: async () => {
      throw new Error('Missing');
    },
  } as unknown as Workflow;
  const message = {
    id: 'q1',
    attempts: 1,
    body: { action: 'PutObject', object: { key: p.key } },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  await consumeQueue(
    {
      queue: 'style-r2-events',
      messages: [message],
    } as unknown as MessageBatch<unknown>,
    e,
  );
  expect(message.ack).not.toHaveBeenCalled();
  expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
});
it('sends at most 32 chunks in each embedding request', async () => {
  const { e, p } = await uploaded();
  const key = 'test/many-features';
  await e.SAMPLES.put(
    key,
    JSON.stringify(
      Array.from({ length: 40 }, (_, ord) => ({
        id: `${p.sampleId}-${ord}`,
        text: 'Sample ' + ord,
        ord,
      })),
    ),
  );
  await embedBatch(e, p, key, 0);
  await embedBatch(e, p, key, 32);
  const calls = vi.mocked(e.AI.run).mock.calls;
  expect((calls[0][1] as { documents: string[] }).documents).toHaveLength(32);
  expect((calls[1][1] as { documents: string[] }).documents).toHaveLength(8);
});
it('marks a source upload failure in D1 instead of leaving it pending', async () => {
  const e = makeEnv();
  const source = e.SAMPLES;
  e.SAMPLES = {
    put: async () => {
      throw new Error('R2 unavailable');
    },
  } as unknown as R2Bucket;
  await expect(
    addSample(e, 'upload-failure-user', {
      text,
      title: 'failed upload',
      register: 'general',
    }),
  ).rejects.toThrow('R2 unavailable');
  e.SAMPLES = source;
  const row = await e.DB.prepare(
    'SELECT status,error FROM samples WHERE user_id=?',
  )
    .bind('upload-failure-user')
    .first<{ status: string; error: string }>();
  expect(row!.status).toBe('failed');
  expect(row!.error).toContain('Source upload failed');
});
it('operator credentials bind all HTTP writes to the configured user', async () => {
  const e = makeEnv();
  e.UPLOAD_TOKEN = 'operator-secret';
  e.UPLOAD_USER_ID = 'fixed-user';
  const form = new FormData();
  form.set('file', new File([text], 'sample.md'));
  form.set('register', 'casual');
  form.set('userId', 'someone-else');
  const response = await handleHttp(
    new Request('https://test/samples', {
      method: 'POST',
      headers: { authorization: 'Bearer operator-secret' },
      body: form,
    }),
    e,
  );
  expect(response.status).toBe(202);
  const result = (await response.json()) as { sampleId: string };
  const row = await e.DB.prepare('SELECT user_id FROM samples WHERE id=?')
    .bind(result.sampleId)
    .first<{ user_id: string }>();
  expect(row!.user_id).toBe('fixed-user');
  expect(
    (
      await handleHttp(
        new Request('https://test/samples', {
          method: 'POST',
          headers: { authorization: 'Bearer bad' },
        }),
        e,
      )
    ).status,
  ).toBe(401);
});

it('accepts queue notifications serialized as JSON strings', async () => {
  const { e, p } = await uploaded();
  const create = vi.fn(async () => ({ id: p.sampleId }));
  e.INGEST_WORKFLOW = { create } as unknown as Workflow;
  const message = {
    id: 'serialized-event',
    attempts: 1,
    body: JSON.stringify({ action: 'PutObject', object: { key: p.key } }),
    ack: vi.fn(),
    retry: vi.fn(),
  };
  await consumeQueue(
    {
      queue: 'style-r2-events',
      messages: [message],
    } as unknown as MessageBatch<unknown>,
    e,
  );
  expect(create).toHaveBeenCalledWith({ id: p.sampleId, params: p });
  expect(message.ack).toHaveBeenCalledOnce();
  expect(message.retry).not.toHaveBeenCalled();
});

it('deletes only owned samples and prevents notification redelivery from recreating them', async () => {
  const { deleteSample } = await import('../../workers/ingest/src/deletion.ts');
  const { e, p } = await uploaded();
  await e.SAMPLES.put(
    artifactKey(p.userId, p.sampleId, 'features.json'),
    JSON.stringify(
      Array.from({ length: 201 }, (_, n) => ({ id: `${p.sampleId}-${n}` })),
    ),
  );
  e.VECTORIZE.deleteByIds = vi.fn(async (ids: string[]) => {
    if (ids.length > 100)
      throw new Error('too many ids in payload; max id count is 100');
    return { mutationId: 'delete' };
  }) as unknown as VectorizeIndex['deleteByIds'];
  await expect(deleteSample(e, 'another-user', p.sampleId)).rejects.toThrow(
    'Sample not found',
  );
  expect(await deleteSample(e, p.userId, p.sampleId)).toEqual({
    deleted: true,
  });
  expect(
    await e.DB.prepare('SELECT id FROM samples WHERE id=?')
      .bind(p.sampleId)
      .first(),
  ).toBeNull();
  expect(await e.SAMPLES.get(p.key)).toBeNull();
  expect(e.VECTORIZE.deleteByIds).toHaveBeenCalledTimes(3);
  const message = {
    id: 'deleted-event',
    attempts: 1,
    body: { action: 'PutObject', object: { key: p.key } },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  await consumeQueue(
    {
      queue: 'style-r2-events',
      messages: [message],
    } as unknown as MessageBatch<unknown>,
    e,
  );
  expect(message.ack).toHaveBeenCalledOnce();
  expect(message.retry).not.toHaveBeenCalled();
  expect(await deleteSample(e, p.userId, p.sampleId)).toEqual({
    deleted: true,
  });
});
it('fences a late vector write if deletion begins while upsert is in flight', async () => {
  const { e, p } = await uploaded();
  await e.SAMPLES.put(
    'test/late-vectors',
    JSON.stringify([
      {
        id: p.sampleId + '-0',
        values: Array(1024).fill(0.1),
        namespace: p.userId,
      },
    ]),
  );
  e.VECTORIZE.upsert = vi.fn(async () => {
    await e.DB.prepare(
      'INSERT INTO sample_deletions(sample_id,user_id,requested_at) VALUES (?,?,?)',
    )
      .bind(p.sampleId, p.userId, Date.now())
      .run();
    return { mutationId: 'late' };
  }) as unknown as VectorizeIndex['upsert'];
  await expect(indexBatch(e, 'test/late-vectors', p)).rejects.toThrow(
    'Sample has been deleted',
  );
  expect(e.VECTORIZE.deleteByIds).toHaveBeenCalledWith([p.sampleId + '-0']);
});
