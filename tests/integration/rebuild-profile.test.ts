import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { env, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import {
  aggregate,
  selectExemplars,
  deriveHardRules,
  deriveGuide,
  snapshot,
  writeProfile,
  RebuildProfile,
  type ProfileChunk,
  type RebuildParams,
} from '../../workers/ingest/src/workflows/rebuild-profile.ts';
import {
  kickProfile,
  profileWorkflowId,
  rebuildProfile,
} from '../../workers/ingest/src/rebuild.ts';
import { loadProfile } from '../../workers/mcp/src/profile.ts';
import type { McpEnv } from '../../workers/mcp/src/env.ts';
import type { IngestEnv } from '../../workers/ingest/src/env.ts';
const bindings = env as unknown as IngestEnv & {
  TEST_MIGRATIONS: D1Migration[];
};
const guide = {
  register: 'general' as const,
  voice: 'Direct',
  rules: ['Lead with the answer'],
  avoid: ['em dashes'],
  signature_phrases: [],
  formatting: 'Short paragraphs',
  examples_of_transformations: [],
};
const chunk = (sample_id: string, x = 0, tokens = 1): ProfileChunk => ({
  sample_id,
  tokens,
  text: 'Sample data',
  features: {
    wordLengthMean: x,
    punctuationPer1k: { '—': 0, ';': x },
    emojiPer1k: 0,
  },
});
const completion = (data: unknown, finish_reason = 'stop') => ({
  choices: [
    {
      message: {
        content: typeof data === 'string' ? data : JSON.stringify(data),
      },
      finish_reason,
    },
  ],
});
function makeEnv() {
  return {
    ...bindings,
    MODEL_GUIDE: '@cf/openai/gpt-oss-120b' as const,
    AI: { run: vi.fn(async () => completion(guide)) } as unknown as Ai,
    PROFILE_WORKFLOW: {
      create: vi.fn(async (p: { id: string }) => ({ id: p.id })),
    } as unknown as Workflow<RebuildParams>,
  };
}
beforeAll(async () => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  await bindings.DB.exec(
    'DELETE FROM chunks; DELETE FROM samples; DELETE FROM profiles; DELETE FROM profile_rebuild_requests; DELETE FROM settings; DELETE FROM sample_deletions;',
  );
});
it('weights population means, deviations and quantiles by tokens', () => {
  const target = aggregate([chunk('a', 0, 1), chunk('b', 4, 3)]).wordLengthMean;
  expect(target).toEqual({ mean: 3, stdev: Math.sqrt(3), p25: 0, p75: 4 });
  expect(aggregate([chunk('a')])).toHaveProperty('sentenceLength.mean');
});
it('stratifies exemplars across samples and caps them at 40', () => {
  const chunks = [
    ...Array.from({ length: 100 }, () => chunk('long')),
    chunk('short'),
  ];
  const selected = selectExemplars(chunks);
  expect(selected).toHaveLength(40);
  expect(selected[1].sample_id).toBe('short');
});
it('requires 20 distinct samples and applies settings after mechanical bans', () => {
  const chunks = Array.from({ length: 20 }, (_, i) => chunk(String(i)));
  expect(deriveHardRules(chunks.slice(1))).toEqual({ em_dash: 'banned' });
  expect(deriveHardRules(chunks)).toMatchObject({
    emoji: 'banned',
    semicolon: 'banned',
  });
  expect(
    deriveHardRules([...chunks, chunk('positive', 1)]).semicolon,
  ).toBeUndefined();
  expect(deriveHardRules(Array(20).fill(chunk('same')))).toEqual({
    em_dash: 'banned',
  });
  expect(
    deriveHardRules(chunks, { emoji: 'allowed', em_dash: 'allowed' }),
  ).toMatchObject({ emoji: 'allowed', em_dash: 'allowed' });
});
it('validates guides, retries invalid JSON once, and uses the gateway and schema', async () => {
  const e = makeEnv();
  const run = vi
    .fn()
    .mockResolvedValueOnce(completion('invalid'))
    .mockResolvedValueOnce(completion(guide));
  e.AI.run = run;
  expect(await deriveGuide(e, 'general', {}, [chunk('a')])).toEqual(guide);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenLastCalledWith(
    e.MODEL_GUIDE,
    expect.objectContaining({
      response_format: expect.objectContaining({ type: 'json_schema' }),
    }),
    { gateway: { id: e.AI_GATEWAY_ID } },
  );
  run
    .mockReset()
    .mockResolvedValueOnce(completion({ ...guide, voice: 123 }))
    .mockResolvedValueOnce(completion(guide));
  await expect(deriveGuide(e, 'general', {}, [])).resolves.toEqual(guide);
  expect(run).toHaveBeenCalledTimes(2);
});
it.each([[[]], [['em-dashes', 'Avoid em dash punctuation']]])(
  'sanitizes em-dash mentions and characters without retrying (avoid: %j)',
  async (avoid) => {
    const e = makeEnv();
    const run = vi.fn().mockResolvedValue(
      completion({
        ...guide,
        voice: 'Direct—clear',
        rules: [
          'Do not use em dashes',
          'Avoid EM-DASH punctuation',
          'Lead — then explain',
        ],
        avoid: ['Fluff—padding', ...avoid],
        signature_phrases: ['emDash aside', 'Hello—friend'],
        formatting: 'Short—spaced paragraphs',
        examples_of_transformations: [
          { generic: 'Hello — world', mine: 'Hello—there' },
        ],
      }),
    );
    e.AI.run = run;
    await expect(deriveGuide(e, 'general', {}, [])).resolves.toEqual({
      ...guide,
      voice: 'Direct, clear',
      rules: ['Lead, then explain'],
      avoid: ['Fluff, padding', avoid[0] ?? 'em dashes'],
      signature_phrases: ['Hello, friend'],
      formatting: 'Short, spaced paragraphs',
      examples_of_transformations: [
        { generic: 'Hello, world', mine: 'Hello, there' },
      ],
    });
    expect(run).toHaveBeenCalledOnce();
  },
);
it.each([
  ['schema', completion({ ...guide, voice: 123 })],
  ['schema', completion('private invalid JSON')],
  ['truncated', completion(guide, 'length')],
  ['register', completion({ ...guide, register: 'professional' })],
])('logs only the %s rejection category', async (reason, response) => {
  const e = makeEnv();
  e.AI.run = vi
    .fn()
    .mockResolvedValueOnce(response)
    .mockResolvedValueOnce(completion(guide));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(
      deriveGuide(e, 'general', {}, [chunk('private sample')]),
    ).resolves.toEqual(guide);
    expect(warn.mock.calls).toEqual([['profile_guide_invalid', { reason }]]);
  } finally {
    warn.mockRestore();
  }
});
async function seed(e: IngestEnv) {
  await e.DB.prepare(
    `INSERT INTO samples(id,user_id,title,register,r2_key,mime,bytes,status,created_at,updated_at) VALUES ('s','u','Test','casual','raw/test','text/plain',1,'ready',1,1)`,
  ).run();
  await e.DB.prepare(
    `INSERT INTO chunks(id,sample_id,user_id,register,ord,text,tokens,features_json) VALUES ('c','s','u','casual',0,'Example',10,?)`,
  )
    .bind(JSON.stringify(chunk('s', 4).features))
    .run();
  await e.DB.prepare(
    `INSERT INTO profile_rebuild_requests VALUES ('u','general',100)`,
  ).run();
}
it('writes increasing versions idempotently and preserves dirty marks arriving during inference', async () => {
  const e = makeEnv();
  await seed(e);
  const loaded = await snapshot(e, 'u', 'general', 'snapshot');
  expect(loaded.count).toBe(1);
  const data = await (await e.SAMPLES.get('snapshot'))!.json<{
    createdAt: number;
  }>();
  expect(data.createdAt).toBe(101);
  const profile = {
    ...data,
    sampleCount: 1,
    targets: aggregate([chunk('s', 4, 10)]),
    hardRules: { em_dash: 'banned' },
    guide,
  };
  await writeProfile(e, 'u', 'general', profile);
  await writeProfile(e, 'u', 'general', profile);
  const mcp = e as unknown as McpEnv;
  expect(await loadProfile(mcp, 'u', 'general')).toMatchObject({
    source: 'learned',
    profileVersion: 1,
  });
  await e.DB.prepare(`UPDATE profile_rebuild_requests SET dirty_at=102`).run();
  expect(await loadProfile(mcp, 'u', 'general')).toMatchObject({
    source: 'measured',
    profileVersion: 0,
  });
  await writeProfile(e, 'u', 'general', { ...profile, createdAt: 103 });
  expect(await loadProfile(mcp, 'u', 'general')).toMatchObject({
    source: 'learned',
    profileVersion: 2,
  });
});
it('runs the workflow steps with small results and skips clean or empty registers', async () => {
  const e = makeEnv();
  await seed(e);
  const results: unknown[] = [];
  const step = {
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
    do: async (_name: string, ...args: unknown[]) => {
      const result = await (args.at(-1) as () => Promise<unknown>)();
      results.push(result);
      return result;
    },
  } as unknown as WorkflowStep;
  const run = () =>
    RebuildProfile.prototype.run.call(
      { env: e } as unknown as RebuildProfile,
      {
        payload: { userId: 'u', bucketEnd: 600000 },
        instanceId: 'test',
      } as WorkflowEvent<RebuildParams>,
      step,
    );
  await run();
  expect(
    await loadProfile(e as unknown as McpEnv, 'u', 'general'),
  ).toMatchObject({ source: 'learned', profileVersion: 1 });
  expect(results.every((r) => JSON.stringify(r ?? null).length < 200)).toBe(
    true,
  );
  expect(e.AI.run).toHaveBeenCalledOnce();
  await run();
  expect(e.AI.run).toHaveBeenCalledOnce();
});
it('hashes Auth0 IDs into bounded debounced IDs and tolerates kick failures', async () => {
  const e = makeEnv();
  const id = await profileWorkflowId('auth0|' + 'x'.repeat(500), 600001);
  expect(id).toMatch(/^profile-[a-f0-9]{64}-1$/);
  expect(await profileWorkflowId('auth0|' + 'x'.repeat(500), 650000)).toBe(id);
  e.PROFILE_WORKFLOW.create = vi
    .fn()
    .mockRejectedValue(new Error('Unavailable'));
  await expect(kickProfile(e, 'auth0|x')).resolves.toBeUndefined();
  e.PROFILE_WORKFLOW.create = vi.fn(async (p) => ({
    id: p?.id,
  })) as unknown as typeof e.PROFILE_WORKFLOW.create;
  const a = await rebuildProfile(e, 'u', 'casual');
  const b = await rebuildProfile(e, 'u', 'casual');
  expect(a.workflowId).not.toBe(b.workflowId);
  expect(e.PROFILE_WORKFLOW.create).toHaveBeenCalledWith(
    expect.objectContaining({ params: { userId: 'u', registers: ['casual'] } }),
  );
});

