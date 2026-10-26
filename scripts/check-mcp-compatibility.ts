import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const session = JSON.parse(readFileSync('.build/mcp-session.json', 'utf8'));
async function rpc(id: number, method: string, params: unknown = {}) {
  const response = await fetch(`${session.origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.tokens.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const result = JSON.parse(
    response.headers.get('content-type')?.includes('text/event-stream')
      ? raw
          .split('\n')
          .find((l) => l.startsWith('data:'))!
          .slice(5)
      : raw,
  );
  assert.ok(!result.error, JSON.stringify(result.error));
  return result.result;
}
const initialized = await rpc(1, 'initialize', {
  protocolVersion: '2025-06-18',
  clientInfo: { name: 'Tones legacy protocol check', version: '1' },
  capabilities: {},
});
assert.equal(initialized.protocolVersion, '2025-06-18');
const tools = await rpc(2, 'tools/list');
assert.equal(tools.tools.length, 5);
const report = JSON.parse(
  readFileSync('docs/phase2-live-acceptance.json', 'utf8'),
);
report.legacyProtocol = '2025-06-18 initialize and tools/list passed over HTTP';
report.claudeClientAcceptance =
  'Pending actual Claude.ai and Claude Code connection checks';
writeFileSync(
  'docs/phase2-live-acceptance.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  'Legacy 2025-06-18 HTTP protocol: initialize and tools/list passed',
);
