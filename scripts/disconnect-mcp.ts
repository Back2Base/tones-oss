import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const path = '.build/mcp-session.json';
const session = JSON.parse(readFileSync(path, 'utf8'));
const revoked = await fetch(`${session.origin}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: session.clientId,
    token: session.tokens.refresh_token,
    token_type_hint: 'refresh_token',
  }),
  signal: AbortSignal.timeout(15000),
});
assert.equal(revoked.status, 200, 'Grant revocation failed');
const deadline = Date.now() + 90000;
let status = 0;
do {
  const check = await fetch(`${session.origin}/mcp`, {
    headers: { authorization: `Bearer ${session.tokens.access_token}` },
    signal: AbortSignal.timeout(15000),
  });
  status = check.status;
  if (status === 401) break;
  await new Promise((r) => setTimeout(r, 3000));
} while (Date.now() < deadline);
assert.equal(status, 401, 'Revocation has not propagated');
const refresh = await fetch(`${session.origin}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: session.clientId,
    grant_type: 'refresh_token',
    refresh_token: session.tokens.refresh_token,
    resource: `${session.origin}/mcp`,
  }),
  signal: AbortSignal.timeout(15000),
});
assert.equal(refresh.status, 400, 'Revoked refresh token still works');
unlinkSync(path);
const report = JSON.parse(
  readFileSync('docs/phase2-live-acceptance.json', 'utf8'),
);
report.validationTokensRevoked = true;
report.revokedAccessStatus = 401;
report.revokedRefreshStatus = 400;
writeFileSync(
  'docs/phase2-live-acceptance.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  'Validation grant revoked; access and refresh rejected; local tokens removed',
);
