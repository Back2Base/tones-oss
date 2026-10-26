import { api } from './cloudflare.ts';
const gateways = await api<{ id: string }[]>('ai-gateway/gateways');
if (!gateways.some((g) => g.id === 'style-mcp')) {
  await api('ai-gateway/gateways', 'POST', {
    id: 'style-mcp',
    cache_invalidate_on_update: false,
    cache_ttl: 86400,
    collect_logs: true,
    rate_limiting_interval: 0,
    rate_limiting_limit: 0,
  });
  console.log('Created AI Gateway style-mcp');
} else console.log('Using existing AI Gateway style-mcp');
