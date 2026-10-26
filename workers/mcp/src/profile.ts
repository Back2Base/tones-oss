import type { Register } from '../../../packages/shared/src/index.ts';
import type { McpEnv } from './env.ts';
export const CORE_FEATURES = [
  'sentenceLength.mean',
  'sentenceLength.p50',
  'paragraphLength.mean',
  'wordLengthMean',
  'movingAverageTtr',
  'contractionsPer100',
] as const;
export type Target = {
  mean: number;
  stdev: number;
  p25?: number;
  p75?: number;
};
export type Targets = Record<string, Target>;
export class ToolError extends Error {}
export async function loadProfile(
  env: McpEnv,
  userId: string,
  register: Register,
) {
  const profile = await env.DB.prepare(
    `SELECT p.* FROM profiles p WHERE p.user_id=? AND p.register=?
    AND NOT EXISTS (SELECT 1 FROM profile_rebuild_requests r WHERE r.user_id=p.user_id AND r.register=p.register AND r.dirty_at>=p.created_at)
    ORDER BY p.version DESC LIMIT 1`,
  )
    .bind(userId, register)
    .first<{
      version: number;
      sample_count: number;
      targets_json: string;
      guide_json: string;
      hard_rules_json: string;
      created_at: number;
    }>();
  const settings = await env.DB.prepare(
    'SELECT overrides_json FROM settings WHERE user_id=?',
  )
    .bind(userId)
    .first<{ overrides_json: string }>();
  const overrides: Record<string, string> = {
    em_dash: 'banned',
    ...(settings ? JSON.parse(settings.overrides_json) : {}),
  };
  if (profile)
    return {
      profileVersion: profile.version,
      register,
      source: 'learned' as const,
      sampleCount: profile.sample_count,
      targets: JSON.parse(profile.targets_json) as Targets,
      guide: JSON.parse(profile.guide_json) as Record<string, unknown>,
      hardRules: { ...JSON.parse(profile.hard_rules_json), ...overrides },
    };
  const columns = CORE_FEATURES.flatMap((key, i) => [
    `1.0*SUM(COALESCE(json_extract(c.features_json,'$.${key}'),0)*c.tokens)/SUM(c.tokens) AS m${i}`,
    `1.0*SUM(COALESCE(json_extract(c.features_json,'$.${key}'),0)*COALESCE(json_extract(c.features_json,'$.${key}'),0)*c.tokens)/SUM(c.tokens) AS q${i}`,
  ]).join(',');
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT c.sample_id) AS sample_count,${columns} FROM chunks c
    JOIN samples s ON s.id=c.sample_id AND s.user_id=c.user_id
    WHERE c.user_id=? AND s.status='ready' AND c.tokens>0
    AND NOT EXISTS (SELECT 1 FROM sample_deletions d WHERE d.sample_id=s.id)
    ${register === 'general' ? '' : 'AND c.register=?'}`,
  )
    .bind(userId, ...(register === 'general' ? [] : [register]))
    .first<Record<string, number | null>>();
  const count = Number(row?.sample_count ?? 0);
  const targets: Targets = Object.fromEntries(
    CORE_FEATURES.map((key, i) => {
      const mean = Number(row?.[`m${i}`] ?? 0);
      return [
        key,
        {
          mean,
          stdev: Math.sqrt(
            Math.max(0, Number(row?.[`q${i}`] ?? 0) - mean ** 2),
          ),
        },
      ];
    }),
  );
  return {
    profileVersion: 0,
    register,
    source: 'measured' as const,
    sampleCount: count,
    targets,
    guide: {
      register,
      voice:
        'Use the supplied writing samples and measured targets as evidence. A learned prose style guide has not been built yet.',
      rules: [],
      avoid: overrides.em_dash === 'banned' ? ['em dashes'] : [],
      signature_phrases: [],
      formatting: 'Follow the formatting of the supplied samples.',
      examples_of_transformations: [],
    },
    hardRules: overrides,
  };
}
export function styleDistance(
  features: Record<string, unknown>,
  targets: Targets,
) {
  const values = Object.entries(targets).flatMap(([key, target]) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (v, k) =>
          v && typeof v === 'object'
            ? (v as Record<string, unknown>)[k]
            : undefined,
        features,
      );
    if (typeof value !== 'number' || !Number.isFinite(target.mean)) return [];
    const scale = Math.max(
      target.stdev || 0,
      Math.abs(target.mean) * 0.1,
      0.01,
    );
    return [Math.abs(value - target.mean) / scale];
  });
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
