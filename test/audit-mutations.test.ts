/**
 * MUTATION COVERAGE: every mutating route the app registers must either (a) be exercised below and leave ≥1 NEW audit row with an
 * expected action, or (b) sit on the explicit allowlist of deliberately-unaudited mutations. Adding a mutating route without
 * deciding which fails the first test — "every action is monitored" cannot silently rot.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registeredRoutes } from '../src/plugins/access.js';
import { db } from '../src/db/index.js';
import { sql } from 'drizzle-orm';
import { env } from '../src/env.js';
import { makeApp, resetAll, registerOrg, createUser, call, callIdem, mkItem, mkHolder, mkShelf, mkCategory, upload, multipart, flushMail, tokenFromMail, seededCatalog, auditRows, idem, PASSWORD, type App, type Session } from './helpers.js';

let app: App; let admin: Session, sup: Session, staff: Session, viewer: Session; let john: { id: string }; let ties: { id: string };
before(async () => {
  app = await makeApp(); await resetAll(app);
  admin = await registerOrg(app); sup = await createUser(app, admin, 'supervisor'); staff = await createUser(app, admin, 'store_staff', 'Stella Staff'); viewer = await createUser(app, admin, 'viewer');
  john = await mkHolder(app, staff.token, 'John Okafor'); ties = await mkItem(app, admin.token, { type: 'consumable', name: 'Cable ties', openingQuantity: 500, minQuantity: 5 });
});
after(async () => { await app.close(); });

/** Mutations that intentionally write no audit row (reading your own notifications is not an auditable act). */
const UNAUDITED = new Set([
  'POST /v1/notifications/:id/read', 'POST /v1/notifications/read-all',
  'POST /v1/webhooks/mailgun', // system-to-system, no tenant/user to attribute: HMAC-verified, logged (warn) and counted (storekeeper_email_suppressions_total)
]);

