import { REGISTER_DESCRIPTIONS } from '../../../packages/shared/src/index.ts';
// One entry per MCP tool shown on the landing page; adding a tool is one line.
export const TOOLS: Record<string, string> = {
  get_style_context:
    'Returns your style profile and the closest passages from your own writing, so the assistant can rewrite text in your voice.',
  get_comment_style:
    'Returns compact style context for a batch of up to 50 code comments in one call.',
  add_sample:
    'Adds a piece of your writing (200 to 200,000 characters) with a title and register.',
  find_samples:
    'Checks which sources, such as links or file paths, already have a sample.',
  list_samples: 'Lists your samples with their processing status.',
  delete_sample:
    'Deletes one of your samples along with its files and index entries.',
  get_profile: 'Returns your current style profile and measured targets.',
  rebuild_profile:
    'Rebuilds your learned style profile now instead of waiting for the next scheduled rebuild.',
};
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1c1a;--muted:#5d5a53;--line:#e2ded5;--code:#f1eee7;--accent:#2f5d50;--focus:#1f6feb}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--fg:#ecebe6;--muted:#a7a49b;--line:#2e2d29;--code:#1e1d1a;--accent:#8cc7b3;--focus:#79b8ff}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:1.0625rem/1.6 ui-serif,Georgia,Cambria,"Times New Roman",serif}
main{max-width:42rem;margin:0 auto;padding:4rem 1.25rem 3rem}
header{margin-bottom:3rem}
h1{font-size:2.5rem;line-height:1.1;letter-spacing:-.02em;margin:0 0 1rem;font-weight:600}
h2{font:600 .8125rem/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:3rem 0 1rem;padding-top:1.5rem;border-top:1px solid var(--line)}
h3{font-size:1.0625rem;margin:1.75rem 0 .5rem;font-weight:600}
p,ol{margin:0 0 1rem}
.lede{font-size:1.25rem;color:var(--muted);margin:0}
a{color:var(--accent);text-underline-offset:.15em}
code,.cmd{font:.875rem/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:var(--code);padding:.1em .35em;border-radius:4px}
.copy{display:flex;align-items:stretch;border:1px solid var(--line);border-radius:8px;background:var(--code);margin:0 0 1rem}
.cmd{flex:1;min-width:0;margin:0;padding:.75rem .9rem;overflow-x:auto;white-space:pre}
button{font:600 .8125rem/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:transparent;border:0;border-left:1px solid var(--line);border-radius:0 8px 8px 0;padding:0 1rem;cursor:pointer;min-width:5rem}
button:hover{color:var(--accent)}
a:focus-visible,button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
ol{padding-left:1.25rem}
li{margin:.25rem 0}
dl{margin:0}
dt{margin-top:1.25rem}
dt code{font-weight:600;background:none;padding:0;color:var(--accent)}
dd{margin:.25rem 0 0;color:var(--muted)}
footer{margin-top:3.5rem;padding-top:1.5rem;border-top:1px solid var(--line);color:var(--muted);font-size:.9375rem}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:30rem){main{padding-top:2.5rem}h1{font-size:2rem}.lede{font-size:1.125rem}}
`;
const SCRIPT = `
const status=document.getElementById('copy-status');
if(navigator.clipboard)for(const b of document.querySelectorAll('button[data-copy]')){
b.hidden=false;
b.addEventListener('click',async()=>{
const text=document.getElementById(b.dataset.copy).textContent;
try{await navigator.clipboard.writeText(text);b.textContent='Copied';status.textContent='Copied to clipboard'}
catch{b.textContent='Failed';status.textContent='Copy failed'}
setTimeout(()=>{b.textContent='Copy'},1500);
});
}
`;
const copyable = (id: string, label: string, text: string) =>
  `<div class="copy"><pre class="cmd" id="${id}">${escape(text)}</pre><button type="button" data-copy="${id}" aria-label="Copy ${label}" hidden>Copy</button></div>`;
export function landingPage(origin: string) {
  const endpoint = `${origin}/mcp`;
  const definitions = (entries: [string, string][]) =>
    entries
      .map(
        ([name, text]) =>
          `<dt><code>${escape(name)}</code></dt><dd>${escape(text)}</dd>`,
      )
      .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tones</title><meta name="description" content="Tones learns your writing style from samples and serves it to AI assistants over MCP.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%232f5d50'/%3E%3C/svg%3E">
<style>${STYLE}</style></head>
<body><main>
<header><h1>Tones</h1>
<p class="lede">Tones learns how you write from samples of your own writing and serves that style to AI assistants over MCP, so drafts they write for you sound like you.</p></header>
<section aria-labelledby="connect"><h2 id="connect">Connect</h2>
<p>MCP endpoint</p>
${copyable('endpoint', 'MCP endpoint', endpoint)}
<h3>Claude Code</h3>
${copyable('claude-code', 'Claude Code command', `claude mcp add --transport http tones ${endpoint}`)}
<p>Then run <code>/mcp</code> in Claude Code and choose Tones to sign in.</p>
<h3>Claude.ai</h3>
<ol><li>Open Settings, then Connectors.</li><li>Choose Add custom connector, name it Tones, and paste the endpoint above.</li><li>Select Connect, approve the requested access, and sign in.</li></ol>
<p>Access is limited to approved accounts.</p>
<p class="sr" role="status" aria-live="polite" id="copy-status"></p></section>
<section aria-labelledby="tools"><h2 id="tools">Tools</h2>
<dl>${definitions(Object.entries(TOOLS))}</dl>
<p>The <code>collect_writing</code> prompt helps the assistant gather writing you authored from its other connections, then asks you to approve each sample before adding it.</p></section>
<section aria-labelledby="registers"><h2 id="registers">Registers</h2>
<p>Each sample belongs to a register, the kind of writing it is. Style context can be requested for one register or for all of them.</p>
<dl>${definitions(Object.entries(REGISTER_DESCRIPTIONS))}</dl></section>
<footer><p>Tones runs on Cloudflare Workers. Service status: <a href="/health">/health</a>.</p></footer>
</main><script>${SCRIPT}</script></body></html>`;
}
const sha256 = async (s: string) =>
  `'sha256-${Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('base64')}'`;
let csp: Promise<string> | undefined;
const contentSecurityPolicy = () =>
  (csp ??= Promise.all([sha256(STYLE), sha256(SCRIPT)]).then(
    ([style, script]) =>
      `default-src 'none'; style-src ${style}; script-src ${script}; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  ));
export async function landing(request: Request, origin: string) {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': await contentSecurityPolicy(),
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  return new Response(request.method === 'HEAD' ? null : landingPage(origin), {
    headers,
  });
}
