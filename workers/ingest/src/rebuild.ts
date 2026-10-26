import {
  REGISTERS,
  type Register,
} from '../../../packages/shared/src/index.ts';
import type { IngestEnv } from './env.ts';
export async function profileWorkflowId(userId: string, now = Date.now()) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(userId),
  );
  return `profile-${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}-${Math.floor(now / 600000)}`;
}
export async function kickProfile(env: IngestEnv, userId: string) {
  const now = Date.now();
  try {
    await env.PROFILE_WORKFLOW.create({
      id: await profileWorkflowId(userId, now),
      params: { userId, bucketEnd: (Math.floor(now / 600000) + 1) * 600000 },
    });
  } catch (error) {
    if (!/already exists/i.test(String(error)))
      console.warn('profile_rebuild_start_failed');
  }
}
export async function rebuildProfile(
  env: IngestEnv,
  userId: string,
  register?: Register,
) {
  const instance = await env.PROFILE_WORKFLOW.create({
    id: `profile-${crypto.randomUUID()}`,
    params: { userId, registers: register ? [register] : [...REGISTERS] },
  });
  return { workflowId: instance.id };
}