type Res = Awaited<ReturnType<typeof call>>;
interface Entry { run: () => Promise<Res>; expect: string[]; org?: (r: Res) => string }
const E = (expect: string | string[], run: () => Promise<Res>, org?: Entry['org']): Entry => ({ expect: Array.isArray(expect) ? expect : [expect], run, org });
type Who = 'admin' | 'sup' | 'staff';
const tok = (w: Who) => ({ admin, sup, staff })[w].token;
const lazy = <T,>(v: T | (() => T)): T => (typeof v === 'function' ? (v as () => T)() : v);
const A = (m: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string | (() => string), body?: unknown | (() => unknown), who: Who = 'admin') => () => call(app, tok(who), m, lazy(url), lazy(body), ['POST', 'PUT', 'PATCH'].includes(m) ? { 'idempotency-key': idem() } : {});
const tx = (op: string, body: object | (() => object)) => () => callIdem(app, admin.token, 'POST', `/transactions/${op}`, lazy(body));
const newAsset = async (name = `Asset ${crypto.randomUUID().slice(0, 5)}`) => mkItem(app, admin.token, { type: 'asset', name });
const loginTok = async (s: Session, extra: object = {}) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { orgSlug: s.slug, email: s.email, password: PASSWORD, ...extra } })).json().token as string;
const policy = (over: object = {}) => call(app, admin.token, 'PUT', '/organization/approval-policy', { adjustmentMode: 'staff_approval', lossMode: 'staff_approval', retirementMode: 'staff_approval', checkoutMode: 'direct', checkinMode: 'direct', largeAdjustmentThreshold: null, ...over }, { 'idempotency-key': idem() });
const pending = async () => { await policy(); const r = await callIdem(app, staff.token, 'POST', '/transactions/adjust', { itemId: ties.id, quantityDelta: -1, reason: 'count_correction' }); assert.equal(r.statusCode, 202, r.body); return r.json().approval.id as string; };
let invN = 0; const email = () => `m${++invN}-${crypto.randomUUID().slice(0, 5)}@acme.test`;
const invited = async (role: 'viewer' | 'store_staff' = 'viewer') => { const e = email(); const r = (await callIdem(app, admin.token, 'POST', '/users/invitations', { email: e, role })).json(); return { id: r.id as string, email: e }; };
/** MAX_LOCATIONS_PER_ORG=1 in the test env: create through the API with the cap lifted for one call; for patch/archive insert a second location directly. */
const withLocationCap = async <T,>(f: () => Promise<T>) => { const e = env as { MAX_LOCATIONS_PER_ORG: number }; const prev = e.MAX_LOCATIONS_PER_ORG; e.MAX_LOCATIONS_PER_ORG = 50; try { return await f(); } finally { e.MAX_LOCATIONS_PER_ORG = prev; } };
const rawLocation = async () => { const r = await db.execute(sql`insert into locations (org_id, name, kind) values (${admin.orgId}, ${`Yard ${crypto.randomUUID().slice(0, 5)}`}, 'site') returning id`) as any; return (Array.isArray(r) ? r : r.rows)[0].id as string; };
const CSV = 'Name,Type,SKU,Qty,Min\nImported widget,consumable,IMP-1,5,1\n';
const MAP = { name: 'Name', type: 'Type', sku: 'SKU', quantity: 'Qty', minQuantity: 'Min' };
const importUp = async () => { const m = multipart(Buffer.from(CSV), 'items.csv', 'text/csv'); return app.inject({ method: 'POST', url: '/v1/imports', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${admin.token}` } }); };
const importValidated = async () => { const id = (await importUp()).json().import.id; const c = await seededCatalog(app, admin.token); await call(app, admin.token, 'POST', `/imports/${id}/validate`, { mapping: MAP, defaults: { categoryId: c.categoryId, shelfId: c.shelfId } }); return id as string; };
const conflict = async () => { // an offline consume that cannot be satisfied → a sync issue to resolve
  const dry = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 0 });
  await call(app, staff.token, 'POST', '/sync/batch', { deviceId: 'tab-1', actions: [{ clientGeneratedId: `c-${crypto.randomUUID()}`, type: 'consume', queuedAt: new Date().toISOString(), payload: { itemId: dry.id, quantity: 3 } }] });
  const issue = (await call(app, sup.token, 'GET', '/sync/conflicts')).json().items.find((i: any) => i.itemId === dry.id || i.item?.id === dry.id) ?? (await call(app, sup.token, 'GET', '/sync/conflicts')).json().items[0];
  await callIdem(app, admin.token, 'POST', '/transactions/restock', { itemId: dry.id, quantity: 10 }); return issue.id as string; };

const CASES: Record<string, Entry> = {
  // ── identity
  'POST /v1/auth/register-org': E('org.registered', () => app.inject({ method: 'POST', url: '/v1/auth/register-org', payload: { organizationName: 'Fresh Org', email: email(), password: PASSWORD, adminName: 'Fay' } }) as never, (r) => r.json().organization.id),
  'POST /v1/auth/login': E('auth.login', async () => app.inject({ method: 'POST', url: '/v1/auth/login', payload: { orgSlug: admin.slug, email: staff.email, password: PASSWORD } }) as never),
  'POST /v1/auth/logout': E('auth.logout', async () => call(app, await loginTok(staff), 'POST', '/auth/logout')),
  'POST /v1/auth/logout-all': E('auth.logout_all', async () => call(app, await loginTok(viewer), 'POST', '/auth/logout-all')),
  'POST /v1/auth/accept-invite': E('user.invite_accepted', async () => { const i = await invited(); await flushMail(); return app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: tokenFromMail(i.email), password: PASSWORD } }) as never; }),
  'POST /v1/auth/password-reset/request': E('auth.password_reset_requested', async () => app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { orgSlug: admin.slug, email: staff.email } }) as never),
  'POST /v1/auth/password-reset/confirm': E('user.password_reset', async () => { const u = await createUser(app, admin, 'viewer'); await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { orgSlug: admin.slug, email: u.email } }); await flushMail(); return app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token: tokenFromMail(u.email), password: 'Another-Strong-Pass-42' } }) as never; }),
  'PUT /v1/auth/pin': E('user.pin_set', A('PUT', '/auth/pin', { password: PASSWORD, pin: '482913' }, 'sup')),
  'DELETE /v1/auth/pin': E('user.pin_cleared', A('DELETE', '/auth/pin', undefined, 'sup')),
  'POST /v1/auth/pin-switch': E('auth.pin_switch', async () => { await call(app, staff.token, 'PUT', '/auth/pin', { password: PASSWORD, pin: '482913' }); return call(app, await loginTok(admin, { trustDevice: true, deviceId: 'tab-9' }), 'POST', '/auth/pin-switch', { userId: staff.userId, pin: '482913' }); }),
  'DELETE /v1/auth/sessions/:id': E('session.revoked', async () => { const t = await loginTok(sup); const other = (await call(app, sup.token, 'GET', '/auth/sessions')).json().items.find((i: any) => !i.current); return call(app, sup.token, 'DELETE', `/auth/sessions/${other.id}`).finally(() => void t); }),
  'DELETE /v1/users/:id/pin': E('user.pin_cleared', A('DELETE', () => `/users/${staff.userId}/pin`)),
  'DELETE /v1/users/:id/sessions': E('session.revoked', async () => { const u = await createUser(app, admin, 'viewer'); return call(app, admin.token, 'DELETE', `/users/${u.userId}/sessions`); }),
  'PATCH /v1/users/:id': E('user.role_changed', async () => { const u = await createUser(app, admin, 'viewer'); return call(app, admin.token, 'PATCH', `/users/${u.userId}`, { role: 'store_staff' }); }),
  'POST /v1/users/invitations': E('user.invited', async () => callIdem(app, admin.token, 'POST', '/users/invitations', { email: email(), role: 'viewer' })),
  'POST /v1/users/invitations/bulk': E('user.invited', async () => callIdem(app, admin.token, 'POST', '/users/invitations/bulk', { invites: [{ email: email(), role: 'viewer' }] })),
  'POST /v1/users/:id/invitations/resend': E('user.invite_resent', async () => call(app, admin.token, 'POST', `/users/${(await invited()).id}/invitations/resend`)),
  'POST /v1/users/:id/invitations/revoke': E('user.invite_revoked', async () => call(app, admin.token, 'POST', `/users/${(await invited()).id}/invitations/revoke`)),
  // ── organization & notifications
  'PATCH /v1/organization': E('org.updated', A('PATCH', '/organization', { name: 'Acme Works Ltd' })),
  'PATCH /v1/organization/settings': E('settings.updated', A('PATCH', '/organization/settings', { dueSoonHours: 12 })),
  'PUT /v1/organization/approval-policy': E('policy.updated', async () => policy({ adjustmentMode: 'direct' })),
  'PUT /v1/organization/notification-rules/:type': E('notification.rules_changed', A('PUT', '/organization/notification-rules/low_stock', { roles: ['admin'] })),
  'PUT /v1/notifications/preferences/:type': E('notification.preferences_changed', A('PUT', '/notifications/preferences/low_stock', { inApp: false }, 'sup')),
  'POST /v1/announcements': E('announcement.published', A('POST', '/announcements', { title: 'Hello', body: 'World' })),
  'PATCH /v1/announcements/:id': E('announcement.updated', async () => { const a = (await call(app, admin.token, 'POST', '/announcements', { title: 'T', body: 'B' }, { 'idempotency-key': idem() })).json(); return call(app, admin.token, 'PATCH', `/announcements/${a.id}`, { title: 'T2' }); }),
  'POST /v1/announcements/:id/retract': E('announcement.retracted', async () => { const a = (await call(app, admin.token, 'POST', '/announcements', { title: 'T', body: 'B' }, { 'idempotency-key': idem() })).json(); return call(app, admin.token, 'POST', `/announcements/${a.id}/retract`); }),
  // ── catalogue
  'POST /v1/shelves': E('shelf.created', A('POST', '/shelves', { name: `Shelf ${crypto.randomUUID().slice(0, 5)}` })),
  'PATCH /v1/shelves/:id': E('shelf.updated', async () => call(app, admin.token, 'PATCH', `/shelves/${(await mkShelf(app, admin.token)).id}`, { description: 'x' })),
  'POST /v1/shelves/:id/archive': E('shelf.archived', async () => call(app, admin.token, 'POST', `/shelves/${(await mkShelf(app, admin.token)).id}/archive`)),
  'POST /v1/shelves/:id/restore': E('shelf.restored', async () => { const s = await mkShelf(app, admin.token); await call(app, admin.token, 'POST', `/shelves/${s.id}/archive`); return call(app, admin.token, 'POST', `/shelves/${s.id}/restore`); }),
  'POST /v1/categories': E('category.created', async () => callIdem(app, admin.token, 'POST', '/categories', { shelfId: (await seededCatalog(app, admin.token)).shelfId, name: `Cat ${crypto.randomUUID().slice(0, 5)}` }) as never),
  'PATCH /v1/categories/:id': E('category.updated', async () => call(app, admin.token, 'PATCH', `/categories/${(await mkCategory(app, admin.token)).id}`, { name: `Renamed ${crypto.randomUUID().slice(0, 4)}` })),
  'POST /v1/categories/:id/move': E('category.moved', async () => call(app, admin.token, 'POST', `/categories/${(await mkCategory(app, admin.token)).id}/move`, { shelfId: (await mkShelf(app, admin.token)).id })),
  'POST /v1/categories/:id/archive': E('category.archived', async () => call(app, admin.token, 'POST', `/categories/${(await mkCategory(app, admin.token)).id}/archive`)),
  'POST /v1/categories/:id/restore': E('category.restored', async () => { const c = await mkCategory(app, admin.token); await call(app, admin.token, 'POST', `/categories/${c.id}/archive`); return call(app, admin.token, 'POST', `/categories/${c.id}/restore`); }),
  'POST /v1/items': E('transaction.create', async () => callIdem(app, admin.token, 'POST', '/items', { name: `New ${crypto.randomUUID().slice(0, 5)}`, type: 'asset', categoryId: (await seededCatalog(app, admin.token)).categoryId }) as never),
  'PATCH /v1/items/:id': E('item.updated', async () => call(app, admin.token, 'PATCH', `/items/${(await newAsset()).id}`, { description: 'edited' })),
  'POST /v1/items/:id/archive': E('transaction.archive', async () => call(app, admin.token, 'POST', `/items/${(await newAsset()).id}/archive`)),
  'POST /v1/items/:id/restore': E('transaction.restore', async () => { const a = await newAsset(); await call(app, admin.token, 'POST', `/items/${a.id}/archive`); return call(app, admin.token, 'POST', `/items/${a.id}/restore`); }),
  'POST /v1/items/:id/move': E('item.moved', async () => call(app, admin.token, 'POST', `/items/${(await newAsset()).id}/move`, { categoryId: (await mkCategory(app, admin.token)).id })),
  'POST /v1/items/move': E('item.moved', async () => call(app, admin.token, 'POST', '/items/move', { itemIds: [(await newAsset()).id], categoryId: (await mkCategory(app, admin.token)).id })),
  'POST /v1/holders': E('holder.created', A('POST', '/holders', { kind: 'person', name: `Person ${crypto.randomUUID().slice(0, 5)}` })),
  'PATCH /v1/holders/:id': E('holder.updated', async () => call(app, admin.token, 'PATCH', `/holders/${(await mkHolder(app, admin.token)).id}`, { name: `Renamed ${crypto.randomUUID().slice(0, 4)}` })),
  'POST /v1/holders/:id/archive': E('holder.archived', async () => call(app, admin.token, 'POST', `/holders/${(await mkHolder(app, admin.token)).id}/archive`)),
  'PUT /v1/holders/:id/members': E('holder.members_set', async () => call(app, admin.token, 'PUT', `/holders/${(await mkHolder(app, admin.token, `Team ${crypto.randomUUID().slice(0, 4)}`, 'team')).id}/members`, { personIds: [john.id] })),
  'POST /v1/jobs': E('job.created', A('POST', '/jobs', { name: `Job ${crypto.randomUUID().slice(0, 5)}` })),
  'PATCH /v1/jobs/:id': E('job.updated', async () => call(app, admin.token, 'PATCH', `/jobs/${(await call(app, admin.token, 'POST', '/jobs', { name: `J ${crypto.randomUUID().slice(0, 5)}` }, { 'idempotency-key': idem() })).json().id}`, { status: 'closed' })),
  'POST /v1/jobs/:id/archive': E('job.archived', async () => call(app, admin.token, 'POST', `/jobs/${(await call(app, admin.token, 'POST', '/jobs', { name: `J ${crypto.randomUUID().slice(0, 5)}` }, { 'idempotency-key': idem() })).json().id}/archive`)),
  'POST /v1/locations': E('location.created', () => withLocationCap(A('POST', '/locations', () => ({ name: `Site ${crypto.randomUUID().slice(0, 5)}`, kind: 'site' })))),
  'PATCH /v1/locations/:id': E('location.updated', async () => call(app, admin.token, 'PATCH', `/locations/${await rawLocation()}`, { name: `Renamed ${crypto.randomUUID().slice(0, 5)}` })),
  'POST /v1/locations/:id/archive': E('location.archived', async () => call(app, admin.token, 'POST', `/locations/${await rawLocation()}/archive`)),
  'POST /v1/files': E('file.uploaded', async () => upload(app, admin.token, 'item_photo') as never),
  'POST /v1/imports': E('import.uploaded', async () => importUp() as never),
  'POST /v1/imports/:id/validate': E('import.validated', async () => { const id = (await importUp()).json().import.id; const c = await seededCatalog(app, admin.token); return call(app, admin.token, 'POST', `/imports/${id}/validate`, { mapping: MAP, defaults: { categoryId: c.categoryId, shelfId: c.shelfId } }); }),
  'POST /v1/imports/:id/commit': E('import.committed', async () => call(app, admin.token, 'POST', `/imports/${await importValidated()}/commit`)),
  // ── ledger
  'POST /v1/transactions/checkout': E('transaction.checkout', async () => tx('checkout', { itemId: (await newAsset()).id, holderId: john.id })()),
  'POST /v1/transactions/checkout/batch': E('transaction.checkout', async () => tx('checkout/batch', { holderId: john.id, lines: [{ itemId: (await newAsset()).id }, { itemId: ties.id, quantity: 2 }] })()),
  'POST /v1/transactions/checkin': E('transaction.checkin', async () => { const a = await newAsset(); await tx('checkout', { itemId: a.id, holderId: john.id })(); return tx('checkin', { itemId: a.id })(); }),
  'POST /v1/transactions/consume': E('transaction.consume', tx('consume', () => ({ itemId: ties.id, quantity: 1 }))),
  'POST /v1/transactions/restock': E('transaction.restock', tx('restock', () => ({ itemId: ties.id, quantity: 5 }))),
  'POST /v1/transactions/adjust': E('transaction.adjustment', async () => { await policy({ adjustmentMode: 'direct' }); return tx('adjust', { itemId: ties.id, quantityDelta: 2, reason: 'count_correction' })(); }),
  'POST /v1/transactions/condition': E('transaction.condition_update', async () => tx('condition', { itemId: (await newAsset()).id, toState: 'under_repair', note: 'to workshop' })()),
  'POST /v1/transactions/loss': E('transaction.loss', async () => { await policy({ lossMode: 'direct' }); return tx('loss', { itemId: ties.id, quantity: 1, note: 'misplaced' })(); }),
  'POST /v1/transactions/damage': E('transaction.damage', tx('damage', () => ({ itemId: ties.id, quantity: 1, note: 'cracked' }))),
  'POST /v1/transactions/:id/correct': E('transaction.correction', async () => { const r = await tx('consume', { itemId: ties.id, quantity: 1 })(); return tx(`${r.json().transaction.id}/correct`, { note: 'mistake' })(); }),
  // ── approvals
  'POST /v1/approvals/:id/approve': E('approval.approved', async () => callIdem(app, sup.token, 'POST', `/approvals/${await pending()}/approve`, {})),
  'POST /v1/approvals/:id/reject': E('approval.rejected', async () => callIdem(app, sup.token, 'POST', `/approvals/${await pending()}/reject`, { note: 'recount first' })),
  'POST /v1/approvals/:id/cancel': E('approval.cancelled', async () => callIdem(app, staff.token, 'POST', `/approvals/${await pending()}/cancel`, {})),
  // ── counts & sync
  'POST /v1/reconciliations': E('reconciliation.started', async () => callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'item', scopeId: ties.id })),
  'POST /v1/reconciliations/:id/counts': E('reconciliation.count_recorded', async () => { const r = (await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'item', scopeId: ties.id })).json(); const n = (await call(app, sup.token, 'GET', `/items/${ties.id}`)).json().quantityAvailable; return callIdem(app, sup.token, 'POST', `/reconciliations/${r.id}/counts`, { itemId: ties.id, physicalQuantity: n }); }),
  'POST /v1/reconciliations/:id/close': E('reconciliation.closed', async () => { const r = (await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'item', scopeId: ties.id })).json(); return callIdem(app, sup.token, 'POST', `/reconciliations/${r.id}/close`, {}); }),
  'POST /v1/sync/batch': E(['sync.conflict', 'transaction.consume'], async () => call(app, staff.token, 'POST', '/sync/batch', { deviceId: 'tab-2', actions: [{ clientGeneratedId: `c-${crypto.randomUUID()}`, type: 'consume', queuedAt: new Date().toISOString(), payload: { itemId: ties.id, quantity: 1 } }] })),
  'POST /v1/sync/conflicts/:id/resolve': E('sync.resolved', async () => call(app, sup.token, 'POST', `/sync/conflicts/${await conflict()}/resolve`, { resolution: 'apply_client', note: 'stock arrived' })),
};

test('REGISTRY: every mutating route is either covered below or explicitly allowlisted — nothing is undecided', () => {
  const mutating = new Set(registeredRoutes.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method)).map((r) => `${r.method} ${r.url}`));
  const decided = new Set([...Object.keys(CASES), ...UNAUDITED]);
  assert.deepEqual([...mutating].filter((k) => !decided.has(k)).sort(), [], 'mutating routes with no audit decision (add a case or allowlist them)');
  assert.deepEqual([...decided].filter((k) => !mutating.has(k)).sort(), [], 'cases/allowlist entries for routes that no longer exist');
  assert.ok(mutating.size >= 70, `saw ${mutating.size}`);
});

for (const [key, c] of Object.entries(CASES)) {
  test(`AUDITED: ${key} → ${c.expect.join(' | ')}`, async () => {
    const mark = async () => Number((await db.execute(sql`select coalesce(max(seq), 0)::bigint as m from audit_events`) as any)[0].m);
    const before = await mark();
    const res = await c.run();
    assert.ok(res.statusCode < 300, `${key} answered ${res.statusCode}: ${res.body.slice(0, 300)}`);
    const fresh = (await db.execute(sql`select action, org_id from audit_events where seq > ${before}`) as any as Array<{ action: string; org_id: string }>);
    const orgId = c.org ? c.org(res) : admin.orgId;
    const mine = fresh.filter((r) => r.org_id === orgId).map((r) => r.action);
    assert.ok(c.expect.some((a) => mine.includes(a)), `${key}: expected one of [${c.expect}] but new audit rows were [${mine.join(', ') || 'none'}]`);
  });
}

test('UNAUDITED allowlist really is unaudited (so the allowlist cannot hide a missing audit): reading notifications writes nothing', async () => {
  const before = (await auditRows(admin.orgId)).length;
  await call(app, sup.token, 'POST', '/notifications/read-all'); await call(app, sup.token, 'POST', `/notifications/${crypto.randomUUID()}/read`);
  assert.equal((await auditRows(admin.orgId)).length, before);
});
