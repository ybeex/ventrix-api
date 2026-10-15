# ventrix — StoreKeeper API

Backend for **StoreKeeper**: a transaction-and-accountability system for physical tool cribs and site stores
(PRD v3). It answers *who has what, how much is left, and what happened* — with a ledger that cannot be edited,
works offline, and is safe to retry.

> Stack: TypeScript (ESM) · Fastify 5 · PostgreSQL 16 · Drizzle ORM · Redis · BullMQ · nodemailer (Mailgun) · opossum circuit breakers

## What it does (PRD → module)

| PRD | Capability | Module |
|---|---|---|
| §6–7, §22 | Items (tracked assets & consumables), human Item IDs, QR, CSV import | `items` `imports` |
| shelf system | Shelves → categories → items (mandatory chain; a location holds shelves), scan lookup, per-shelf cycle-count interval, **Collections** overview | `shelves` `categories` `operations` |
| §8–10 | Holders (people need no login), teams, departments, sites; locations; jobs | `holders` `locations` `jobs` |
| §11–17 | Checkout (single/batch), check-in, consume, restock, loss, damage, condition/state | `transactions` |
| §18, §32 | Adjustments & approvals (policy by role / threshold / operation) | `transactions` `approvals` |
| §19 | Reconciliation: counts, variance, policy-gated resolution | `reconciliation` |
| §21 | Offline sync: replay-safe batches, conflicts, delta snapshots | `sync` |
| §23 | Photos & transaction snapshots (private storage, signed URLs) | `files` |
| §24, §50 | Immutable ledger + audit log; corrections by reversal rows | `transactions` `activity` |
| §25–28 | Timeline, outstanding, overdue, low stock, dashboard | `items` `operations` |
| §30 | Notifications (in-app + e-mail), preferences, **org-wide role routing per type**, cycle-count reminders | `notifications` `mail` |
| governance | **Announcements** (role audience, e-mail, retract), **activity feed** with human sentences + category filters | `notifications` `activity` |
| §31, §37 | Roles/permissions, **session management**, **role-based invites** (matrix, bulk, resend, revoke), PIN quick-switch for shared devices, tenant isolation | `identity` |
| §40 | Reports (inventory, outstanding, low stock, transactions, discrepancies) + CSV | `reports` |
| §39, §55 | Metrics, health, readiness | `plugins/observability` |

132 HTTP operations; the full contract is [`docs/openapi.json`](docs/openapi.json) (generated from the live schemas, `npm run openapi`).

## Architecture in one page

```
 clients ──HTTPS──▶  API (Fastify, stateless, N instances)  ──▶ PostgreSQL  (source of truth)
                         │  ▲                                    ▲
                         │  └─ Redis: rate limits, session/settings cache (fail-soft)
                         ▼                                       │
                    BullMQ queues ──▶ Worker (N instances) ──────┘  e-mail outbox · event fan-out ·
                                          │                         overdue scan · housekeeping · imports
                                          └──▶ Mailgun (SMTP) / S3-compatible storage   (behind circuit breakers)
```

The ideas that make it correct (details in [`docs/DECISIONS.md`](docs/DECISIONS.md)):

1. **The ledger is the truth.** `transactions` is append-only (DB trigger). Every row carries signed `stock_delta` / `custody_delta`, so guarded balances can be *proved* from history (`modules/integrity`, run in tests and nightly).
2. **State is guarded, not editable.** Stock and asset state change only via one conditional `UPDATE` (cannot go negative → no oversell) and compare-and-set; CHECK constraints are the last line of defence.
3. **Everything is idempotent.** Key-scoped advisory lock + unique index; replays return the original result, a reused key with a different body is rejected.
4. **Policy is data.** Approval modes per operation, thresholds, photo requirements are org settings — enforced identically online, offline and at approval time (live re-validation).
5. **Failure is contained.** Mail, storage, queue and Redis sit behind circuit breakers with defined degraded behaviour; e-mail and events use transactional outboxes.
6. **Fail closed.** A route that doesn't declare its permission stops the app from booting; production refuses to start with weak secrets.

## Quick start

```bash
npm ci
docker compose up -d                 # Postgres 16 + Redis 7
cp .env.example .env
npm run db:migrate
npm run dev                          # API on :3000   (docs at /docs in non-production)
npm run dev:worker                   # background jobs (second terminal)
npm test                             # needs Postgres + Redis; see docs/OPERATIONS.md
```

Full stack in containers: `docker compose --profile app up --build`.
Create the first organization with `POST /v1/auth/register-org`; invite users with `POST /v1/users/invitations`.

## Configuration

All config is validated at boot (`src/env.ts`); `.env.example` documents every variable. In production the process
**refuses to start** unless: secrets are strong, HTTPS is enforced, CORS origins are set, Mailgun and S3-compatible storage are configured.
Notable: `MAIL_DRIVER=mailgun` (nodemailer over Mailgun SMTP), `STORAGE_DRIVER=s3|local`, `MAX_LOCATIONS_PER_ORG` (MVP = 1), `LOAD_SHEDDING`.

## Repository layout

```
src/app.ts server.ts worker.ts   composition root, API entrypoint, worker entrypoint
src/env.ts                       the only reader of process.env
src/db/schema.ts                 the data model, with PRD § tags and invariants
src/lib/                         errors, pagination, idempotency, permissions, circuit breakers, metrics, queue
src/plugins/                     perimeter security, auth, access (fail-closed), errors, observability
src/modules/<name>/              one folder per bounded module: service.ts · routes.ts (· queries.ts · schemas.ts)
drizzle/                         generated migrations + manual/{pre,post}/ SQL (extensions, immutability triggers)
test/                            390+ integration tests against real Postgres and Redis
docs/                            DECISIONS · SECURITY · OPERATIONS · AUDIT-FINDINGS · openapi.json
```

## Testing

`npm test` runs integration tests against **real** Postgres and Redis (no mocks): the 25-way oversell race, duplicate-key
races, approval races, offline replay, tenant isolation on every module, an exhaustive route-by-route access audit,
perimeter security, an end-to-end BullMQ worker run, **a route-by-route audit-coverage test (every mutating endpoint must leave an audit row or be explicitly allowlisted)**, and a migration test that applies `0003` to a populated database. After scenarios, the integrity oracle recomputes balances,
custody and state chains from the ledger alone.

## Branching

`main` (initial commit) ← `develop` ← feature branches (`feat/foundation`, `identity`, `catalog`, `transactions`,
`operations`, `reconciliation`, `imports`, `sync`, `notifications`, `hardening`, `shelves`, `governance`), each merged with `--no-ff` after its tests passed.
`chore/baseline-starter` holds the untouched reference starter this was built from, so every change is a readable diff.
