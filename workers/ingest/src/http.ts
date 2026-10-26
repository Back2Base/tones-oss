import { timingSafeEqual } from 'node:crypto';
import { LIMITS } from '../../../packages/shared/src/index.ts';
import type { IngestEnv } from './env.ts';
import {
  InputError,
  extension,
  storeSample,
  validateMetadata,
} from './storage.ts';

async function authenticate(request: Request, env: IngestEnv) {
  const token = request.headers
    .get('authorization')
    ?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) throw new InputError('A bearer token is required', 401);
  if (env.AUTH) {
    const identity = await env.AUTH.validateToken(token);
    if (!identity?.userId) throw new InputError('Invalid bearer token', 401);
    return identity.userId;
  }
  if (!env.UPLOAD_TOKEN || !env.UPLOAD_USER_ID)
    throw new InputError('Upload authentication is not configured', 503);
  const digest = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
    );
  if (!timingSafeEqual(await digest(token), await digest(env.UPLOAD_TOKEN)))
    throw new InputError('Invalid bearer token', 401);
  return env.UPLOAD_USER_ID;
}
async function boundedForm(request: Request) {
  // Enforce actual bytes even if Content-Length is missing or dishonest; leave room for multipart headers.
  const max = LIMITS.uploadBytes + 64 * 1024;
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > max)
    throw new InputError('Upload exceeds 25 MiB', 413);
  if (!request.body) throw new InputError('A multipart body is required');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new InputError('Upload exceeds 25 MiB', 413);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return await new Response(bytes, {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData();
  } catch {
    throw new InputError('Invalid multipart/form-data body');
  }
}
export async function handleHttp(
  request: Request,
  env: IngestEnv,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health')
      return Response.json({ service: 'style-ingest', status: 'ok' });
    if (
      !(
        (request.method === 'POST' && path === '/samples') ||
        (request.method === 'GET' &&
          /^\/samples\/[0-9A-HJKMNP-TV-Z]{26}$/.test(path))
      )
    ) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const userId = await authenticate(request, env);
    if (request.method === 'POST') {
      if (
        !request.headers.get('content-type')?.startsWith('multipart/form-data')
      )
        throw new InputError('Use multipart/form-data', 415);
      const form = await boundedForm(request);
      const file = form.get('file');
      if (!(file instanceof File))
        throw new InputError('The file field is required');
      const metadata = validateMetadata(
        form.get('title') ?? file.name,
        form.get('register'),
      );
      const result = await storeSample(env, userId, {
        ...metadata,
        body: await file.arrayBuffer(),
        ext: extension(file.name),
      });
      return Response.json(result, {
        status: result.duplicate ? 200 : 202,
        headers: {
          location: `/samples/${result.sampleId}`,
          'cache-control': 'no-store',
        },
      });
    }
    const sample = await env.DB.prepare(
      `SELECT id,title,register,status,error,chunk_count,word_count,created_at,updated_at
      FROM samples WHERE id=? AND user_id=? AND NOT EXISTS (SELECT 1 FROM sample_deletions d WHERE d.sample_id=samples.id)`,
    )
      .bind(path.split('/')[2], userId)
      .first();
    return Response.json(sample ?? { error: 'Sample not found' }, {
      status: sample ? 200 : 404,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof InputError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error(
      'ingest_http_error',
      error instanceof Error ? error.name : 'UnknownError',
    );
    return Response.json(
      { error: 'Ingestion service unavailable. Please retry.' },
      { status: 503 },
    );
  }
}
