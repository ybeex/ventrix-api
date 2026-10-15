// Endpoint latency probe (WS5): node scripts/measure-endpoints.mjs  (env: BASE, SLUG, EMAIL, PASSWORD, N)
const BASE = process.env.BASE ?? 'http://localhost:3000'; const N = Number(process.env.N ?? 15);
const slug = process.env.SLUG ?? 'load-big'; const email = process.env.EMAIL ?? `admin@${slug}.test`; const password = process.env.PASSWORD ?? 'Load-Test-Password-42';
const login = await fetch(`${BASE}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgSlug: slug, email, password }) });
const { token } = await login.json(); const h = { authorization: `Bearer ${token}` };
const probe = async (path) => { const t = performance.now(); const r = await fetch(`${BASE}/v1${path}`, { headers: h, signal: AbortSignal.timeout(Number(process.env.TIMEOUT_MS ?? 60000)) }).catch((e) => ({ status: 'ERR ' + e.name, text: async () => '' })); const body = await r.text(); return { ms: performance.now() - t, status: r.status, bytes: body.length }; };
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const paths = (process.env.PATHS ? process.env.PATHS.split(',') : [
  '/dashboard', '/collections', '/outstanding?limit=50', '/overdue?limit=50', '/low-stock?includeNear=true&limit=50', '/items?limit=50', '/items?q=grinder&limit=25',
  '/items?status=checked_out&limit=50', '/holders?q=load%20holder%2012', '/activity?limit=50', '/activity?limit=50&action=transaction.*', '/activity?limit=50&category=Security',
  '/reports/transactions?limit=50', '/reports/inventory?limit=50', '/shelves', '/notifications/unread-count', '/auth/me']);
const out = [];
for (const p of paths) { const first = await probe(p); const ms = []; let status = first.status, bytes = first.bytes; for (let i = 0; i < N; i++) { const r = await probe(p); ms.push(r.ms); status = r.status; bytes = r.bytes; } ms.sort((a, b) => a - b);
  const row = { path: p, status, kb: +(bytes / 1024).toFixed(1), first: +first.ms.toFixed(0), p50: +pct(ms, 0.5).toFixed(0), p95: +pct(ms, 0.95).toFixed(0), max: +ms.at(-1).toFixed(0) }; out.push(row); console.log(JSON.stringify(row)); }
