import {
  isRegister,
  type IngestParams,
} from '../../../packages/shared/src/index.ts';
import type { IngestEnv } from './env.ts';

export async function startIngestion(env: IngestEnv, params: IngestParams) {
  try {
    return await env.INGEST_WORKFLOW.create({ id: params.sampleId, params });
  } catch (error) {
    // A timeout may have happened after create succeeded. get()+status() confirms the duplicate.
    try {
      const existing = await env.INGEST_WORKFLOW.get(params.sampleId);
      await existing.status();
      return existing;
    } catch {
      throw error;
    }
  }
}
export async function consumeQueue(
  batch: MessageBatch<unknown>,
  env: IngestEnv,
) {
  for (const message of batch.messages) {
    try {
      const rawBody =
        typeof message.body === 'string'
          ? JSON.parse(message.body)
          : message.body;
      const body = rawBody as {
        action?: string;
        object?: { key?: string };
      } | null;
      const key = body?.object?.key;
      if (
        !key?.startsWith('raw/') ||
        !['PutObject', 'CopyObject', 'CompleteMultipartUpload'].includes(
          body?.action ?? '',
        )
      ) {
        console.warn('ingest_queue_ignored', {
          messageId: message.id,
          bodyType: typeof message.body,
          action: body?.action ?? null,
        });
        message.ack();
        continue;
      }
      const object = await env.SAMPLES.head(key);
      if (!object) {
        console.warn('ingest_source_missing', { messageId: message.id });
        message.ack();
        continue;
      }
      const { userId, sampleId, register } = object.customMetadata ?? {};
      if (!userId || !sampleId || !isRegister(register))
        throw new Error(
          'Missing source metadata: ' +
            Object.keys(object.customMetadata ?? {}).join(','),
        );
      const deleted = await env.DB.prepare(
        'SELECT sample_id FROM sample_deletions WHERE sample_id=? AND user_id=?',
      )
        .bind(sampleId, userId)
        .first();
      if (deleted) {
        message.ack();
        continue;
      }
      const sample = await env.DB.prepare(
        'SELECT r2_key,status FROM samples WHERE id=? AND user_id=?',
      )
        .bind(sampleId, userId)
        .first<{ r2_key: string; status: string }>();
      if (!sample || sample.r2_key !== key)
        throw new Error('Source metadata has no matching sample');
      if (batch.queue.endsWith('-dlq')) {
        // Existing Workflows own their status; only a never-started upload is failed here.
        try {
          await (await env.INGEST_WORKFLOW.get(sampleId)).status();
        } catch {
          await env.DB.prepare(
            `UPDATE samples SET status='failed',error=?,updated_at=? WHERE id=? AND status IN ('pending','failed')`,
          )
            .bind(
              'Ingestion could not be started after queue retries. Please upload again.',
              Date.now(),
              sampleId,
            )
            .run();
        }
      } else if (sample.status !== 'ready')
        await startIngestion(env, { userId, sampleId, key, register });
      console.log('ingest_queue_started', { sampleId, status: sample.status });
      message.ack();
    } catch (error) {
      console.error('ingest_queue_retry', {
        messageId: message.id,
        attempts: message.attempts,
        error: error instanceof Error ? error.message : 'Unknown queue error',
      });
      message.retry({
        delaySeconds: Math.min(300, 5 * 2 ** Math.min(message.attempts, 6)),
      });
    }
  }
}