it('keeps a profile stale when a ready sample is marked dirty during guide inference', async () => {
  const e = makeEnv();
  await seed(e);
  e.AI.run = vi.fn(async () => {
    await e.DB.prepare(
      'UPDATE profile_rebuild_requests SET dirty_at=101',
    ).run();
    return completion(guide);
  }) as unknown as Ai['run'];
  const step = {
    do: async (_name: string, ...args: unknown[]) =>
      (args.at(-1) as () => Promise<unknown>)(),
  } as unknown as WorkflowStep;
  await RebuildProfile.prototype.run.call(
    { env: e } as unknown as RebuildProfile,
    {
      payload: { userId: 'u', registers: ['general'] },
      instanceId: 'race',
    } as WorkflowEvent<RebuildParams>,
    step,
  );
  expect(
    await loadProfile(e as unknown as McpEnv, 'u', 'general'),
  ).toMatchObject({ source: 'measured', profileVersion: 0 });
  await RebuildProfile.prototype.run.call(
    { env: e } as unknown as RebuildProfile,
    {
      payload: { userId: 'u', registers: ['general'] },
      instanceId: 'next',
    } as WorkflowEvent<RebuildParams>,
    step,
  );
  expect(
    await loadProfile(e as unknown as McpEnv, 'u', 'general'),
  ).toMatchObject({ source: 'learned', profileVersion: 2 });
});
it('excludes tombstones and non-ready samples, and filters category snapshots', async () => {
  const e = makeEnv();
  await seed(e);
  expect((await snapshot(e, 'u', 'professional', 'other')).count).toBe(0);
  expect((await snapshot(e, 'u', 'casual', 'casual')).count).toBe(1);
  await e.DB.prepare("UPDATE samples SET status='processing'").run();
  expect((await snapshot(e, 'u', 'general', 'pending')).count).toBe(0);
  await e.DB.prepare("UPDATE samples SET status='ready'").run();
  await e.DB.prepare("INSERT INTO sample_deletions VALUES ('s','u',1)").run();
  expect((await snapshot(e, 'u', 'general', 'deleted')).count).toBe(0);
});

