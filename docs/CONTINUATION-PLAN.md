# Build continuation plan

Written at checkpoint `74e6381` (branch `feat/governance`). Purpose: let anyone (including a fresh session with no memory of
this one) pick the build up, know exactly what is trustworthy, what is not yet, and what to do next — in order.

---

## 0. Resume in five minutes

```bash
git clone ventrix.bundle ventrix && cd ventrix && git checkout feat/governance     # or your remote, once pushed
npm ci
docker compose up -d                      # Postgres 16 + Redis 7  (or any local pair; see below)
cp .env.example .env && npm run db:migrate
npm run lint && npm test                  # expect: 152 passing
```

| Fact | Value |
|---|---|
| Last green commit | `74e6381` on `feat/governance` (152/152 tests; typecheck clean) |
| `develop` | `b01dca0` — includes everything through the shelf system; **does not** include governance |
| `main` | `7c29385` — only the initial "first commit"; intended to receive `develop` via PR |
| Migrations | `0000` base · `0001` seq/cursor columns · `0002` shelves (hand-edited, safe on populated DBs) · `0003` governance (purely additive) |
| API surface | 132 operations → `docs/openapi.json` (regenerate with `npm run openapi`) |
| Size | ~8,600 LOC source, ~3,100 LOC tests |
| Remote | **Not pushed** — no credential was available. Repo URL was written as both `ventrix` and `ventryx`; confirm which before `git remote set-url`. |

