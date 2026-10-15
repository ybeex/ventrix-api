// Mixed read/write load test (WS5). node scripts/load-test.mjs
// env: BASE, SLUG, EMAIL, PASSWORD, WORKERS (default 8), SECONDS (default 45), WRITE_PCT (default 20)
// Writes: consume (stock), asset checkout → check-in (custody). Every write carries its own Idempotency-Key.
// After the run, verify the ledger with:  node --import tsx scripts/verify-integrity.ts
const BASE = process.env.BASE ?? 'http://localhost:3100';
const slug = process.env.SLUG ?? 'load-real'; const email = process.env.EMAIL ?? `admin@${slug}.test`; const password = process.env.PASSWORD ?? 'Load-Test-Password-42';
const WORKERS = Number(process.env.WORKERS ?? 8), SECONDS = Number(process.env.SECONDS ?? 45), WRITE_PCT = Number(process.env.WRITE_PCT ?? 20);
const api = async (token, method, path, body, headers = {}) => {
  const t = performance.now();
  const r = await fetch(`${BASE}/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) }).catch((e) => ({ status: 0, json: async () => ({}), err: e.name }));
  return { status: r.status, ms: performance.now() - t, json: () => r.json().catch(() => ({})) };
};
const { token } = await (await fetch(`${BASE}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgSlug: slug, email, password }) })).json();
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const cons = (await (await api(token, 'GET', '/items?type=consumable&limit=100')).json()).items.filter((i) => i.quantityAvailable > 200);
const assets = (await (await api(token, 'GET', '/items?type=asset&status=available&limit=100')).json()).items;
const holders = (await (await api(token, 'GET', '/holders?limit=100')).json()).items;
console.log(`pool: ${cons.length} consumables, ${assets.length} available assets, ${holders.length} holders`);
const READS = ['/dashboard', '/collections', '/outstanding?limit=50', '/overdue?limit=50', '/low-stock?includeNear=true&limit=50', '/items?limit=50', '/items?q=cable&limit=25', '/activity?limit=50', '/reports/transactions?limit=50', '/shelves', '/notifications/unread-count'];
const stats = new Map(); const rec = (k, r) => { const s = stats.get(k) ?? { ms: [], ok: 0, err: {} }; s.ms.push(r.ms); if (r.status >= 200 && r.status < 300) s.ok++; else s.err[r.status] = (s.err[r.status] ?? 0) + 1; stats.set(k, s); };
const end = Date.now() + SECONDS * 1000; let writes = 0;
const worker = async (w) => {
  const myAssets = assets.filter((_, i) => i % WORKERS === w); // each worker owns its assets: no checkout races by design (races are covered by tests)
  while (Date.now() < end) {
    if (Math.random() * 100 < WRITE_PCT) {
      writes++;
      if (Math.random() < 0.7 || !myAssets.length) { const it = pick(cons); rec('POST consume', await api(token, 'POST', '/transactions/consume', { itemId: it.id, quantity: 1 }, { 'idempotency-key': crypto.randomUUID() })); }
      else { const a = pick(myAssets); const h = pick(holders); const co = await api(token, 'POST', '/transactions/checkout', { itemId: a.id, holderId: h.id }, { 'idempotency-key': crypto.randomUUID() }); rec('POST checkout', co);
        if (co.status === 201) rec('POST checkin', await api(token, 'POST', '/transactions/checkin', { itemId: a.id }, { 'idempotency-key': crypto.randomUUID() })); }
    } else { const p = pick(READS); rec(`GET ${p.split('?')[0]}`, await api(token, 'GET', p)); }
  }
};
const t0 = Date.now(); await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w))); const secs = (Date.now() - t0) / 1000;
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
let total = 0, bad = 0; const rows = [];
for (const [k, s] of [...stats].sort()) { s.ms.sort((a, b) => a - b); total += s.ms.length; const nOk = s.ok; bad += s.ms.length - nOk; rows.push(`${k.padEnd(34)} n=${String(s.ms.length).padStart(5)} ok=${String(nOk).padStart(5)} p50=${pct(s.ms, 0.5).toFixed(0).padStart(5)} p95=${pct(s.ms, 0.95).toFixed(0).padStart(5)} p99=${pct(s.ms, 0.99).toFixed(0).padStart(5)} max=${s.ms.at(-1).toFixed(0).padStart(5)}${Object.keys(s.err).length ? '  errors=' + JSON.stringify(s.err) : ''}`); }
console.log(rows.join('\n')); console.log(`\n${WORKERS} workers, ${secs.toFixed(0)}s: ${total} requests (${(total / secs).toFixed(1)}/s), ${writes} write attempts, ${bad} non-2xx`);
