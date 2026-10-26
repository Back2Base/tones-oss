import { parse } from 'jsonc-parser';
import { readFileSync } from 'node:fs';
const mcp = parse(
  readFileSync(
    new URL('../workers/mcp/wrangler.jsonc', import.meta.url),
    'utf8',
  ),
);
// The deployed origin is configured once, in the MCP Worker's vars.
export const publicOrigin: string =
  process.env.MCP_ORIGIN ?? mcp.vars.PUBLIC_ORIGIN;
export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env (see .env.example)`);
  return value;
}