**Test-environment caveats (cost me time; don't repeat):**
- Tests need real Postgres + Redis. In the sandbox used for this build, background services were reaped between commands: always start them in the same command as the tests (`/home/claude/t.sh` wrapped that). In CI, use service containers (see `.github/workflows/ci.yml`).
- `npm test` wipes every table between tests (`TRUNCATE … CASCADE`) and flushes Redis DB 15. Never point `DATABASE_URL` at a database you care about.
- Ledger/audit immutability is trigger-enforced; tests that need to backdate rows disable the trigger for one statement (see `backdate()` in `operations.test.ts`).

---

## 1. State of the build

### 1.1 Done and verified (merged to `develop`, 152 tests)

| Area | Evidence |
|---|---|
| Identity: orgs, login/lockout, invites (basic), password reset, PIN quick-switch, RBAC | `identity.test.ts` (21), `access.test.ts` (route × role audit), `security.test.ts` (9) |
| Catalog: shelves → categories → items (NOT NULL chain), holders, jobs, locations, files, QR, search, timeline | `catalog` (17), `shelves` (12) |
| Ledger engine: checkout (single/batch/override), check-in, consume, restock, adjust, loss, damage, condition, corrections, approvals | `transactions` (27) incl. 25-way oversell race |
| Reconciliation (item/category/**shelf**/location scopes), CSV import (shelf-aware), offline sync (replay/conflicts/deltas) | `reconciliation` (12), `imports` (8), `sync` (12) |
| Outstanding, overdue, low stock, dashboard, Collections, activity log, reports + CSV | `operations` (9) |
| Notifications (event outbox → in-app/e-mail), BullMQ worker, housekeeping, integrity audit | `notifications` (10) incl. real-worker e2e |

### 1.2 Implemented at `74e6381` but NOT yet verified by dedicated tests

The existing suite still passes with these in place (so nothing regressed), but **none of the behaviour below has a test of its own**.
Treat it as *written, plausible, unproven* until Workstream 1 is done.

| Feature | Code | Highest-risk detail to test |
|---|---|---|
| Audit action catalogue + runtime guard | `lib/audit-catalog.ts`, `lib/audit.ts` | guard throws in dev/test, logs in prod; every emitted action registered |
| Security events (`auth.login_failed`, `auth.account_locked`, `auth.logout[_all]`, `auth.pin_failed`, `auth.password_reset_requested`, `access.denied`) | `identity/auth.service.ts`, `plugins/access.ts` | failed-login logging must not change the generic 401, timing, or enumeration behaviour; `justLocked` fires exactly once |
| Read logging (`report.viewed`, `activity.viewed`) | `reports/routes.ts`, `activity/routes.ts` | first page only; no log spam when paging |
| Human summaries + `GET /activity/actions` + category filter | `lib/describe.ts`, `activity/service.ts` | every ledger type reads correctly; unknown actions fall back safely; entity-name lookups batch correctly and stay tenant-scoped |
| Sessions: list/revoke own; admin list/revoke-all | `identity/sessions.service.ts` | cross-tenant and cross-user isolation; cache invalidation makes revocation immediate |
| Role-based invites: matrix, pending/expired/revoked list, revoke, resend, bulk, re-issue | `identity/users.service.ts` | the raw-SQL status derivation; supervisor visibility limited to manageable roles; `supervisorsCanInvite=false`; revoke → re-invite flow |
| Notification routing by role | `notifications/service.ts` (`getRules/setRule`, `rolesFor`) | default vs override; `NOT_CONFIGURABLE`; role changes take effect on the next event |
| Announcements | `notifications/announcements*.ts` | audience filtering uses jsonb `?` operator through Drizzle `sql` (untested driver path); retract removes unread copies only; e-mail respects per-user opt-out |
| Cycle-count reminders + shelf `lastCountedAt/nextCountDueAt` | `notifications/service.ts` (`scanCycleCounts`), `shelves/service.ts` | the `LEFT JOIN LATERAL` insert-select; one reminder per cycle; a closed shelf count resets the clock |
| Near-minimum band | `operations/queries.ts` (`nearWhere`), items/collections/dashboard | percent 0 disables; ordering "low before near"; consistency across item view / list / dashboard / collections |
| Partial return + **due dates on consumable lines (FIFO)** | `operations/queries.ts` (`bal`/`iss`/`out` CTEs), `checkout.ts` | multi-issue FIFO arithmetic; interaction with corrections; overdue list == dashboard == collections for consumable lines; `scanOverdue` over both kinds with correct dedupe keys |
| Migration `0003` | `drizzle/0003_governance.sql` | apply on a DB at `0002` containing data (it is additive, but prove it as was done for `0002`) |

---

## 2. Workstreams (do in this order)

Sizes: **S** ≤ half a day · **M** ≈ 1–2 days · **L** ≈ 3+ days (one engineer, familiar with the codebase).

### WS1 — Verify governance (branch: continue `feat/governance`)  · **M–L** · *blocking*

Write tests until every row of §1.2 has direct coverage. Suggested files and the assertions that matter:

1. `test/audit-coverage.test.ts`
   - **Static guard**: scan `src/**/*.ts` for `action: '…'` literals → each must be in `AUDIT_ACTIONS` (plus the dynamic `transaction.${type}` and `sync.${kind}` families).
   - **Mutation coverage**: for every mutating route in `registeredRoutes` (non-GET, non-public + the public auth ones), run a representative successful call in a scenario and assert ≥1 new `audit_events` row with the expected action. Keep an explicit allowlist of mutations that are deliberately *not* audited (notification read/read-all) so adding one is a conscious decision.
   - Guard behaviour: `audit()` with an unregistered action throws when `NODE_ENV=test`.
2. `test/security-events.test.ts`: failed login (bad password / unknown user / inactive / locked) writes the right rows *only when the org exists*, response bodies identical to before; lockout event once at the 5th failure; logout/logout-all; failed PIN; reset request for known and unknown users; `access.denied` row has route + permission + role and **no request body**; an audit-write failure (simulate by closing the pool path / stubbing) never turns 401/403 into 500.
3. `test/activity.test.ts` (or extend `operations`): summary text per ledger type and for ~10 representative audit actions; category filter; `/activity/actions` completeness; entity names resolve and never cross tenants; `activity.viewed`/`report.viewed` logged once per first page.
4. `test/sessions.test.ts`: list shows `current`; revoke own (other device) → that token 401 immediately; cannot revoke another user's session id (404); admin revoke-all; deactivated/other-org users.
5. `test/invites.test.ts`: full matrix (4 roles × 4 targets); `supervisorsCanInvite` off; list statuses (`pending` → force-expire the token → `expired` → revoke → `revoked`); supervisor sees only staff/viewer invites; re-invite after revoke reuses the user row and may change role; bulk partial success (`invited/exists/forbidden/invalid`, duplicate in request); resend replaces the previous link; accept still works; cross-tenant 404s.
6. `test/announcements.test.ts`: audience (single role, several, empty = everyone), delivery via `processDomainEvents`, e-mail on/off and per-user opt-out, expiry hides it from `GET /announcements`, retract removes unread copies and keeps read ones, admin `all=true` stats (`delivered`/`read`), event idempotency (processing twice ⇒ no duplicates), role-scoped visibility of the list, audit rows. Include **notification-rules**: defaults, override, validation, effect on the next event, audit.
7. `test/cycle-counts.test.ts`: `cycleCountDays` set → `scanCycleCounts` fires after the interval (backdate `shelves.created_at`), once per cycle, not for empty shelves, closing a shelf reconciliation resets `nextCountDueAt`, notification lands per routing rule.
8. Extend `operations.test.ts`: **near-minimum** (percent 10 / 0; boundary values; item view flag; `includeNear` ordering; dashboard + collections counts equal the list); **partial return** figures; **consumable due dates** with at least these FIFO cases — (a) one issue, partial return; (b) two issues with different dues, return that fully covers the first ⇒ line due becomes the second's; (c) return larger than first issue spills into the second; (d) correction of an issue; plus overdue list == dashboard == collections, and `scanOverdue` dedupe for consumable lines (key includes holder).
9. `test/migrations.test.ts` (or a script run in CI): build a scratch DB at `0002` with representative rows, apply `0003`, assert defaults (`near_minimum_percent=10`, `supervisors_can_invite=true`) and enum additions; re-running `runMigrations` is a no-op.

**Acceptance**: all new tests green; full suite green; `npm run lint`, `npm run build`, `npm run audit`, `npm run openapi` clean; the dedicated tests were seen to **fail** when the feature is deliberately broken (spot-check at least the FIFO and invite-matrix tests).

### WS2 — Documentation sync · **S**

The docs describe the pre-shelf, pre-governance system. Update, don't append:
- `README.md`: module table (+ shelves, collections, sessions, invites, announcements), operations/test counts, "what it does" map.
- `docs/DECISIONS.md`: add decisions **15–19** (shelf = own table in a location; mandatory chain + seeded Main shelf/General + archive rules; due dates on consumables via FIFO; log mutations + security events + sensitive reads; invite matrix) and derived choices (item location derived from shelf; near-minimum band; cycle counts count only *closed shelf-scope* reconciliations).
- `docs/SECURITY.md`: add security-event logging, `access.denied`, session management, invite matrix, read logging; keep the "not covered" list honest.
- `docs/OPERATIONS.md`: new `cycle` job (hourly), new notification types, new audit categories to alert on (`auth.account_locked`, bursts of `access.denied`).
- `docs/AUDIT-FINDINGS.md`: append any defects WS1 uncovers (before/after, test).
- Regenerate `docs/openapi.json`; CI enforces it is current.

### WS3 — Merge and release hygiene · **S**

1. WS1+WS2 green ⇒ `git checkout develop && git merge --no-ff feat/governance`; rerun the full suite on `develop`.
2. Tag `v1.0.0-rc1` on `develop`.
3. Push all branches + tag to the confirmed remote; open a PR `develop → main`; let CI run (Postgres/Redis service containers).
4. Refresh the bundle artifact and `docs/openapi.json` copy for the frontend team.

### WS4 — UI-contract verification against `StoreKeeper_UI_kit.html` · **M**

Walk every screen in the UI kit against a running API and fix gaps. First-pass mapping (verify each against the live server):

| UI screen / control | Endpoint(s) | Check |
|---|---|---|
| Scan an item / shelf | `GET /items/lookup?code=`, `GET /shelves/lookup?code=` | exact, case-insensitive; archived resolves for history |
| Batch checkout (holder = person / team / job) | `GET /holders?q=`, `POST /transactions/checkout/batch` | holder kinds incl. `job_site`; atomic; replay-safe; 202 when policy defers |
| Check in / send for inspection / declare lost (outstanding row actions) | `POST /transactions/checkin`, `/condition`, `/loss` | condition mapping; approval-gated loss/retirement returns 202 + approval card data |
| "Count against the shelf" | `POST /reconciliations {scope:'shelf'}`, `/:id/expected`, `/:id/counts`, `/:id/close` | checklist, resolution states, policy-gated adjustment |
| Collections cards (assets, out, overdue, low, under repair) | `GET /collections` | numbers equal the detail lists (tested for shelves; extend for near-min/consumable due) |
| Outstanding table, "Partial return", due chips | `GET /outstanding` | `issuedQuantity/returnedQuantity/partialReturn`, `dueStatus` for consumable lines |
| Low stock "Close to minimum" | `GET /low-stock?includeNear=true` | `status: low|near`, `headroom` |
| Activity sentences | `GET /activity` (`summary`) | wording review with the product owner |
| Sync problems tab; offline queue | `GET /sync/conflicts`, `POST /sync/batch`, `/sync/snapshot/*` | end-to-end offline round-trip |
| "Supervisor approves adjustments" switch | `PUT /organization/approval-policy` (`adjustmentMode`) | direct ⇄ staff_approval |
| Announcement banner, bell | `GET /announcements`, `GET /notifications(/unread-count)` | role visibility; unread counts |
| Item detail + timeline | `GET /items/:id`, `/timeline` | ordering by `sequence` |

Deliver: a short "frontend integration notes" doc (auth flow, idempotency-key rules, 202 handling, cursor pagination, error envelope, offline protocol) generated from the verified behaviour — the OpenAPI file alone does not explain these protocols.

### WS5 — Performance and scale verification · **M**

Nothing here is a known problem; it is the work that turns "should scale" into evidence.
- Seed a realistic large dataset (e.g. 500k items, 20M ledger rows, 5M audit rows across a few orgs) with a script (`scripts/seed-load.ts`).
- `EXPLAIN (ANALYZE, BUFFERS)` the heavy SQL and record results in `docs/OPERATIONS.md`: the outstanding CTEs (`bal`/`iss`/`out`, which scan an org's consumable custody rows and use a window function), `categoryStats` (Collections), `dashboardCounts`, `lowStockPage`, activity listing with entity-name lookups, reports. Add indexes only where a plan demands it; candidates: a partial index supporting `custody_delta > 0` consumable issues, `(org_id, holder_id, item_id, seq)` for the FIFO window.
- Load test (k6/autocannon): login → mixed checkout/check-in/consume at target RPS; assert p95/p99 and that the oversell invariant and integrity oracle hold afterwards.
- Decide on dashboard caching (per-org, a few seconds) from the measurements, not by guess.
- Breaker/chaos drill: kill Redis, block Mailgun/S3 egress, restart Postgres under load; confirm degraded behaviours documented in `lib/resilience/circuit.ts`.

### WS6 — Operational readiness · **M**

- Alert rules and dashboards as code (Prometheus rules for the signals in OPERATIONS.md; Grafana JSON).
- Backup/restore drill with PITR; document RPO/RTO; verify the integrity oracle passes on a restored copy.
- Mailgun: domain verification, SPF/DKIM, **bounce/complaint webhook** → mark addresses and stop retrying (currently only attempt-capped backoff).
- Production secrets/config checklist; staged rollout runbook (migrate → API → worker); rollback notes (migrations are forward-only; `0002` and `0003` are safe to roll forward only).
- Seed/demo script for demos and the UI team (orgs, shelves, items, a few days of ledger history).

---

## 3. Backlog (deliberately not built — decide before scheduling)

| Item | Why it is not in scope now | Notes |
|---|---|---|
| Postgres row-level security | Tenant isolation is app-enforced and heavily tested | Defence in depth; needs `SET LOCAL app.org_id` per transaction (PgBouncer-safe). **M–L** |
| MFA / SSO | Not in PRD | Adds a second factor for admin accounts first |
| Phase 2: multi-location, **TRANSFER**, per-location stock | PRD roadmap | Schema is location-aware (`location_id` on shelves, items, transactions); needs a per-location stock model decision |
| `REPLACEMENT` transaction type, worker self-service role | PRD "future" | — |
| Ledger/audit partitioning | Premature until volumes are measured | Plan in OPERATIONS.md; do from WS5 data |
| Image thumbnails/variants, malware scanning | Not required | Add a worker job + `files` variants table |
| Public API/webhooks, WhatsApp/SMS | PRD excludes | — |
| BFF/HttpOnly-cookie session option | Bearer tokens are used | Recommended for browser clients (see SECURITY.md) |
| i18n of server-generated text (e-mails, activity sentences) | English only | `describe.ts` and `templates.ts` are the only sources of such text |

---

## 4. Risk register

| # | Risk | Likelihood / impact | Mitigation / owner step |
|---|---|---|---|
| R1 | Governance code has latent bugs (unverified) | **High** until WS1 | WS1 before any merge or release |
| R2 | Heavy outstanding/collections SQL slow at scale | Medium / high | WS5 explain plans + indexes; consider materialising per-org snapshots only if measured necessary |
| R3 | Audit-write volume (denied access, report views, security events) grows the table | Medium / medium | Rate limits already bound abuse; add retention-aware partitioning plan; consider sampling `access.denied` per (user, route) per minute |
| R4 | Breaking API change (category/shelf mandatory; `locationId` no longer accepted on items) surprises clients | Medium / medium | Release notes + OpenAPI diff; version prefix `/v1` is not bumped — decide whether to bump to `/v2` before external clients depend on it |
| R5 | Jsonb `?` operator via Drizzle raw SQL behaves differently under PgBouncer/driver | Low / medium | Covered by announcements test in WS1; fallback `jsonb_exists()` |
| R6 | Local-only repo; no remote backup | **High** until pushed | WS3 step 3; the bundle is the interim backup |
| R7 | Defaults chosen without the product owner (e.g. near-minimum 10%, cycle-count semantics, announcement e-mail opt-out rules) | Medium / low | List them in the WS4 review; they are settings or one-line constants |
| R8 | Sandbox-specific test flakiness mistaken for product bugs (services reaped, load shedding) | Medium / low | `LOAD_SHEDDING=false` in tests; start services in the same command; run CI on real service containers |

---

## 5. Definition of done

**Per workstream**: acceptance criteria above met; tests green locally and in CI; docs updated in the same PR; an entry added to `AUDIT-FINDINGS.md` for every defect found.

**Release candidate (`v1.0.0-rc1`)**:
- [ ] `npm run lint && npm run build && npm test && npm run audit` all green on `develop` in CI
- [ ] `docs/openapi.json` current; frontend integration notes published
- [ ] Every §1.2 feature has direct tests; mutation-coverage test in place
- [ ] WS5 evidence recorded (explain plans, load-test numbers, breaker drill) with any index changes merged
- [ ] Mailgun + S3 verified against **real** accounts in a staging environment (only exercised through drivers/breakers so far)
- [ ] Backup/restore drill done; alert rules deployed
- [ ] Product-owner sign-off on the WS4 UI-contract walkthrough and on the §4 R7 defaults

---

## 6. Appendix — where things are

| Concern | Location |
|---|---|
| Data model + invariants (with PRD § tags) | `src/db/schema.ts` |
| Ledger operations | `src/modules/transactions/{engine,ledger,idempotency,policy}.ts`, `ops/*.ts` |
| Approvals | `src/modules/approvals/*`, `transactions/approved.ts` |
| Shared metric SQL (outstanding/low/near/collections) | `src/modules/operations/queries.ts` |
| Discrepancy definition | `src/modules/reconciliation/queries.ts` |
| Audit | `src/lib/{audit,audit-catalog,describe}.ts`, `src/modules/activity/*` |
| Notifications / announcements / routing | `src/modules/notifications/*` |
| Invites, sessions, auth | `src/modules/identity/*` |
| Access control matrix | `src/lib/permissions.ts`, `src/plugins/access.ts` |
| Background jobs | `src/worker.ts`, `src/modules/maintenance/jobs.ts` |
| Resilience primitives | `src/lib/resilience/*`, `src/lib/queue.ts`, `src/modules/mail/*`, `src/modules/files/storage.ts` |
| Integrity oracle | `src/modules/integrity/service.ts` (used by tests and the nightly job) |
| Decisions, security, operations, findings | `docs/{DECISIONS,SECURITY,OPERATIONS,AUDIT-FINDINGS}.md` |

Test inventory at the checkpoint: access 5 · catalog 17 · foundation 7 · identity 21 · imports 8 · notifications 10 ·
operations 9 · reconciliation 12 · security 9 · shelves 12 · sync 12 · transactions 27 = **152**.
