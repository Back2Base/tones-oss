import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Register } from '../../../packages/shared/src/index.ts';
import type { IngestEnv } from './env.ts';
import { deleteSample } from './deletion.ts';
import { addSample } from './storage.ts';
import { handleHttp } from './http.ts';
import { consumeQueue } from './queue.ts';
import { rebuildProfile } from './rebuild.ts';
export { RebuildProfile } from './workflows/rebuild-profile.ts';
export { IngestSample } from './workflows/ingest-sample.ts';

export class IngestService extends WorkerEntrypoint<IngestEnv> {
  rebuildProfile(userId: string, register?: Register) {
    return rebuildProfile(this.env, userId, register);
  }
  deleteSample(userId: string, sampleId: string) {
    return deleteSample(this.env, userId, sampleId);
  }
  addSample(
    userId: string,
    input: { text: string; title: string; register: Register; source?: string },
  ) {
    return addSample(this.env, userId, input);
  }
}
export default {
  fetch: handleHttp,
  queue: consumeQueue,
} satisfies ExportedHandler<IngestEnv>;
