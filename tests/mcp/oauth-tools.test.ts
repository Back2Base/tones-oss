import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
  type D1Migration,
} from 'cloudflare:test';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { ulid } from 'ulid';
import { handleMcp, AuthService } from '../../workers/mcp/src/index.ts';
import {
  authorizationServer,
  validateAccessToken,
} from '../../workers/mcp/src/auth/provider.ts';
import { getStyleContext } from '../../workers/mcp/src/retrieval.ts';
import { extractFeatures } from '../../packages/stylometry/src/index.ts';
import type { McpEnv } from '../../workers/mcp/src/env.ts';
const bindings = env as unknown as McpEnv & { TEST_MIGRATIONS: D1Migration[] };
const origin = 'https://tones.example.com';
const contexts: ExecutionContext[] = [];
async function send(
  path: string | Request,
  init?: RequestInit,
  e: McpEnv = bindings,
) {
  const req =
    typeof path === 'string' ? new Request(new URL(path, origin), init) : path;
  const ctx = createExecutionContext();
  contexts.push(ctx);
  return handleMcp(req, e, ctx);
}
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected outbound network call');
    }),
  );
  await bindings.DB.exec(
    'DELETE FROM chunks; DELETE FROM samples; DELETE FROM sample_deletions; DELETE FROM profile_rebuild_requests; DELETE FROM profiles;',
  );
});
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(waitOnExecutionContext));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const cookies = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
async function grant(
  userId = 'auth0|allowed',
  scope = ['style:read', 'style:write'],
) {
  const oauth = authorizationServer(bindings).getOAuthApi(bindings);
  const client = await oauth.createClient({
    clientName: 'Test client',
    redirectUris: ['https://client.example/callback'],
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code'],
  });
  const verifier = 'v'.repeat(64);
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url');
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: 'https://client.example/callback',
    response_type: 'code',
    scope: scope.join(' '),
    state: 'test-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${origin}/mcp`,
  });
  const request = await oauth.parseAuthRequest(
    new Request(`${origin}/authorize?${params}`),
  );
  const completed = await oauth.completeAuthorization({
    request,
    userId: encodeURIComponent(userId),
    props: { userId },
    scope,
    metadata: {},
  });
  const code = new URL(completed.redirectTo).searchParams.get('code')!;
  const response = await send('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: 'https://client.example/callback',
      resource: `${origin}/mcp`,
    }),
  });
  expect(response.status).toBe(200);
  return {
    tokens: (await response.json()) as {
      access_token: string;
      refresh_token: string;
    },
    client,
  };
}
function fakeEnv() {
  return {
    ...bindings,
    AI: {
      run: vi.fn(async () => ({ data: [Array(1024).fill(0.1)] })),
    } as unknown as Ai,
    VECTORIZE: {
      query: vi.fn(async () => ({ matches: [], count: 0 })),
    } as unknown as VectorizeIndex,
    INGEST: {
      addSample: vi.fn(async () => ({ sampleId: ulid(), status: 'pending' })),
      rebuildProfile: vi.fn(async () => ({ workflowId: 'profile-test' })),
      deleteSample: vi.fn(async () => ({ deleted: true })),
    } as unknown as McpEnv['INGEST'],
  };
}
async function connect(token: string, e = fakeEnv()) {
  const client = new Client({ name: 'Tones test', version: '1' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    {
      authProvider: { token: async () => token },
      fetch: async (input, init) => {
        const req = new Request(
          input instanceof Request ? input : String(input),
          init,
        );
        req.headers.set('host', new URL(req.url).host);
        return send(req, undefined, e);
      },
    },
  );
  await client.connect(transport);
  return client;
}
it('publishes discovery metadata and challenges unauthenticated MCP requests', async () => {
  const response = await send('/mcp', { method: 'POST' });
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toContain(
    'resource_metadata',
  );
  const metadata = (await (
    await send('/.well-known/oauth-authorization-server')
  ).json()) as Record<string, unknown>;
  expect(metadata.issuer).toBe(origin);
  expect(metadata.client_id_metadata_document_supported).toBe(true);
  expect(metadata.registration_endpoint).toBe(`${origin}/oauth/register`);
  const resource = (await (
    await send('/.well-known/oauth-protected-resource/mcp')
  ).json()) as { resource: string };
  expect(resource.resource).toBe(`${origin}/mcp`);
});
it('enforces PKCE and rejects invalid redirects', async () => {
  const oauth = authorizationServer(bindings).getOAuthApi(bindings);
  const client = await oauth.createClient({
    redirectUris: ['https://client.example/callback'],
    tokenEndpointAuthMethod: 'none',
  });
  expect(
    (
      await send(
        `/authorize?${new URLSearchParams({ client_id: client.clientId, redirect_uri: 'https://attacker.example/callback', response_type: 'code' })}`,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await send(
        `/authorize?${new URLSearchParams({ client_id: client.clientId, redirect_uri: 'https://client.example/callback', response_type: 'code' })}`,
      )
    ).status,
  ).not.toBe(200);
});
it('requires browser-bound consent before starting upstream sign-in', async () => {
  const oauth = authorizationServer(bindings).getOAuthApi(bindings);
  const client = await oauth.createClient({
    clientName: '<script>bad</script>',
    redirectUris: ['https://client.example/callback'],
    tokenEndpointAuthMethod: 'none',
  });
  const url = `/authorize?${new URLSearchParams({ client_id: client.clientId, redirect_uri: 'https://client.example/callback', response_type: 'code', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', scope: 'style:read' })}`;
  const page = await send(url);
  const html = await page.text();
  expect(html).not.toContain('<script>bad</script>');
  expect(page.headers.get('x-frame-options')).toBe('DENY');
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];
  const body = new URLSearchParams({
    handle,
    decision: 'approve',
    scope: 'style:read',
  });
  expect((await send('/authorize', { method: 'POST', body })).status).toBe(400);
});
async function upstream(subject: string, nonceOverride?: string) {
  const oauth = authorizationServer(bindings).getOAuthApi(bindings);
  const client = await oauth.createClient({
    clientName: 'Browser client',
    redirectUris: ['https://client.example/callback'],
    tokenEndpointAuthMethod: 'none',
  });
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: 'https://client.example/callback',
    response_type: 'code',
    code_challenge: 'z'.repeat(43),
    code_challenge_method: 'S256',
    scope: 'style:read style:write',
    state: 'client-state',
  });
  const page = await send(`/authorize?${params}`);
  const html = await page.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];
  const approved = await send('/authorize', {
    method: 'POST',
    headers: { cookie: cookies(page) },
    body: new URLSearchParams([
      ['handle', handle],
      ['decision', 'approve'],
      ['scope', 'style:read'],
      ['scope', 'style:write'],
    ]),
  });
  expect(approved.status).toBe(302);
  const target = new URL(approved.headers.get('location')!);
  expect(target.hostname).toBe('auth.example.com');
  expect(target.searchParams.get('code_challenge_method')).toBe('S256');
  const pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey);
  const token = await new SignJWT({
    nonce: nonceOverride ?? target.searchParams.get('nonce'),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(subject)
    .setIssuer('https://auth.example.com/')
    .setAudience('tones-client')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey);
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === 'https://auth.example.com/oauth/token')
      return Response.json({ id_token: token });
    if (url.href === 'https://auth.example.com/.well-known/jwks.json')
      return Response.json({
        keys: [{ ...jwk, kid: 'test-key', alg: 'RS256' }],
      });
    throw new Error('Unexpected Auth0 request');
  });
  return send(
    `/callback?code=upstream-code&state=${encodeURIComponent(target.searchParams.get('state')!)}`,
    { headers: { cookie: cookies(approved) } },
  );
}
it('completes an allowed Auth0 sign-in with verified ID-token claims', async () => {
  const response = await upstream('auth0|allowed');
  expect(response.status).toBe(302);
  const target = new URL(response.headers.get('location')!);
  expect(target.origin).toBe('https://client.example');
  expect(target.searchParams.get('code')).toBeTruthy();
  expect(target.searchParams.get('iss')).toBe(origin);
});
it('refuses a signed Auth0 subject outside ALLOWED_SUBS', async () => {
  expect((await upstream('auth0|denied')).status).toBe(403);
});
it('rejects an ID token whose nonce does not match the browser transaction', async () => {
  expect((await upstream('auth0|allowed', 'wrong-nonce')).status).toBe(503);
});
it('exposes all seven tools through the SDK HTTP client and keeps identity out of arguments', async () => {
  const { tokens } = await grant();
  const e = fakeEnv();
  const client = await connect(tokens.access_token, e);
  try {
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name).sort()).toEqual([
      'add_sample',
      'delete_sample',
      'find_samples',
      'get_comment_style',
      'get_profile',
      'get_style_context',
      'list_samples',
      'rebuild_profile',
    ]);
    const output = await client.callTool({
      name: 'add_sample',
      arguments: {
        text: 'My writing. '.repeat(30),
        title: 'Test',
        register: 'documentation',
      },
    });
    expect(output.isError).not.toBe(true);
    expect(e.INGEST.addSample).toHaveBeenCalledWith(
      'auth0|allowed',
      expect.anything(),
    );
    const rebuild = await client.callTool({
      name: 'rebuild_profile',
      arguments: { register: 'casual' },
    });
    expect(rebuild.structuredContent).toEqual({ workflowId: 'profile-test' });
    expect(e.INGEST.rebuildProfile).toHaveBeenCalledWith(
      'auth0|allowed',
      'casual',
    );
    const denied = await client.callTool({
      name: 'add_sample',
      arguments: {
        userId: 'auth0|second',
        text: 'My writing. '.repeat(30),
        title: 'Test',
        register: 'documentation',
      },
    });
    expect(denied.isError).toBe(true);
    const context = await client.callTool({
      name: 'get_style_context',
      arguments: { text: 'Rewrite me', register: 'documentation' },
    });
    expect(context.isError).toBe(true);
    expect(JSON.stringify(context)).toContain('Add samples');
  } finally {
    await client.close();
  }
});
it('keeps only the rewrite tools out of client tool search', async () => {
  const { tokens } = await grant();
  const client = await connect(tokens.access_token, fakeEnv());
  try {
    const { tools } = await client.listTools();
    const alwaysLoaded = tools
      .filter((t) => t._meta?.['anthropic/alwaysLoad'] === true)
      .map((t) => t.name)
      .sort();
    expect(alwaysLoaded).toEqual(['get_comment_style', 'get_style_context']);
  } finally {
    await client.close();
  }
});
it('finds only my samples by source and skips deleted ones', async () => {
  const e = { ...fakeEnv(), ALLOWED_SUBS: 'auth0|allowed,auth0|other' };
  const [mine, deleted, foreign] = [ulid(), ulid(), ulid()];
  for (const [id, owner, source] of [
    [mine, 'auth0|allowed', 'file:///notes/a.md'],
    [deleted, 'auth0|allowed', 'file:///notes/b.md'],
    [foreign, 'auth0|other', 'file:///notes/c.md'],
  ]) {
    await e.DB.prepare(
      "INSERT INTO samples(id,user_id,title,register,source,r2_key,mime,bytes,status,created_at,updated_at) VALUES (?,?,'t','casual',?,'test','text/plain',100,'ready',1,1)",
    )
      .bind(id, owner, source)
      .run();
  }
  await e.DB.prepare(
    "INSERT INTO sample_deletions(sample_id,user_id,requested_at) VALUES (?,'auth0|allowed',1)",
  )
    .bind(deleted)
    .run();
  const { tokens } = await grant();
  const client = await connect(tokens.access_token, e);
  try {
    const result = await client.callTool({
      name: 'find_samples',
      arguments: {
        sources: [
          'file:///notes/a.md',
          'file:///notes/b.md',
          'file:///notes/c.md',
        ],
      },
    });
    const body = result.structuredContent as {
      matches: { sampleId: string; source: string }[];
      missing: string[];
    };
    expect(body.matches).toEqual([
      expect.objectContaining({ sampleId: mine, source: 'file:///notes/a.md' }),
    ]);
    expect(body.missing).toEqual(['file:///notes/b.md', 'file:///notes/c.md']);
  } finally {
    await client.close();
  }
});
it('serves the collect_writing prompt with the categories and a review step', async () => {
  const { tokens } = await grant();
  const client = await connect(tokens.access_token, fakeEnv());
  try {
    const list = await client.listPrompts();
    expect(list.prompts.map((p) => p.name)).toEqual(['collect_writing']);
    const prompt = await client.getPrompt({
      name: 'collect_writing',
      arguments: { where: '~/Documents/blog', category: 'social' },
    });
    const text = (prompt.messages[0]!.content as { text: string }).text;
    expect(text).toContain('Look only here: ~/Documents/blog');
    expect(text).toContain('Use the category social');
    for (const name of [
      'casual',
      'professional',
      'documentation',
      'social',
      'general',
    ])
      expect(text).toContain(`- ${name}: `);
    expect(text).toContain('Do not call add_sample before I answer');
  } finally {
    await client.close();
  }
});
it('rejects tool input over 20000 characters and read-only tokens cannot write', async () => {
  const { tokens } = await grant('auth0|allowed', ['style:read']);
  const e = fakeEnv();
  const client = await connect(tokens.access_token, e);
  try {
    const big = await client.callTool({
      name: 'get_style_context',
      arguments: { text: 'x'.repeat(20001), register: 'general' },
    });
    expect(big.isError).toBe(true);
    expect(JSON.stringify(big)).toContain('20000');
    const result = await client.callTool({
      name: 'delete_sample',
      arguments: { sampleId: ulid() },
    });
    expect(result.isError).toBe(true);
    expect(e.INGEST.deleteSample).not.toHaveBeenCalled();
    const rebuild = await client.callTool({
      name: 'rebuild_profile',
      arguments: {},
    });
    expect(rebuild.isError).toBe(true);
    expect(e.INGEST.rebuildProfile).not.toHaveBeenCalled();
    const auth = new AuthService(createExecutionContext(), e);
    expect(await auth.validateToken(tokens.access_token)).toBeNull();
  } finally {
    await client.close();
  }
});
it('invalidates tokens when their subject leaves the allowlist', async () => {
  const { tokens } = await grant();
  expect(
    await validateAccessToken(
      { ...bindings, ALLOWED_SUBS: 'auth0|other' },
      tokens.access_token,
    ),
  ).toBeNull();
});
it('isolates concurrent clients and paginates samples with equal timestamps', async () => {
  const e = { ...fakeEnv(), ALLOWED_SUBS: 'auth0|allowed,auth0|other' };
  const mine = [ulid(), ulid()];
  const other = ulid();
  for (const [id, owner] of [
    ...mine.map((id) => [id, 'auth0|allowed']),
    [other, 'auth0|other'],
  ]) {
    await e.DB.prepare(
      "INSERT INTO samples(id,user_id,title,register,r2_key,mime,bytes,status,created_at,updated_at) VALUES (?,?,?,'documentation','test','text/plain',100,'ready',1,1)",
    )
      .bind(id, owner, id)
      .run();
  }
  const [a, b] = await Promise.all([grant(), grant('auth0|other')]);
  const [first, second] = await Promise.all([
    connect(a.tokens.access_token, e),
    connect(b.tokens.access_token, e),
  ]);
  try {
    const [one, two] = await Promise.all([
      first.callTool({ name: 'list_samples', arguments: { limit: 1 } }),
      second.callTool({ name: 'list_samples', arguments: {} }),
    ]);
    const page = one.structuredContent as {
      samples: { id: string }[];
      nextCursor: string;
    };
    expect(page.samples).toHaveLength(1);
    expect(mine).toContain(page.samples[0].id);
    expect(
      (two.structuredContent as { samples: { id: string }[] }).samples.map(
        (s) => s.id,
      ),
    ).toEqual([other]);
    const next = await first.callTool({
      name: 'list_samples',
      arguments: { limit: 1, cursor: page.nextCursor },
    });
    const rest = next.structuredContent as {
      samples: { id: string }[];
      nextCursor: null;
    };
    expect(new Set([page.samples[0].id, rest.samples[0].id])).toEqual(
      new Set(mine),
    );
    expect(rest.nextCursor).toBeNull();
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
it('filters stale or foreign vectors and caps exemplars at two per sample', async () => {
  const e = fakeEnv();
  const id = ulid();
  const foreign = ulid();
  const text = 'I write short, clear sentences. Here is the next step.';
  await e.DB.prepare(
    `INSERT INTO samples(id,user_id,title,register,r2_key,mime,bytes,status,created_at,updated_at) VALUES (?,?,?,'documentation','raw/test','text/plain',1000,'ready',1,1)`,
  )
    .bind(id, 'auth0|allowed', 'My sample')
    .run();
  for (let n = 0; n < 3; n++)
    await e.DB.prepare(
      `INSERT INTO chunks(id,sample_id,user_id,register,ord,text,tokens,features_json) VALUES (?,?,?,'documentation',?,?,100,?)`,
    )
      .bind(
        `${id}-${n}`,
        id,
        'auth0|allowed',
        n,
        text,
        JSON.stringify(extractFeatures(text)),
      )
      .run();
  e.VECTORIZE.query = vi.fn(async () => ({
    matches: [0, 1, 2]
      .map((n) => ({
        id: `${id}-${n}`,
        score: 0.9,
        metadata: { sampleId: id, text },
      }))
      .concat([
        {
          id: foreign,
          score: 1,
          metadata: { sampleId: foreign, text: 'Someone else' },
        },
      ]),
    count: 4,
  })) as unknown as VectorizeIndex['query'];
  const result = await getStyleContext(
    e,
    'auth0|allowed',
    'test',
    'documentation',
    6,
  );
  expect(result.exemplars).toHaveLength(2);
  expect(result.exemplars.every((x) => x.sampleTitle === 'My sample')).toBe(
    true,
  );
  expect(e.VECTORIZE.query).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      namespace: 'auth0|allowed',
      filter: { register: 'documentation' },
      returnMetadata: 'none',
    }),
  );
});
async function seedSample(
  e: McpEnv,
  title: string,
  texts: string[],
  owner = 'auth0|allowed',
) {
  const id = ulid();
  await e.DB.prepare(
    `INSERT INTO samples(id,user_id,title,register,r2_key,mime,bytes,status,created_at,updated_at) VALUES (?,?,?,'documentation','raw/test','text/plain',1000,'ready',1,1)`,
  )
    .bind(id, owner, title)
    .run();
  for (const [n, text] of texts.entries())
    await e.DB.prepare(
      `INSERT INTO chunks(id,sample_id,user_id,register,ord,text,tokens,features_json) VALUES (?,?,?,'documentation',?,?,100,?)`,
    )
      .bind(
        `${id}-${n}`,
        id,
        owner,
        n,
        text,
        JSON.stringify(extractFeatures(text)),
      )
      .run();
  return texts.map((_, n) => `${id}-${n}`);
}
function batchEmbeddings(e: ReturnType<typeof fakeEnv>) {
  e.AI.run = vi.fn(async (_model: string, input: { queries: string[] }) => ({
    data: input.queries.map((_, i) =>
      Array.from({ length: 1024 }, (_, d) => (d === i ? 1 : 0.1)),
    ),
  })) as unknown as Ai['run'];
}
it('styles a batch of comments with one embedding call, one search, and deduplicated exemplars', async () => {
  const e = fakeEnv();
  batchEmbeddings(e);
  const shared = 'Run the migration first. Then restart the worker.';
  const ids = [
    ...(await seedSample(e, 'Runbook', [shared, 'Keep it short. Say why.'])),
    ...(await seedSample(e, 'Copy of runbook', [shared])),
  ];
  e.VECTORIZE.query = vi.fn(async () => ({
    matches: ids.map((id, n) => ({ id, score: 0.9 - n * 0.01 })),
    count: ids.length,
  })) as unknown as VectorizeIndex['query'];
  const { tokens } = await grant('auth0|allowed', ['style:read']);
  const client = await connect(tokens.access_token, e);
  try {
    const output = await client.callTool({
      name: 'get_comment_style',
      arguments: {
        comments: [
          '// TODO(alex): retry when the queue is full',
          '/** Parses the cursor. */',
          '// TODO(alex): retry when the queue is full',
        ],
      },
    });
    expect(output.isError).not.toBe(true);
    // Duplicate comments are embedded once; the default register skips the classifier.
    expect(e.AI.run).toHaveBeenCalledTimes(1);
    expect(e.AI.run).toHaveBeenCalledWith(
      bindings.MODEL_EMBED,
      {
        queries: [
          '// TODO(alex): retry when the queue is full',
          '/** Parses the cursor. */',
        ],
      },
      expect.anything(),
    );
    expect(e.VECTORIZE.query).toHaveBeenCalledTimes(1);
    expect(e.VECTORIZE.query).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        namespace: 'auth0|allowed',
        filter: { register: 'documentation' },
      }),
    );
    const body = output.structuredContent as {
      register: string;
      commentCount: number;
      guide: Record<string, unknown>;
      targets: Record<string, unknown>;
      hardRules: Record<string, string>;
      exemplars: { text: string; sampleTitle: string }[];
      instruction: string;
    };
    expect(body.register).toBe('documentation');
    expect(body.commentCount).toBe(3);
    expect(body.exemplars.map((x) => x.text).sort()).toEqual(
      ['Keep it short. Say why.', shared].sort(),
    );
    expect(Object.keys(body.guide).sort()).toEqual(['avoid', 'rules', 'voice']);
    expect(Object.keys(body.targets)).not.toContain('paragraphLength.mean');
    expect(body.hardRules.em_dash).toBe('banned');
    expect(body.instruction).toContain('TODO');
    expect(body.instruction).toContain('Never use em dashes');
    expect(JSON.parse((output.content as { text: string }[])[0]!.text)).toEqual(
      body,
    );
  } finally {
    await client.close();
  }
});
it('validates comment batch limits before any inference', async () => {
  const e = fakeEnv();
  const { tokens } = await grant();
  const client = await connect(tokens.access_token, e);
  try {
    for (const [comments, limit] of [
      [[], ''],
      [Array(51).fill('// x'), '50'],
      [['x'.repeat(2001)], '2000'],
      [Array(11).fill('x'.repeat(1900)), '20000'],
      [['   '], ''],
    ] as const) {
      const output = await client.callTool({
        name: 'get_comment_style',
        arguments: { comments },
      });
      expect(output.isError).toBe(true);
      expect(JSON.stringify(output)).toContain(limit);
    }
    const extra = await client.callTool({
      name: 'get_comment_style',
      arguments: { comments: ['// x'], userId: 'auth0|second' },
    });
    expect(extra.isError).toBe(true);
    expect(e.AI.run).not.toHaveBeenCalled();
    expect(e.VECTORIZE.query).not.toHaveBeenCalled();
  } finally {
    await client.close();
  }
});
it('scopes comment styling to the signed-in user and requires ready samples', async () => {
  const e = { ...fakeEnv(), ALLOWED_SUBS: 'auth0|allowed,auth0|other' };
  batchEmbeddings(e);
  await seedSample(e, 'Other user', ['Not mine.'], 'auth0|other');
  const { tokens } = await grant();
  const client = await connect(tokens.access_token, e);
  try {
    const output = await client.callTool({
      name: 'get_comment_style',
      arguments: { comments: ['// increment the counter'] },
    });
    expect(output.isError).toBe(true);
    expect(JSON.stringify(output)).toContain('Add samples');
    expect(e.AI.run).not.toHaveBeenCalled();
  } finally {
    await client.close();
  }
  const other = await grant('auth0|other');
  const second = await connect(other.tokens.access_token, e);
  try {
    const output = await second.callTool({
      name: 'get_comment_style',
      arguments: { comments: ['// increment the counter'] },
    });
    expect(output.isError).not.toBe(true);
    expect(e.VECTORIZE.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ namespace: 'auth0|other' }),
    );
  } finally {
    await second.close();
  }
  const writeOnly = await grant('auth0|allowed', ['style:write']);
  await expect(connect(writeOnly.tokens.access_token, e)).rejects.toThrow();
});
