import type { IngestEnv } from './env.ts';
import { artifactKey, InputError, userKey } from './storage.ts';
import { kickProfile } from './rebuild.ts';
const terminal = new Set(['complete', 'errored', 'terminated']);
function missing(error: unknown) {
  return (
    error instanceof Error &&
    /instance[._ ]not[._ ]found|instance.*does not exist|instance.*not found/i.test(
      error.message,
    )
  );
}
export async function deleteSample(
  env: IngestEnv,
  userId: string,
  sampleId: string,
) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(sampleId))
    throw new InputError('Invalid sample ID');
  const row = await env.DB.prepare(
    'SELECT r2_key,register FROM samples WHERE id=? AND user_id=?',
  )
    .bind(sampleId, userId)
    .first<{ r2_key: string; register: string }>();
  if (!row) {
    const prior = await env.DB.prepare(
      'SELECT sample_id FROM sample_deletions WHERE sample_id=? AND user_id=?',
    )
      .bind(sampleId, userId)
      .first();
    if (prior) return { deleted: true as const };
    throw new InputError('Sample not found', 404);
  }
  await env.DB.prepare(
    'INSERT INTO sample_deletions(sample_id,user_id,requested_at) VALUES (?,?,?) ON CONFLICT(sample_id) DO NOTHING',
  )
    .bind(sampleId, userId, Date.now())
    .run();
  try {
    const workflow = await env.INGEST_WORKFLOW.get(sampleId);
    let status = await workflow.status();
    if (!terminal.has(status.status)) {
      try {
        await workflow.terminate();
      } catch (error) {
        status = await workflow.status();
        if (!terminal.has(status.status)) throw error;
      }
      status = await workflow.status();
      if (!terminal.has(status.status))
        throw new Error('Ingestion is stopping. Retry deletion shortly.');
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const chunks = await env.DB.prepare(
    'SELECT id FROM chunks WHERE sample_id=? AND user_id=?',
  )
    .bind(sampleId, userId)
    .all<{ id: string }>();
  const features = await env.SAMPLES.get(
    artifactKey(userId, sampleId, 'features.json'),
  );
  const staged = features ? await features.json<{ id: string }[]>() : [];
  const ids = [...new Set([...chunks.results, ...staged].map((c) => c.id))];
  for (let i = 0; i < ids.length; i += 100)
    await env.VECTORIZE.deleteByIds(ids.slice(i, i + 100));
  await env.SAMPLES.delete([
    row.r2_key,
    `clean/${userKey(userId)}/${sampleId}.txt`,
  ]);
  let cursor: string | undefined;
  do {
    const objects = await env.SAMPLES.list({
      prefix: `processed/${userKey(userId)}/${sampleId}/`,
      cursor,
    });
    if (objects.objects.length)
      await env.SAMPLES.delete(objects.objects.map((o) => o.key));
    cursor = objects.truncated ? objects.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks WHERE sample_id=? AND user_id=?').bind(
      sampleId,
      userId,
    ),
    env.DB.prepare('DELETE FROM samples WHERE id=? AND user_id=?').bind(
      sampleId,
      userId,
    ),
    ...[...new Set([row.register, 'general'])].map((register) =>
      env.DB.prepare(
        `INSERT INTO profile_rebuild_requests(user_id,register,dirty_at) VALUES (?,?,?) ON CONFLICT(user_id,register) DO UPDATE SET dirty_at=MAX(excluded.dirty_at,profile_rebuild_requests.dirty_at+1,COALESCE((SELECT MAX(created_at)+1 FROM profiles WHERE user_id=excluded.user_id AND register=excluded.register),0))`,
      ).bind(userId, register, Date.now()),
    ),
  ]);
  await kickProfile(env, userId);
  return { deleted: true as const };
}
