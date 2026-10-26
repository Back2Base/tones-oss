# Tones

Tones learns writing style from personal samples and exposes it through MCP on Cloudflare Workers. Each deployment is private to its owner: you run your own copy on your Cloudflare account and sign in through your own Auth0 tenant.

Server-side rewriting and the file upload page are not built yet.

## Connect

Your MCP endpoint is `<PUBLIC_ORIGIN>/mcp`, where `PUBLIC_ORIGIN` is set in `workers/mcp/wrangler.jsonc`.

The site root is a small landing page with these connection steps, the tools, and the registers. It is rendered by `workers/mcp/src/landing.ts` (register descriptions come from `packages/shared`; the tool list is one entry per tool in `TOOLS`) and served with a hash-based CSP and no external resources.

In Claude.ai, add that URL as a custom connector, approve the requested access, and sign in through Auth0. In Claude Code:

```sh
claude mcp add --transport http tones https://tones.example.com/mcp
```

Then use `/mcp` to authenticate Tones.

| Tool                | Behavior                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_style_context` | Up to 20,000 input characters; optional register; retrieves and reranks exemplars with at most two per sample. The calling assistant performs the rewrite.                                                                         |
| `get_comment_style` | Batch context for 1–50 code comments (2,000 characters each, 20,000 total); register defaults to `documentation`. One profile read, one embedding call, one search; returns a compact guide and a small deduplicated exemplar set. |
| `add_sample`        | Accepts 200–200,000 characters, a title/register, and an optional source; returns a pending sample ID, or the existing one with `duplicate: true` for identical text.                                                              |
| `find_samples`      | Looks up to 50 source strings and reports which already have a sample.                                                                                                                                                             |
| `list_samples`      | Lists the signed-in user's samples, processing status, and a pagination cursor.                                                                                                                                                    |
| `delete_sample`     | Deletes an owned sample, files, chunks, and vectors while stopping ingestion and fencing late writes.                                                                                                                              |
| `get_profile`       | Returns the current profile, or measured targets with `source: measured` and `profileVersion: 0` when a learned guide is missing or stale.                                                                                         |

Registers (writing categories) are `casual`, `professional`, `documentation`, `social`, and `general`; their descriptions live in `packages/shared` and feed the classifier, tool schemas, and the collection prompt. Migration 0004 renamed the earlier `slack`, `email`, and `doc` to `casual`, `professional`, and `documentation`. Retrieval uses Qwen embeddings, an optional GLM register classifier, namespace/register filtering, and semantic/style reranking. Vectorize returns IDs and scores; D1 supplies current owned text and excludes deleted samples. All inference uses AI Gateway `style-mcp`. The initial profile bans em dashes; other user overrides are preserved.

## Collecting writing

The `collect_writing` prompt has the connected agent find writing you authored with its other tools (Slack, email, Drive, Notion, GitHub, and local files), shape it into categorized samples, check `find_samples` for ones already added, and show a review table. It calls `add_sample` only for what you approve. Optional arguments: `where` limits the search and `category` applies one category to everything. In Claude Code, run it as `/mcp__tones__collect_writing`.

Uploads are deduplicated by content: text is compared after normalizing line endings and outer whitespace, files byte for byte. A failed or deleted sample does not block adding the same content again.

## Authentication

Tones acts as an OAuth authorization server for MCP clients and delegates identity sign-in to Auth0 (`AUTH0_DOMAIN`). It supports discovery, dynamic registration, client ID metadata documents, PKCE, refresh tokens, and RFC 7009 revocation at the advertised token endpoint. Browser-bound single-use transactions protect consent and the upstream callback; verified Auth0 ID tokens are consumed only during sign-in.

`pnpm auth:configure` creates a dedicated Auth0 Regular Web Application named `Tones` with callback `<PUBLIC_ORIGIN>/callback`. Access requires a fixed subject in the `ALLOWED_SUBS` secret, checked again on each API request; the script fills it with the verified identities for `TONES_OWNER_EMAIL`. Different Auth0 subjects have separate sample stores, including different sign-in methods for the same email.

Scopes are `style:read`, `style:write`, and `offline_access`. Writes require `style:write`; the upload Worker's private `AUTH` binding validates the same MCP access tokens through `AuthService`. Tool arguments cannot choose a user ID. No operator upload credentials are deployed. The legacy optional phase 1 operator fallback remains in code for isolated deployments and is bypassed whenever `AUTH` is bound.

## Ingestion and deletion

`POST <ingest origin>/samples` accepts multipart `file`, `register`, and optional `title`. Use an OAuth bearer token with read/write access. `GET /samples/{sampleId}` polls the same user's status. `/health` is public on both Workers.

Uploads create a pending D1 row and R2 object. R2 notifications enter `style-r2-events`; the consumer starts an idempotent Workflow. It extracts PDF/DOCX/HTML with Workers AI, cleans text, segments it, measures deterministic features, embeds batches, upserts Vectorize, and records ready chunks in D1. Intermediate files stay in R2 and Workflow results contain small references. Failed samples have readable errors and partial index writes are cleaned up. A DLQ records exhausted start failures.

Limits are 25 MiB per upload, 200,000 extracted characters, 2,000 chunks, and 4,000 UTF-8 bytes per sentence. Token counts are estimates. Ready samples mark their register and `general` dirty and start a debounced profile rebuild. Deletion writes a durable tombstone before stopping the Workflow and removing files/index entries. Retrieval immediately excludes tombstoned samples even while Vectorize deletion propagates.

## Learned profiles

Ready samples and deletions start `RebuildProfile`, debounced per user in 10-minute buckets. Dirty registers are rebuilt; `general` pools every register. Profiles contain token-weighted target distributions, a learned prose guide from up to 40 sample-stratified chunks, and mechanical bans after at least 20 samples. Settings overrides take precedence, with em dashes banned by default. Old versions are retained. New samples arriving during a rebuild keep its result stale; reads use measured targets until a subsequent rebuild.

The write-scoped `rebuild_profile` tool returns `{ workflowId }`; an optional register rebuilds that category, otherwise it rebuilds all categories. Use it to refresh a profile immediately after a debounced request. Ingest configuration `MODEL_GUIDE` defaults to `@cf/openai/gpt-oss-120b`; guide calls use JSON-schema responses through `AI_GATEWAY_ID`, with one retry for invalid output.

## Local development

Use Node 24 and pnpm 10.18.3.

```sh
pnpm install --frozen-lockfile
pnpm types
pnpm test
pnpm typecheck
pnpm build
pnpm exec wrangler d1 migrations apply style --local --config workers/ingest/wrangler.jsonc
pnpm dev:mcp
```

Local tests use Node and the Workers Vitest runtime with local D1/R2/KV. AI and Vectorize are mocked; remote bindings are disabled. Tests cover ingestion retries, deletion races, OAuth claims/nonce/consent/allowlisting, scopes, tool validation, pagination, and concurrent user isolation. Local `wrangler dev` uses remote AI and requires Cloudflare sign-in.

Copy `workers/mcp/.dev.vars.example` to `.dev.vars` in the same directory and fill in real settings. Secrets and `.build/` are gitignored. Do not commit credentials or log bearer tokens.

## Provision and deploy

Set `PUBLIC_ORIGIN` (and the custom-domain `routes` entry, if you use one) in `workers/mcp/wrangler.jsonc`, then copy `.env.example` to `.env` and fill in your Auth0 domain, owner email, and ingest origin. `pnpm provision` replaces the placeholder D1 and KV IDs in both Worker configs with your own; set `CLOUDFLARE_ACCOUNT_ID` or sign in with Wrangler to choose the account.

```sh
pnpm exec wrangler login
pnpm provision
pnpm gateway:configure
# Uses the Auth0 plugin's CLI; sign in to the intended tenant first.
auth0 login
pnpm auth:configure
pnpm exec wrangler secret bulk workers/mcp/.dev.vars --config workers/mcp/wrangler.jsonc
pnpm deploy:mcp
pnpm deploy:ingest
```

Provisioning reuses named R2/D1/KV/Vectorize/Queue resources, updates both Worker configs, creates Vectorize metadata indexes, and applies migrations. The Workers have reciprocal service bindings; for an entirely new account, bootstrap ingestion without `AUTH`, deploy MCP, then restore `AUTH` and deploy ingestion.

Inspect R2 notification rules before running `pnpm notifications:configure`; one rule for `raw/` must target `style-r2-events`. AI Gateway `style-mcp` needs logging and caching enabled. If Wrangler lacks gateway administration permission, configure the gateway in the dashboard.

## Live checks

```sh
pnpm auth:connect
# Complete browser sign-in; credentials are saved only to ignored .build/.
pnpm test:live
pnpm test:compatibility
pnpm benchmark:mcp
pnpm auth:disconnect
```

The live check discovers all tools with the MCP SDK, ingests synthetic writing, retrieves context, exercises OAuth HTTP upload, deletes ready/pending samples, requires Vectorize deletion within 60 seconds, and rotates the refresh token. The compatibility check separately verifies the 2025-06-18 HTTP protocol. The benchmark temporarily seeds 200 synthetic one-chunk ready samples with real embeddings through admin APIs, measures repeated and distinct query latency separately, and removes its fixtures. It exits with a failure status if p95 exceeds 800 ms and requires Wrangler access to D1, Vectorize, and AI. Disconnect revokes the entire validation grant, verifies both access and refresh rejection, and removes local tokens.

The phase 1 harness is retained as `pnpm test:live:phase1` for historical isolated deployments using temporary operator credentials. Use the OAuth live check with the current production bindings.

## Current boundaries

Feature extraction includes sentence/paragraph length, vocabulary diversity, punctuation, contractions, casing, lists, fixed function words, openers, greetings/sign-offs, phrases, and emoji. Signature phrase comparison uses a small self-authored neutral reference corpus. Cross-document boilerplate detection, `restyle`, runs logging, and the upload page remain future work.

## License

MIT. See [LICENSE](LICENSE).
