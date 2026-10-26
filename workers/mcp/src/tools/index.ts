import { completable, McpServer } from '@modelcontextprotocol/server';
import { getMcpAuthContext } from 'agents/mcp/server';
import { z } from 'zod';
import {
  LIMITS,
  REGISTER_DESCRIPTIONS,
  REGISTERS,
} from '../../../../packages/shared/src/index.ts';
import { getCommentStyle } from '../comments.ts';
import type { McpEnv } from '../env.ts';
import { getStyleContext } from '../retrieval.ts';
import { loadProfile, ToolError } from '../profile.ts';
import { collectWritingPrompt } from './collect.ts';
const categories = Object.entries(REGISTER_DESCRIPTIONS)
  .map(([name, description]) => `${name} (${description})`)
  .join('; ');
const register = z.enum(REGISTERS).describe(`Writing category: ${categories}`);
const sampleId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const result = (payload: Record<string, unknown>) => ({
  structuredContent: payload,
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});
function identity() {
  const auth = getMcpAuthContext()?.props;
  if (typeof auth?.userId !== 'string')
    throw new Error('Authenticated identity is missing');
  return auth.userId;
}
export function createServer(env: McpEnv, scopes: string[]) {
  const server = new McpServer({ name: 'Tones', version: '0.3.0' });
  function tool<T extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: T,
    write: boolean,
    callback: (
      input: z.output<z.ZodObject<T>>,
      userId: string,
    ) => Promise<Record<string, unknown>>,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.object(inputSchema).strict(),
        annotations: {
          readOnlyHint: !write,
          destructiveHint: name === 'delete_sample',
          idempotentHint: !['add_sample', 'rebuild_profile'].includes(name),
          openWorldHint: false,
        },
      },
      async (input) => {
        try {
          const userId = identity();
          if (write && !scopes.includes('style:write'))
            throw new ToolError(
              'This connection needs style:write permission. Reconnect Tones and approve writing-sample access.',
            );
          return result(await callback(input, userId));
        } catch (error) {
          const message =
            error instanceof ToolError
              ? error.message
              : 'Tones could not complete this request. Please retry.';
          if (!(error instanceof ToolError))
            console.error('mcp_tool_failed', {
              tool: name,
              name: error instanceof Error ? error.name : 'UnknownError',
            });
          return { ...result({ error: message }), isError: true };
        }
      },
    );
  }
  tool(
    'get_style_context',
    'Retrieve my style evidence and matching samples, then rewrite the user text yourself. Preserve meaning, facts, names, numbers, and links. This tool supplies context; it does not rewrite text.',
    {
      text: z.string().min(1).max(20000, 'The text limit is 20000 characters'),
      register: register.optional(),
      k: z.number().int().min(1).max(12).default(6),
    },
    false,
    async (input, userId) =>
      getStyleContext(env, userId, input.text, input.register, input.k),
  );
  tool(
    'get_comment_style',
    'Retrieve my style evidence once for a batch of code comments, then rewrite each comment yourself. Keep identifiers, code references, TODO tags, and meaning unchanged. Prefer this over calling get_style_context per comment.',
    {
      comments: z
        .array(
          z
            .string()
            .trim()
            .min(1)
            .max(
              LIMITS.commentMaxChars,
              `The per-comment limit is ${LIMITS.commentMaxChars} characters`,
            ),
        )
        .min(1)
        .max(
          LIMITS.commentMaxItems,
          `The limit is ${LIMITS.commentMaxItems} comments per call`,
        )
        .refine(
          (list) =>
            list.reduce((n, c) => n + c.length, 0) <= LIMITS.rewriteMaxChars,
          `The combined comment limit is ${LIMITS.rewriteMaxChars} characters`,
        ),
      register: z
        .enum(REGISTERS)
        .default('documentation')
        .describe(`Writing category, default documentation: ${categories}`),
      k: z.number().int().min(1).max(8).default(4),
    },
    false,
    async (input, userId) =>
      getCommentStyle(env, userId, input.comments, input.register, input.k),
  );
  tool(
    'add_sample',
    'Add a writing sample to learn my style. Processing runs asynchronously. Use list_samples to check when it is ready. Text identical to a sample I already have returns that sample with duplicate true instead of adding another.',
    {
      text: z.string().min(200).max(200000),
      title: z.string().trim().min(1).max(300),
      register,
      source: z.string().max(2000).optional(),
    },
    true,
    async (input, userId) => {
      const { sampleId, status, duplicate } = await env.INGEST.addSample(
        userId,
        input,
      );
      return { sampleId, status, duplicate };
    },
  );
  tool(
    'find_samples',
    'Check which sources already have a sample, before adding writing. Pass the exact source strings you would give add_sample.',
    {
      // D1 binds at most 100 parameters; one is the user ID.
      sources: z.array(z.string().min(1).max(2000)).min(1).max(50),
    },
    false,
    async (input, userId) => {
      const sources = [...new Set(input.sources)];
      const rows = await env.DB.prepare(
        `SELECT s.source,s.id,s.title,s.register,s.status FROM samples s WHERE s.user_id=? AND s.source IN (${sources.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM sample_deletions d WHERE d.sample_id=s.id) ORDER BY s.created_at DESC`,
      )
        .bind(userId, ...sources)
        .all<{
          source: string;
          id: string;
          title: string;
          register: string;
          status: string;
        }>();
      return {
        matches: rows.results.map((r) => ({
          source: r.source,
          sampleId: r.id,
          title: r.title,
          register: r.register,
          status: r.status,
        })),
        missing: sources.filter(
          (source) => !rows.results.some((r) => r.source === source),
        ),
      };
    },
  );
  tool(
    'delete_sample',
    'Permanently delete one of my samples and its chunks, embeddings, and stored files.',
    { sampleId },
    true,
    async (input, userId) => {
      const { deleted } = await env.INGEST.deleteSample(userId, input.sampleId);
      return { deleted };
    },
  );
  tool(
    'rebuild_profile',
    'Rebuild my learned style profiles asynchronously.',
    { register: register.optional() },
    true,
    async (input, userId) => {
      const { workflowId } = await env.INGEST.rebuildProfile(
        userId,
        input.register,
      );
      return { workflowId };
    },
  );
  tool(
    'get_profile',
    'Read my current style profile. When no current learned guide is available, this returns measured targets with source measured and profileVersion 0.',
    { register: register.default('general') },
    false,
    async (input, userId) => loadProfile(env, userId, input.register),
  );
  tool(
    'list_samples',
    'List only my writing samples and processing status. Follow nextCursor to paginate.',
    {
      register: register.optional(),
      status: z.enum(['pending', 'processing', 'ready', 'failed']).optional(),
      cursor: z.string().max(512).optional(),
      limit: z.number().int().min(1).max(100).default(25),
    },
    false,
    async (input, userId) => {
      let cursor: { createdAt: number; id: string } | undefined;
      if (input.cursor) {
        try {
          cursor = JSON.parse(
            Buffer.from(input.cursor, 'base64url').toString('utf8'),
          ) as typeof cursor;
        } catch {
          throw new ToolError('Invalid pagination cursor');
        }
        if (
          !cursor ||
          !Number.isSafeInteger(cursor.createdAt) ||
          !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(cursor.id)
        )
          throw new ToolError('Invalid pagination cursor');
      }
      const params: (string | number)[] = [userId];
      const clauses = [
        's.user_id=?',
        'NOT EXISTS (SELECT 1 FROM sample_deletions d WHERE d.sample_id=s.id)',
      ];
      if (input.register) {
        clauses.push('s.register=?');
        params.push(input.register);
      }
      if (input.status) {
        clauses.push('s.status=?');
        params.push(input.status);
      }
      if (cursor) {
        clauses.push('(s.created_at<? OR (s.created_at=? AND s.id<?))');
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      const rows = await env.DB.prepare(
        `SELECT s.id,s.title,s.register,s.source,s.status,s.error,s.chunk_count,s.word_count,s.created_at,s.updated_at FROM samples s WHERE ${clauses.join(' AND ')} ORDER BY s.created_at DESC,s.id DESC LIMIT ?`,
      )
        .bind(...params, input.limit + 1)
        .all<{ id: string; created_at: number } & Record<string, unknown>>();
      const more = rows.results.length > input.limit;
      const samples = rows.results.slice(0, input.limit);
      const last = samples.at(-1);
      return {
        samples,
        nextCursor:
          more && last
            ? Buffer.from(
                JSON.stringify({ createdAt: last.created_at, id: last.id }),
              ).toString('base64url')
            : null,
      };
    },
  );
  server.registerPrompt(
    'collect_writing',
    {
      title: 'Collect my writing for Tones',
      description:
        'Find writing I authored through your other tools and local files, show it to me for review, and add only what I approve.',
      argsSchema: z.object({
        where: z
          .string()
          .max(2000)
          .optional()
          .describe(
            "Where to look, e.g. 'my Slack messages from last month' or '~/Documents/blog'. Empty: every source you can reach.",
          ),
        category: completable(
          z
            .string()
            .max(40)
            .optional()
            .describe(
              `Category to use for everything found: ${REGISTERS.join(', ')}`,
            ),
          (value) => REGISTERS.filter((r) => r.startsWith(value ?? '')),
        ),
      }),
    },
    ({ where, category }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: collectWritingPrompt(where, category),
          },
        },
      ],
    }),
  );
  return server;
}
