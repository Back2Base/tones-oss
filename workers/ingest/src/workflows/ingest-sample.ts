import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { IngestParams } from '../../../../packages/shared/src/index.ts';
import type { IngestEnv } from '../env.ts';
import {
  assertActive,
  extract,
  clean,
  segment,
  features,
  embedBatch,
  indexBatch,
  persist,
  failSample,
  retries,
  EMBED_BATCH_SIZE,
} from '../pipeline.ts';
export class IngestSample extends WorkflowEntrypoint<IngestEnv, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    const p = event.payload;
    try {
      await step.do('start', async () => {
        await assertActive(this.env, p);
        const row = await this.env.DB.prepare(
          'SELECT r2_key,register FROM samples WHERE id=? AND user_id=?',
        )
          .bind(p.sampleId, p.userId)
          .first<{ r2_key: string; register: string }>();
        if (!row || row.r2_key !== p.key || row.register !== p.register)
          throw new NonRetryableError('Sample source or owner does not match');
        await this.env.DB.prepare(
          `UPDATE samples SET status='processing',error=NULL,updated_at=? WHERE id=? AND user_id=?`,
        )
          .bind(Date.now(), p.sampleId, p.userId)
          .run();
      });
      const extracted = await step.do('extract', retries, () =>
        extract(this.env, p),
      );
      const cleaned = await step.do('clean', () =>
        clean(this.env, p, extracted.key),
      );
      const segmented = await step.do('segment', () =>
        segment(this.env, p, cleaned.key),
      );
      const measured = await step.do('features', () =>
        features(this.env, p, segmented.key, cleaned.key),
      );
      for (
        let offset = 0;
        offset < segmented.count;
        offset += EMBED_BATCH_SIZE
      ) {
        const embedded = await step.do(`embed-${offset}`, retries, () =>
          embedBatch(this.env, p, measured.key, offset),
        );
        await step.do(`index-${offset}`, retries, () =>
          indexBatch(this.env, embedded.key, p),
        );
      }
      return await step.do('persist', () =>
        persist(this.env, p, measured.key, measured.sampleKey),
      );
    } catch (error) {
      await step.do('mark-failed', retries, () =>
        failSample(this.env, p, error),
      );
      throw error;
    }
  }
}
