import { ulid } from 'ulid';
import {
  isRegister,
  LIMITS,
  REGISTERS,
  type Register,
} from '../../../packages/shared/src/index.ts';
import type { IngestEnv } from './env.ts';

export class InputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function userKey(userId: string) {
  if (!userId || userId.length > 512)
    throw new InputError('Invalid user identity');
  return encodeURIComponent(userId).replace(/\./g, '%2E');
}
export function artifactKey(userId: string, sampleId: string, name: string) {
  return `processed/${userKey(userId)}/${sampleId}/${name}`;
}
export function validateMetadata(
  title: unknown,
  register: unknown,
  source?: unknown,
) {
  if (typeof title !== 'string' || !title.trim() || title.length > 300)
    throw new InputError('Title must be 1 to 300 characters');
  if (!isRegister(register))
    throw new InputError(`Register must be one of: ${REGISTERS.join(', ')}`);
  if (
    source !== undefined &&
    (typeof source !== 'string' || source.length > 2000)
  )
    throw new InputError('Source must be at most 2000 characters');
  return {
    title: title.trim(),
    register,
    source: source as string | undefined,
  };
}
export function extension(name: string) {
  return name.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() ?? '.unsupported';
}
export const MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export async function storeSample(
  env: IngestEnv,
  userId: string,
  input: {
    body: ArrayBuffer | string;
    title: string;
    register: Register;
    source?: string;
    ext: string;
  },
) {
  const owner = userKey(userId);
  const sampleId = ulid();
  const key = `raw/${owner}/${sampleId}${input.ext}`;
  const bytes =
    typeof input.body === 'string'
      ? new TextEncoder().encode(input.body).length
      : input.body.byteLength;
  if (!bytes || bytes > LIMITS.uploadBytes)
    throw new InputError('File must be between 1 byte and 25 MiB', 413);
  const sha = await contentHash(input.body);
  // A failed copy may be retried; any other live copy is returned as is.
  const existing = await env.DB.prepare(
    `SELECT s.id,s.status FROM samples s WHERE s.user_id=? AND s.content_sha256=? AND s.status!='failed'
    AND NOT EXISTS (SELECT 1 FROM sample_deletions d WHERE d.sample_id=s.id) LIMIT 1`,
  )
    .bind(userId, sha)
    .first<{ id: string; status: 'pending' | 'processing' | 'ready' }>();
  if (existing)
    return { sampleId: existing.id, status: existing.status, duplicate: true };
  const mime = MIME[input.ext] ?? 'application/octet-stream';
  const now = Date.now();
  // Pending metadata must exist before R2 can deliver an object-create notification.
  await env.DB.prepare(
    `INSERT INTO samples
    (id,user_id,title,register,source,content_sha256,r2_key,mime,bytes,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
  )
    .bind(
      sampleId,
      userId,
      input.title,
      input.register,
      input.source ?? null,
      sha,
      key,
      mime,
      bytes,
      now,
      now,
    )
    .run();
  try {
    await env.SAMPLES.put(key, input.body, {
      httpMetadata: { contentType: mime },
      customMetadata: {
        userId,
        sampleId,
        register: input.register,
        title: input.title,
      },
    });
  } catch (error) {
    // A successful put with a lost response may still produce a notification; ingestion can recover it.
    await env.DB.prepare(
      `UPDATE samples SET status='failed',error=?,updated_at=? WHERE id=? AND status='pending'`,
    )
      .bind(
        'Source upload failed. Please upload the sample again.',
        Date.now(),
        sampleId,
      )
      .run();
    throw error;
  }
  const deleted = await env.DB.prepare(
    'SELECT sample_id FROM sample_deletions WHERE sample_id=? AND user_id=?',
  )
    .bind(sampleId, userId)
    .first();
  if (deleted) {
    await env.SAMPLES.delete(key);
    throw new InputError('Sample was deleted while uploading', 409);
  }
  return { sampleId, status: 'pending' as const, duplicate: false };
}
/** Text is compared after normalizing line endings and outer whitespace; files byte for byte. */
export async function contentHash(body: ArrayBuffer | string) {
  const bytes =
    typeof body === 'string'
      ? new TextEncoder().encode(body.replace(/\r\n?/g, '\n').trim())
      : body;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function addSample(
  env: IngestEnv,
  userId: string,
  input: { text: string; title: string; register: Register; source?: string },
) {
  const metadata = validateMetadata(input.title, input.register, input.source);
  if (
    typeof input.text !== 'string' ||
    input.text.length < LIMITS.sampleMinChars ||
    input.text.length > LIMITS.sampleMaxChars
  ) {
    throw new InputError('Sample text must be 200 to 200000 characters');
  }
  return storeSample(env, userId, {
    ...metadata,
    body: input.text,
    ext: '.md',
  });
}
export async function readJson<T>(env: IngestEnv, key: string): Promise<T> {
  const object = await env.SAMPLES.get(key);
  if (!object) throw new Error('Processing artifact is missing');
  return object.json<T>();
}
