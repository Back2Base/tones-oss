import { NonRetryableError } from 'cloudflare:workflows';
import type { IngestParams } from '../../../packages/shared/src/index.ts';
import { extractFeatures } from '../../../packages/stylometry/src/index.ts';
import type { IngestEnv } from './env.ts';
import { cleanText } from './clean.ts';
import { segmentText } from './segment.ts';
import { artifactKey, extension, MIME, readJson, userKey } from './storage.ts';
import { kickProfile } from './rebuild.ts';
export type Chunk = {
  id: string;
  ord: number;
  text: string;
  tokens: number;
  features: ReturnType<typeof extractFeatures>;
};
const MAX_TEXT_CHARS = 200_000;
const MAX_CHUNKS = 2000;
export const EMBED_BATCH_SIZE = 32;
export const retries = {
  retries: {
    limit: 5,
    delay: '5 seconds' as const,
    backoff: 'exponential' as const,
  },
  timeout: '5 minutes' as const,
};

export async function assertActive(env: IngestEnv, p: IngestParams) {
  const active = await env.DB.prepare(
    `SELECT id FROM samples WHERE id=? AND user_id=? AND NOT EXISTS (SELECT 1 FROM sample_deletions d WHERE d.sample_id=samples.id)`,
  )
    .bind(p.sampleId, p.userId)
    .first();
  if (!active) throw new NonRetryableError('Sample has been deleted');
}
async function putArtifact(
  env: IngestEnv,
  p: IngestParams,
  key: string,
  body: string,
  options?: R2PutOptions,
) {
  await assertActive(env, p);
  await env.SAMPLES.put(key, body, options);
  try {
    await assertActive(env, p);
  } catch (error) {
    await env.SAMPLES.delete(key);
    throw error;
  }
}
export async function extract(env: IngestEnv, p: IngestParams) {
  await assertActive(env, p);
  const object = await env.SAMPLES.get(p.key);
  if (!object) throw new NonRetryableError('Source file is missing');
  const ext = extension(p.key);
  if (!MIME[ext])
    throw new NonRetryableError(
      `Unsupported file type: ${ext}. Use PDF, DOCX, HTML, MD, or TXT.`,
    );
  let text: string;
  if (ext === '.md' || ext === '.txt') text = await object.text();
  else {
    const result = await env.AI.toMarkdown(
      {
        name: `sample${ext}`,
        blob: new Blob([await object.arrayBuffer()], { type: MIME[ext] }),
      },
      {
        gateway: { id: env.AI_GATEWAY_ID, skipCache: false },
        conversionOptions: {
          output: { format: 'text' },
          pdf: { metadata: false },
        },
      },
    );
    if (result.format === 'error' || typeof result.data !== 'string')
      throw new NonRetryableError(
        `File conversion failed: ${'error' in result ? result.error : 'No text returned'}`,
      );
    text = result.data;
  }
  if (text.length > MAX_TEXT_CHARS)
    throw new NonRetryableError(
      'Extracted text exceeds the 200000 character limit. Split the document.',
    );
  const key = artifactKey(p.userId, p.sampleId, 'extracted.txt');
  await putArtifact(env, p, key, text, {
    httpMetadata: { contentType: 'text/plain' },
  });
  return { key };
}
export async function clean(env: IngestEnv, p: IngestParams, key: string) {
  await assertActive(env, p);
  const object = await env.SAMPLES.get(key);
  if (!object) throw new Error('Extracted text is missing');
  const text = cleanText(await object.text());
  if (text.length < 200)
    throw new NonRetryableError(
      'Fewer than 200 characters remain after cleanup. Add a longer writing sample.',
    );
  const cleanKey = `clean/${userKey(p.userId)}/${p.sampleId}.txt`;
  await putArtifact(env, p, cleanKey, text, {
    httpMetadata: { contentType: 'text/plain' },
  });
  return { key: cleanKey };
}
export async function segment(env: IngestEnv, p: IngestParams, key: string) {
  await assertActive(env, p);
  const object = await env.SAMPLES.get(key);
  if (!object) throw new Error('Cleaned text is missing');
  const chunks = segmentText(await object.text());
  if (!chunks.length || chunks.length > MAX_CHUNKS)
    throw new NonRetryableError(
      'Document must produce between 1 and 2000 chunks. Split the document.',
    );
  // UTF-8 bytes upper-bound token count for byte-level tokenizers, independent of language.
  if (chunks.some((c) => new TextEncoder().encode(c.text).length > 4000)) {
    throw new NonRetryableError(
      'One sentence exceeds the embedding input safety limit. Shorten or split that sentence.',
    );
  }
  const chunksKey = artifactKey(p.userId, p.sampleId, 'segments.json');
  await putArtifact(env, p, chunksKey, JSON.stringify(chunks));
  return { key: chunksKey, count: chunks.length };
}
export async function features(
  env: IngestEnv,
  p: IngestParams,
  segmentKey: string,
  cleanKey: string,
) {
  await assertActive(env, p);
  const segments = await readJson<{ text: string; tokens: number }[]>(
    env,
    segmentKey,
  );
  const object = await env.SAMPLES.get(cleanKey);
  if (!object) throw new Error('Cleaned text is missing');
  const sampleFeatures = extractFeatures(await object.text());
  const chunks: Chunk[] = segments.map((c, ord) => ({
    ...c,
    id: `${p.sampleId}-${ord}`,
    ord,
    features: extractFeatures(c.text),
  }));
  const key = artifactKey(p.userId, p.sampleId, 'features.json');
  await putArtifact(env, p, key, JSON.stringify(chunks));
  const sampleKey = artifactKey(p.userId, p.sampleId, 'sample-features.json');
  await putArtifact(env, p, sampleKey, JSON.stringify(sampleFeatures));
  return { key, sampleKey };
}
export async function embedBatch(
  env: IngestEnv,
  p: IngestParams,
  featuresKey: string,
  offset: number,
) {
  await assertActive(env, p);
  const chunks = (await readJson<Chunk[]>(env, featuresKey)).slice(
    offset,
    offset + EMBED_BATCH_SIZE,
  );
  const result = await env.AI.run(
    env.MODEL_EMBED,
    { documents: chunks.map((c) => c.text) },
    { gateway: { id: env.AI_GATEWAY_ID, skipCache: false } },
  );
  const data = (result as { data?: number[][] }).data;
  if (
    !Array.isArray(data) ||
    data.length !== chunks.length ||
    data.some(
      (v) =>
        !Array.isArray(v) ||
        v.length !== 1024 ||
        v.some((n) => typeof n !== 'number' || !Number.isFinite(n)),
    )
  ) {
    throw new Error(
      'Embedding model must return one 1024-dimensional vector per chunk',
    );
  }
  const vectors: VectorizeVector[] = chunks.map((c, i) => ({
    id: c.id,
    namespace: p.userId,
    values: data[i],
    metadata: {
      sampleId: p.sampleId,
      register: p.register,
      ord: c.ord,
      text: truncateUtf8(c.text, 8192),
    },
  }));
  const key = artifactKey(p.userId, p.sampleId, `vectors-${offset}.json`);
  await putArtifact(env, p, key, JSON.stringify(vectors));
  return { key };
}
export function truncateUtf8(text: string, bytes: number) {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= bytes) return text;
  // Do not introduce a replacement character if the limit bisects a multi-byte character.
  let end = bytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.slice(0, end));
}
export async function indexBatch(env: IngestEnv, key: string, p: IngestParams) {
  await assertActive(env, p);
  const vectors = await readJson<VectorizeVector[]>(env, key);
  const mutation = await env.VECTORIZE.upsert(vectors);
  try {
    await assertActive(env, p);
  } catch (error) {
    await env.VECTORIZE.deleteByIds(vectors.map((v) => v.id));
    throw error;
  }
  return mutation;
}
export async function persist(
  env: IngestEnv,
  p: IngestParams,
  featuresKey: string,
  sampleKey: string,
) {
  await assertActive(env, p);
  const chunks = await readJson<Chunk[]>(env, featuresKey);
  for (let i = 0; i < chunks.length; i += 25) {
    await env.DB.batch(
      chunks.slice(i, i + 25).map((c) =>
        env.DB.prepare(
          `INSERT INTO chunks
      (id,sample_id,user_id,register,ord,text,tokens,features_json) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM samples s WHERE s.id=? AND s.user_id=? AND NOT EXISTS (SELECT 1 FROM sample_deletions d WHERE d.sample_id=s.id))
      ON CONFLICT(id) DO UPDATE SET text=excluded.text,tokens=excluded.tokens,features_json=excluded.features_json`,
        ).bind(
          c.id,
          p.sampleId,
          p.userId,
          p.register,
          c.ord,
          c.text,
          c.tokens,
          JSON.stringify(c.features),
          p.sampleId,
          p.userId,
        ),
      ),
    );
  }
  const sampleFeatures = await readJson<ReturnType<typeof extractFeatures>>(
    env,
    sampleKey,
  );
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE samples SET status='ready',error=NULL,chunk_count=?,word_count=?,features_json=?,updated_at=? WHERE id=? AND user_id=? AND NOT EXISTS (SELECT 1 FROM sample_deletions d WHERE d.sample_id=samples.id)`,
    ).bind(
      chunks.length,
      sampleFeatures.wordCount,
      JSON.stringify(sampleFeatures),
      Date.now(),
      p.sampleId,
      p.userId,
    ),
    ...[...new Set([p.register, 'general'])].map((register) =>
      env.DB.prepare(
        `INSERT INTO profile_rebuild_requests(user_id,register,dirty_at) VALUES (?,?,?)
      ON CONFLICT(user_id,register) DO UPDATE SET dirty_at=MAX(excluded.dirty_at,profile_rebuild_requests.dirty_at+1,COALESCE((SELECT MAX(created_at)+1 FROM profiles WHERE user_id=excluded.user_id AND register=excluded.register),0))`,
      ).bind(p.userId, register, Date.now()),
    ),
  ]);
  await assertActive(env, p);
  await kickProfile(env, p.userId);
  return {
    sampleId: p.sampleId,
    status: 'ready',
    chunkCount: chunks.length,
    wordCount: sampleFeatures.wordCount,
  };
}
export async function failSample(
  env: IngestEnv,
  p: IngestParams,
  error: unknown,
) {
  // Persist failure even if a later cleanup operation is unavailable. Replays repeat both safely.
  await env.DB.prepare(
    `UPDATE samples SET status='failed',error=?,chunk_count=0,updated_at=? WHERE id=? AND user_id=?`,
  )
    .bind(
      (error instanceof Error ? error.message : 'Ingestion failed').slice(
        0,
        1000,
      ),
      Date.now(),
      p.sampleId,
      p.userId,
    )
    .run();
  // Remove any vectors written before a terminal failure. Ids are deterministic on replay.
  const object = await env.SAMPLES.get(
    artifactKey(p.userId, p.sampleId, 'features.json'),
  );
  if (object) {
    const chunks = await object.json<Chunk[]>();
    for (let i = 0; i < chunks.length; i += 100)
      await env.VECTORIZE.deleteByIds(
        chunks.slice(i, i + 100).map((c) => c.id),
      );
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks WHERE sample_id=? AND user_id=?').bind(
      p.sampleId,
      p.userId,
    ),
    env.DB.prepare(
      `UPDATE samples SET status='failed',error=?,chunk_count=0,updated_at=? WHERE id=? AND user_id=?`,
    ).bind(
      (error instanceof Error ? error.message : 'Ingestion failed').slice(
        0,
        1000,
      ),
      Date.now(),
      p.sampleId,
      p.userId,
    ),
  ]);
}
