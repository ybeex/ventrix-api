/**
 * Demo / staging seed: a believable organization built ENTIRELY through the real API, so every row (ledger, audit, notifications,
 * approvals) is exactly what production would have written. Safe to run once per database; it refuses to run twice.
 *
 *   node --import tsx scripts/seed-demo.ts            (needs DATABASE_URL + REDIS_URL; development/staging only — it refuses NODE_ENV=production)
 *
 * Logins (organization slug `demo-works`, password DEMO_PASSWORD or the default below):
 *   admin@demo-works.test · supervisor@demo-works.test · staff@demo-works.test · staff2@demo-works.test · viewer@demo-works.test
 *
 * What it leaves behind: 3 shelves / 8 categories / 39 items, 10 holders (people, teams, job sites), two weeks of history,
 * overdue and due-soon checkouts, partial returns, a low-stock and a near-minimum item, a loss request awaiting approval,
 * a closed shelf count, an active announcement, a notification-rule override and unread notifications.
 */
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Works-Password-42';
const SLUG = 'demo-works';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
const DAY = 86_400_000;

export interface DemoResult { slug: string; password: string; users: Record<string, string>; skipped?: boolean }

export async function seedDemo(app: FastifyInstance, db: { execute: (q: never) => Promise<unknown> }, flushMail: () => Promise<void>): Promise<DemoResult> {
  const users = { admin: `admin@${SLUG}.test`, supervisor: `supervisor@${SLUG}.test`, staff: `staff@${SLUG}.test`, staff2: `staff2@${SLUG}.test`, viewer: `viewer@${SLUG}.test` };
  const exists = rows<{ id: string }>(await db.execute(sql`select id from organizations where slug = ${SLUG}` as never));
  if (exists.length) return { slug: SLUG, password: PASSWORD, users, skipped: true };

  const call = async (token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url: `/v1${url}`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() }, payload: payload as never });
    if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body.slice(0, 300)}`);
    return r.body ? r.json() : null; // 204 responses have no body
  };

  // ── organization + people (invitations accepted through the real e-mail tokens) ──
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register-org', payload: { organizationName: 'Demo Works', email: users.admin, password: PASSWORD, adminName: 'Ada Admin' } });
  if (reg.statusCode !== 201) throw new Error(`register-org → ${reg.statusCode} ${reg.body}`);
  if (reg.json().organization.slug !== SLUG) throw new Error(`expected slug ${SLUG}, got ${reg.json().organization.slug}`);
  const admin = reg.json().session.token as string;
  const tokens: Record<string, string> = { admin };
  for (const [key, role, name] of [['supervisor', 'supervisor', 'Sam Supervisor'], ['staff', 'store_staff', 'Stella Staff'], ['staff2', 'store_staff', 'Samuel Okoro'], ['viewer', 'viewer', 'Vera Viewer']] as const) {
    await call(admin, 'POST', '/users/invitations', { email: users[key], role, name }); await flushMail();
    const [m] = rows<{ text_body: string }>(await db.execute(sql`select text_body from email_outbox where to_email = ${users[key]} order by created_at desc limit 1` as never));
    const token = /token=([A-Za-z0-9_-]+)/.exec(m.text_body)![1];
    const acc = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token, password: PASSWORD } });
    if (acc.statusCode !== 200) throw new Error(`accept-invite ${key} → ${acc.statusCode}`);
    tokens[key] = acc.json().token;
  }
  const { admin: A, supervisor: S, staff: T, staff2: T2 } = tokens;

  // ── structure: shelves → categories ──
  const shelf = async (name: string, cycleCountDays?: number) => (await call(A, 'POST', '/shelves', { name, ...(cycleCountDays ? { cycleCountDays } : {}) })).id as string;
  const cat = async (shelfId: string, name: string, defaultMinQuantity?: number) => (await call(A, 'POST', '/categories', { shelfId, name, ...(defaultMinQuantity ? { defaultMinQuantity } : {}) })).id as string;
  const [power, cons, safety] = [await shelf('Power tools', 30), await shelf('Consumables', 14), await shelf('Safety & PPE', 30)];
  const C = {
    drills: await cat(power, 'Drills & drivers'), saws: await cat(power, 'Saws & grinders'), weld: await cat(power, 'Welding equipment'),
    fix: await cat(cons, 'Fixings & fasteners', 50), rods: await cat(cons, 'Welding rods & discs', 20), tape: await cat(cons, 'Tapes & sealants', 10),
    ppe: await cat(safety, 'Protective wear', 10), harness: await cat(safety, 'Fall protection'),
  };

  // ── items ──
  const asset = async (categoryId: string, name: string, sku?: string) => (await call(A, 'POST', '/items', { name, type: 'asset', categoryId, ...(sku ? { sku } : {}) })).id as string;
  const stock = async (categoryId: string, name: string, openingQuantity: number, minQuantity: number, unit: string) => (await call(A, 'POST', '/items', { name, type: 'consumable', categoryId, openingQuantity, minQuantity, unit })).id as string;
  const drill = { hilti: await asset(C.drills, 'Hilti TE 6-A36 rotary hammer', 'HLT-TE6'), makita: await asset(C.drills, 'Makita DHP484 drill driver', 'MAK-484'), bosch: await asset(C.drills, 'Bosch GSB 18V impact drill', 'BSH-18'), dewalt: await asset(C.drills, 'DeWalt DCD796 compact drill') };
  const saw = { circ: await asset(C.saws, 'Makita 190 mm circular saw'), grinder1: await asset(C.saws, 'Bosch 125 mm angle grinder'), grinder2: await asset(C.saws, 'Bosch 125 mm angle grinder'), jig: await asset(C.saws, 'DeWalt jigsaw'), cut: await asset(C.saws, 'Husqvarna K770 cut-off saw') };
  const weld = { mig: await asset(C.weld, 'Lincoln MIG 250 welder'), gen: await asset(C.weld, 'Honda 5 kVA generator'), tig: await asset(C.weld, 'Esab TIG welder') };
  const hv = { harness1: await asset(C.harness, 'Full-body harness (size L)'), harness2: await asset(C.harness, 'Full-body harness (size M)'), lanyard: await asset(C.harness, 'Energy-absorbing lanyard 2 m') };
  const ties = await stock(C.fix, 'Cable ties 200 mm (bag of 100)', 120, 40, 'bag'), anchors = await stock(C.fix, 'M12 anchor bolts', 400, 100, 'pcs'), screws = await stock(C.fix, 'Wood screws 4×50 (box)', 80, 25, 'box');
  const rods = await stock(C.rods, 'E6013 welding rods 3.2 mm (pack)', 60, 20, 'pack'), discs = await stock(C.rods, '125 mm cutting discs', 150, 60, 'pcs'), tape = await stock(C.tape, 'Duct tape 50 mm', 36, 12, 'roll');
  const gloves = await stock(C.ppe, 'Work gloves (pair)', 90, 30, 'pair'), glasses = await stock(C.ppe, 'Safety glasses', 33, 30, 'pcs'), plugs = await stock(C.ppe, 'Ear plugs (box of 200)', 12, 8, 'box');
  for (let i = 1; i <= 14; i++) await stock(i % 2 ? C.fix : C.tape, `${['Hex bolts M8', 'Washers M10', 'Rawl plugs 8 mm', 'Masking tape', 'Epoxy sealant', 'Self-tapping screws'][i % 6]} lot ${i}`, 60 + i * 7, 20, 'pcs');

  // ── holders ──
  const holder = async (kind: string, name: string) => (await call(kind === 'person' ? T : A, 'POST', '/holders', { kind, name })).id as string; // staff may add people; teams and sites are admin-only
  const H = { john: await holder('person', 'John Okafor'), mary: await holder('person', 'Mary Eze'), chidi: await holder('person', 'Chidi Nwosu'), tunde: await holder('person', 'Tunde Bakare'), amaka: await holder('person', 'Amaka Obi'), kofi: await holder('person', 'Kofi Mensah'),
    crew: await holder('team', 'Fabrication crew'), elec: await holder('team', 'Electrical team'), lekki: await holder('job_site', 'Lekki Phase 2 site'), tema: await holder('job_site', 'Tema warehouse fit-out') };
  await call(A, 'PUT', `/holders/${H.crew}/members`, { personIds: [H.john, H.chidi, H.tunde] });
  const day = (n: number) => new Date(Date.now() + n * DAY).toISOString();
  // The API (rightly) refuses a due date in the past, so "overdue" is created as due tomorrow and backdated with the history below.
  const late: Array<[itemId: string, holderId: string, days: number]> = [];
  const due = (itemId: string, holderId: string, days: number) => { if (days < 0) { late.push([itemId, holderId, days]); return day(1); } return day(days); };

  // ── a fortnight of activity ──
  const out = (tok: string, itemId: string, holderId: string, dueInDays: number) => call(tok, 'POST', '/transactions/checkout', { itemId, holderId, dueAt: due(itemId, holderId, dueInDays) });
  await out(T, drill.hilti, H.john, -3); await out(T, drill.makita, H.mary, 2); await out(T, saw.grinder1, H.chidi, -1); await out(T2, saw.cut, H.crew, 5); await out(T, weld.gen, H.lekki, 10); await out(T2, weld.mig, H.crew, 1);
  await out(T, hv.harness1, H.tunde, 14); await out(T, drill.bosch, H.amaka, 3);
  await call(T, 'POST', '/transactions/checkout/batch', { holderId: H.tema, dueAt: day(4), lines: [{ itemId: saw.circ }, { itemId: ties, quantity: 20 }, { itemId: anchors, quantity: 100 }] });
  late.push([ties, H.tema, -2]); // the ties went out with the batch but were due back two days ago
  await call(T, 'POST', '/transactions/checkout', { itemId: rods, holderId: H.crew, quantity: 18, dueAt: due(rods, H.crew, -1) });
  await call(T, 'POST', '/transactions/checkin', { itemId: rods, holderId: H.crew, quantity: 7 });          // partial return
  await call(T2, 'POST', '/transactions/checkin', { itemId: drill.bosch, condition: 'needs_inspection' }); // back, but flagged for inspection
  await call(T2, 'POST', '/transactions/checkin', { itemId: drill.makita, condition: 'good' });
  for (let i = 0; i < 6; i++) await call(i % 2 ? T : T2, 'POST', '/transactions/consume', { itemId: [gloves, screws, discs, tape, ties, rods][i], quantity: 3 + i, holderId: [H.kofi, H.john, H.crew, H.mary, H.chidi, H.crew][i] });
  await call(S, 'POST', '/transactions/restock', { itemId: anchors, quantity: 200 });
  await call(T, 'POST', '/transactions/consume', { itemId: plugs, quantity: 5 });                                // plugs: 12 → 7, crosses its minimum of 8 → low-stock alert
  await call(T, 'POST', '/transactions/consume', { itemId: glasses, quantity: 2 });                              // glasses: just above minimum → near minimum
  const lost = await asset(C.harness, 'Fall-arrest block (lost on site)'); await out(T, lost, H.lekki, 7);
  await call(T, 'POST', '/transactions/loss', { itemId: lost, note: 'Not on the truck after the Lekki move-out' }); // staff loss → 202, awaiting approval
  await call(A, 'POST', '/transactions/damage', { itemId: discs, quantity: 4, note: 'Cracked in storage' });

  // ── a closed shelf count, an announcement, a routing override ──
  const rec = await call(S, 'POST', '/reconciliations', { scope: 'shelf', scopeId: cons });
  const ex = await call(S, 'GET', `/reconciliations/${rec.id}/expected?limit=100`);
  for (const it of (ex.items as Array<{ itemId: string; systemQuantity: number }>).slice(0, 8)) await call(S, 'POST', `/reconciliations/${rec.id}/counts`, { itemId: it.itemId, physicalQuantity: it.systemQuantity });
  await call(S, 'POST', `/reconciliations/${rec.id}/close`, {});
  await call(A, 'POST', '/announcements', { title: 'Month-end stocktake on Friday', body: 'Please return every tool you are holding by Thursday 5 pm so the Friday count is clean.', audienceRoles: [], severity: 'warning', expiresAt: day(7) });
  await call(A, 'PUT', '/organization/notification-rules/low_stock', { roles: ['admin', 'supervisor', 'store_staff'] });

  // ── make the history look like a fortnight, not one minute: spread timestamps in ledger order ──
  await db.execute(sql`alter table transactions disable trigger transactions_immutable` as never);
  await db.execute(sql`alter table audit_events disable trigger audit_events_immutable` as never);
  try {
    await db.execute(sql`
      with o as (select id, row_number() over (order by seq) rn, count(*) over () n from transactions where org_id = (select id from organizations where slug = ${SLUG}))
      update transactions t set created_at = now() - interval '13 days' + (o.rn::float / o.n) * interval '13 days', occurred_at = now() - interval '13 days' + (o.rn::float / o.n) * interval '13 days' from o where t.id = o.id` as never);
    for (const [itemId, holderId, days] of late) { // overdue: assets keep their due date on the item, consumables on the issuing ledger row
      await db.execute(sql`update items set due_at = now() + make_interval(days => ${days}) where id = ${itemId} and type = 'asset' and due_at is not null` as never);
      await db.execute(sql`update transactions set due_at = now() + make_interval(days => ${days}) where item_id = ${itemId} and holder_id = ${holderId} and type = 'checkout' and due_at is not null` as never);
    }
    await db.execute(sql`
      with a as (select id, row_number() over (order by seq) rn, count(*) over () n from audit_events where org_id = (select id from organizations where slug = ${SLUG}))
      update audit_events e set created_at = now() - interval '13 days' + (a.rn::float / a.n) * interval '13 days' from a where e.id = a.id` as never);
  } finally {
    await db.execute(sql`alter table transactions enable trigger transactions_immutable` as never);
    await db.execute(sql`alter table audit_events enable trigger audit_events_immutable` as never);
  }
  await db.execute(sql`update custody_balances b set since = (select max(t.created_at) from transactions t where t.type = 'checkout' and t.item_id = b.item_id and t.holder_id = b.holder_id)` as never);
  return { slug: SLUG, password: PASSWORD, users };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed demo data in production.'); process.exit(1); }
  const { buildApp } = await import('../src/app.js'); const { db } = await import('../src/db/index.js'); const { runMigrations } = await import('./migrate.js');
  const { dispatchDueEmails } = await import('../src/modules/mail/outbox.js'); const { env } = await import('../src/env.js');
  await runMigrations(env.DATABASE_URL);
  const app = await buildApp(); await app.ready();
  const flush = async () => { for (let i = 0; i < 20; i++) { const r = await dispatchDueEmails(db); if (r.sent + r.failed + r.deferred + r.suppressed === 0) break; } };
  const r = await seedDemo(app, db as never, flush);
  console.log(r.skipped ? `Demo organization "${r.slug}" already exists — nothing to do.` : `Seeded "${r.slug}". Sign in with organization slug ${r.slug}, password ${r.password}:`);
  for (const [k, e] of Object.entries(r.users)) console.log(`  ${k.padEnd(11)} ${e}`);
  await app.close(); process.exit(0);
}