it.each(['em dash', 'em-dash', 'emdash'])(
  'accepts %s in avoid',
  async (avoid) => {
    const e = makeEnv();
    e.AI.run = vi
      .fn()
      .mockResolvedValue(completion({ ...guide, avoid: [avoid] }));
    await expect(deriveGuide(e, 'general', {}, [])).resolves.toMatchObject({
      avoid: [avoid],
    });
  },
);
it('rejects truncated completions and retains the response fallback', async () => {
  const e = makeEnv();
  const run = vi.fn().mockResolvedValue(completion(guide, 'length'));
  e.AI.run = run;
  await expect(deriveGuide(e, 'general', {}, [])).rejects.toThrow(
    'Truncated guide',
  );
  expect(run).toHaveBeenCalledTimes(2);
  run.mockResolvedValue({ response: JSON.stringify(guide) });
  await expect(deriveGuide(e, 'general', {}, [])).resolves.toEqual(guide);
});
it('only derives punctuation and emoji bans', () => {
  const chunks = Array.from({ length: 20 }, (_, i) => ({
    ...chunk(String(i)),
    features: {
      punctuationPer1k: { '—': 0, '–': 0, ';': 0, ellipsis: 0 },
      emojiPer1k: 0,
      functionWordFrequencies: { the: 0 },
      usesLists: false,
      lowercaseSentenceShare: 0,
      contractionsPer100: 0,
    },
  }));
  expect(deriveHardRules(chunks)).toEqual({
    em_dash: 'banned',
    en_dash: 'banned',
    semicolon: 'banned',
    ellipsis: 'banned',
    emoji: 'banned',
  });
});
it('passes the bucket end and moves kicks at the boundary into the next instance', async () => {
  const e = makeEnv();
  const now = vi.spyOn(Date, 'now').mockReturnValue(599999);
  try {
    await kickProfile(e, 'u');
    expect(e.PROFILE_WORKFLOW.create).toHaveBeenLastCalledWith({
      id: await profileWorkflowId('u', 599999),
      params: { userId: 'u', bucketEnd: 600000 },
    });
    now.mockReturnValue(600000);
    await kickProfile(e, 'u');
    expect(e.PROFILE_WORKFLOW.create).toHaveBeenLastCalledWith({
      id: await profileWorkflowId('u', 600000),
      params: { userId: 'u', bucketEnd: 1200000 },
    });
  } finally {
    now.mockRestore();
  }
});
it('covers late dirty marks in a second round with unique steps and cleans artifacts', async () => {
  const e = makeEnv();
  await seed(e);
  const names: string[] = [];
  const step = {
    sleep: vi.fn(),
    sleepUntil: vi.fn(async () => {
      await e.DB.prepare(
        'UPDATE profile_rebuild_requests SET dirty_at=200',
      ).run();
    }),
    do: async (name: string, ...args: unknown[]) => {
      names.push(name);
      return (args.at(-1) as () => Promise<unknown>)();
    },
  };
  await RebuildProfile.prototype.run.call(
    { env: e } as unknown as RebuildProfile,
    {
      payload: { userId: 'u', bucketEnd: 600000 },
      instanceId: 'late',
    } as WorkflowEvent<RebuildParams>,
    step as unknown as WorkflowStep,
  );
  expect(step.sleep).toHaveBeenCalledWith('debounce', '2 minutes');
  expect(step.sleepUntil).toHaveBeenCalledWith(
    'bucket-close',
    new Date(605000),
  );
  expect(new Set(names).size).toBe(names.length);
  expect(e.AI.run).toHaveBeenCalledTimes(2);
  expect(
    await loadProfile(e as unknown as McpEnv, 'u', 'general'),
  ).toMatchObject({ source: 'learned', profileVersion: 2 });
  expect((await e.SAMPLES.list({ prefix: 'profiles/late/' })).objects).toEqual(
    [],
  );
});
it('continues after exhausted guide retries and cleans failed, written and empty registers without manual sleeps', async () => {
  const e = makeEnv();
  await seed(e);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const step = {
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
    do: async (name: string, ...args: unknown[]) => {
      if (name === 'round-0-derive-guide-general') {
        expect(args[0]).toEqual({
          retries: { limit: 2, delay: '1 second', backoff: 'exponential' },
        });
        throw new Error('Exhausted');
      }
      return (args.at(-1) as () => Promise<unknown>)();
    },
  };
  e.AI.run = vi
    .fn()
    .mockResolvedValue(completion({ ...guide, register: 'casual' }));
  try {
    await RebuildProfile.prototype.run.call(
      { env: e } as unknown as RebuildProfile,
      {
        payload: {
          userId: 'u',
          registers: ['general', 'casual', 'professional'],
        },
        instanceId: 'failure',
      } as WorkflowEvent<RebuildParams>,
      step as unknown as WorkflowStep,
    );
    expect(
      await loadProfile(e as unknown as McpEnv, 'u', 'casual'),
    ).toMatchObject({ source: 'learned' });
    expect(warn).toHaveBeenCalledWith('profile_rebuild_register_failed', {
      register: 'general',
      round: 0,
    });
    expect(step.sleep).not.toHaveBeenCalled();
    expect(step.sleepUntil).not.toHaveBeenCalled();
    expect(
      (await e.SAMPLES.list({ prefix: 'profiles/failure/' })).objects,
    ).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});
