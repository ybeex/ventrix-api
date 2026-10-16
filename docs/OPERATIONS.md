# Operations

## Topology
- **API** (`node dist/src/server.js`): stateless; run ≥2 behind a TLS-terminating load balancer. Set `TRUST_PROXY=true`, `FORCE_HTTPS=true`. Probes: `GET /healthz` (liveness), `GET /readyz` (readiness; 503 only if Postgres is down — Redis down = `degraded`).
- **Worker** (`node dist/src/worker.js`): ≥1; scale independently. Every job is idempotent and multi-worker safe (SKIP LOCKED claims, dedupe keys, per-row keys). Repeatable schedulers are registered idempotently (N workers ⇒ one schedule).
- **Migrations** (`node dist/scripts/migrate.js`): run once per deploy before the API (extensions → generated migrations → idempotent triggers). Safe to re-run.
- **PostgreSQL 16**, **Redis 7** (`maxmemory-policy noeviction`, AOF on — BullMQ must not lose jobs), **Mailgun** (SMTP creds), **S3-compatible bucket** (private).

## Postgres
- Use PgBouncer in **transaction** pooling mode. The app already uses `prepare:false`, never relies on session state, and raw-SQL timestamp params are sent as ISO strings with explicit casts.
- Apply once per environment (superuser): `psql -v app_role=<role> -f drizzle/manual/ops/role_settings.sql` → `statement_timeout 15s`, `lock_timeout 5s`, `idle_in_transaction_session_timeout 30s`. A timeout surfaces as a retryable 503, never a hang.
- Pool sizing: `DB_POOL_MAX` is **per process**. Total = (API instances + workers) × `DB_POOL_MAX`; keep below PgBouncer/Postgres limits.
- **Backups**: enable PITR/WAL archiving. The ledger is the system of record; a restore point is a business-continuity decision, not a convenience.
- **Growth**: `transactions` and `audit_events` are the only unbounded tables. Both page on a monotonic `seq` and are indexed `(org_id, seq)`. Before they reach hundreds of millions of rows, move to monthly range partitioning on `created_at` (requires making the primary key `(id, created_at)` and the `seq` unique index per-partition; do it as a planned migration, not an emergency). Never `DELETE` from them — triggers forbid it by design.

## Background jobs (worker schedulers)
| Job | Cadence | What it does |
|---|---|---|
| `email` | 10 s | dispatches the e-mail outbox, oldest first, one claimed batch at a time |
| `events` | 5 s | fans domain events out to notifications (role routing, announcements, preferences) |
| `overdue` | 15 min | scans consumable lines and assets for new overdue episodes (one event per holder/item/due instant) |
| `cycle` | hourly | shelf cycle-count reminders: one `shelf.count_due` event per shelf per cycle |
| `purge` | hourly | housekeeping: expired sessions/tokens/idempotency keys; processed events and sent e-mail >30 days; read notifications >90 days; imports stuck in `committing` >30 min become retryable |
| `integrity` | 6 h | ledger integrity oracle; sets `storekeeper_integrity_violations` |

**Notification types**: `low_stock`, `overdue_checkout`, `reconciliation_discrepancy`, `sync_failure`, `approval_pending`, `approval_decided`, `announcement`, `cycle_count_due`. Org admins route six of them — `low_stock`, `overdue_checkout`, `reconciliation_discrepancy`, `sync_failure`, `approval_pending`, `cycle_count_due` — to roles via `PUT /organization/notification-rules/:type` (default: admin + supervisor). `approval_decided` goes to the requester and `announcement` has its own audience, so neither is routable.

## Monitoring (Prometheus: `GET /metrics`, bearer `METRICS_TOKEN`)
| Signal | Metric | Alert when |
|---|---|---|
| Ledger integrity | `storekeeper_integrity_violations` (nightly job) | `> 0` — page someone; see runbook |
| Dependency health | `circuit_breaker_state{name}` (0 closed · 1 half-open · 2 open), `circuit_breaker_events_total` | `== 2` for >5 min (`mailgun`, `storage*`, `redis`, `queue`) |
| Transaction failure/duplicate rate (§39) | `storekeeper_transactions_total{type,outcome}` | rising `conflict`/`rejected` share; `replayed` share |
| Sync health (§39) | `storekeeper_sync_actions_total{outcome}` | rising `conflict`/`rejected` |
| Discrepancy rate | `storekeeper_reconciliation_discrepancies_total / …counts_total` | trend |
| Auth failures | `storekeeper_auth_failures_total{reason}` | spike in `bad_password`/`locked`/`pin_failed` |
| Latency | `http_request_duration_seconds{route,status}` | p95/p99 per route |
| Jobs / mail | `storekeeper_jobs_total{job,outcome}`, `storekeeper_emails_total{outcome}` | `failed` / `dead` rising |

### Alerts and dashboard as code
`deploy/prometheus/storekeeper.rules.yml` (16 rules, validated and unit-tested with `promtool`, see `storekeeper.rules.test.yml`) and `deploy/grafana/storekeeper-overview.json` (12 panels; import it and pick your Prometheus data source). A test fails the build if a rule or panel uses a metric the app does not export, or if an alert is missing from this page.

| Alert | Severity | Fires when | First step |
|---|---|---|---|
| `StoreKeeperIntegrityViolation` | page | `storekeeper_integrity_violations > 0` | Runbook: integrity violation. Do not edit data by hand. |
| `StoreKeeperApiDown` | page | an API target is down for 2 min | `/healthz`, container, load balancer |
| `StoreKeeperWorkerNotRunning` | page | no `email` job success for 15 min | worker deployment, Redis |
| `StoreKeeperDependencyCircuitOpen` | page | a breaker open for 5 min | see Runbooks (mailgun / storage / redis / queue) |
| `StoreKeeperHighErrorRate` | page | >2% 5xx for 10 min with real traffic | split by status/route: 503 = dependency, 500 = bug |
| `StoreKeeperServiceUnavailableSustained` | warn | 503s for 5 min | `/readyz`: Postgres or Redis; else load shedding |
| `StoreKeeperSlowRoutes` | warn | route p95 > 1 s for 15 min | `scripts/explain-heavy.ts`, Postgres load |
| `StoreKeeperEventLoopLag` | warn | lag > 0.5 s for 10 min | scale out; expect shedding |
| `StoreKeeperJobFailing` | warn | a job failed >3× in 30 min | worker logs (scanners are safe to re-run) |
| `StoreKeeperEmailDeadLetters` | warn | e-mails gave up after all retries | Mailgun credentials/domain |
| `StoreKeeperEmailSuppressionSpike` | warn | >20 bounces/complaints in an hour | what was sent; SPF/DKIM; Mailgun dashboard |
| `StoreKeeperAuthFailureSpike` | warn | >1 failed sign-in/s for 10 min | audit `auth.login_failed` per org |
| `StoreKeeperAccountLockouts` | warn | >10 attempts on locked accounts in 15 min | targeted guessing or a stale client |
| `StoreKeeperTransactionConflicts` | warn | >25% of ledger ops refused for 30 min | error codes in logs, recent client release |
| `StoreKeeperSyncProblems` | warn | >20% of offline actions conflict/rejected | stale snapshots or invalid payloads |
| `StoreKeeperDiscrepancyRate` | info | >30% of the day's counts show variance | discrepancy report |

## Audit-based alerts (SQL; `audit_events` is the source)
Run these on a schedule or from your log pipeline; there is no metric for them yet.
```sql
-- any lockout in the last 15 minutes
select org_id, entity_id as user_id, created_at from audit_events where action = 'auth.account_locked' and created_at > now() - interval '15 minutes';
-- one user refused 10+ times in 10 minutes (probing or a broken client)
select org_id, actor_user_id, count(*) from audit_events where action = 'access.denied' and created_at > now() - interval '10 minutes' group by 1, 2 having count(*) >= 10;
-- credential stuffing against one org: many failed sign-ins
select org_id, count(*) from audit_events where action = 'auth.login_failed' and created_at > now() - interval '10 minutes' group by 1 having count(*) >= 50;
```
The activity feed (`GET /activity?category=Security`) shows the same events with readable sentences for admins and supervisors.

## Runbooks
- **Integrity violation** — the log line `LEDGER INTEGRITY VIOLATIONS` lists check name, item and numbers. Do **not** edit rows. Identify the cause (a manual SQL change, a deploy bug), then repair by *appending* a correcting transaction through the API (or a reviewed SQL insert that follows the ledger invariants), and re-run the audit job.
- **A breaker is open** — `mailgun`: mail queues in `email_outbox` (status `pending`) and drains on recovery; check Mailgun status/creds. `storage*`: uploads/downloads return 503, everything else works. `redis`: sessions fall back to Postgres, limits fail open, queue enqueue returns 503. `queue`: large imports return 503 and revert to `ready`.
- **Stuck import** — the hourly housekeeping marks imports `committing` >30 min as `failed`; re-run `POST /imports/:id/commit` (per-row keys make it safe).
- **Dead e-mails** — `select * from email_outbox where status='failed'`; fix the cause (bad address/creds) and set `status='pending', attempts=0`.
- **Poison domain event** — parked after 8 attempts with `last_error`; fix the cause and `update domain_events set processed_at=null, attempts=0 where id=…`.
- **Cycle-count reminders look wrong** — they fire once per cycle from `max(last closed shelf count, shelf created) + cycleCountDays`. Check `GET /shelves` (`lastCountedAt`, `nextCountDueAt`); a shelf with no active items, or archived, is never reminded. To re-arm, close a shelf-scope reconciliation or change the interval.
- **Invite/reset e-mail arrived out of order** — the outbox sends oldest-first (fixed in C1); if two mails exist for one recipient, only the newest link works.
- **Locked-out user** — they self-recover after 15 min, or an admin resets via password-reset flow / `DELETE /users/:id/pin`.

## Capacity notes
Hot paths are single-row conditional UPDATEs + one INSERT per ledger row; advisory locks are per idempotency key / per (item, holder), so unrelated work never contends. Dashboard counts read live from indexed tables (no cache) — fine into the hundreds of thousands of items; beyond that, cache per org for a few seconds.

## Performance evidence (WS5)

**Read these numbers as indicative, not as capacity planning.** They were taken on a 1-CPU / 4 GB sandbox where the API, Postgres, Redis and the load generator all shared one core, with the plan's volumes scaled down (below). They show *shape* (what scales with what) and before/after effect, not production throughput. Re-run the scripts on production-like hardware before quoting capacity.

**Dataset** (`scripts/seed-load.ts`, additive and parameterised; the integrity oracle passes over it): two organizations in one database, 2.53M ledger rows and 0.67M audit rows in total.
- `load-big` (stress profile): 30,000 items, 1,683,000 ledger rows, **24,000 outstanding consumable lines** (every consumable ends with units out — far worse than a real crib).
- `load-real` (realistic profile, `SEED_PROFILE=real`): 15,000 items, 842,400 ledger rows, ~2% of consumables and ~4% of assets outstanding.
- The plan's targets (500k items / 20M ledger / 5M audit) were **not reached**: disk and CPU in the sandbox make each 5,000-item slice take ~110 s to build.

**What was wrong, and the fix** (query functions timed 3× each, first run cold; `scripts/time-queries.ts`):

| Screen query | stress org, original | stress org, now | realistic org, original | realistic org, now |
|---|---|---|---|---|
| Dashboard counts | 3.3 s | 0.7 s | ~0.8 s | ~70 ms |
| Outstanding page (50) | 3.3 s | 0.7 s | ~0.43 s | ~45 ms |
| Collections cards | did not finish in 120 s | 1.7 s | ~0.65 s | ~93 ms |
| Low-stock page (50) | 16–31 ms | 14 ms | 7 ms | 7 ms |

1. The custody screens aggregated the org's **entire custody ledger on every request** (a parallel sequential scan plus sort of ~1M rows, then a FIFO due-date lookup per outstanding line). Fix: a trigger-maintained read-model `custody_balances` (drizzle/manual/post/0150) read instead of the ledger, plus two covering partial indexes for the FIFO lookup (0200). The screens now cost O(outstanding lines), not O(ledger rows).
2. Collections computed overdue with a correlated subquery over the outstanding CTE **per category** (200 categories). Fix: aggregate overdue lines per category once and join.
3. Everything else measured clean at this volume (`/items`, `/holders`, `/activity`, `/reports/*`, `/low-stock`: p50 ≤ 60 ms solo; `/shelves` ~105 ms).

**Mixed load** (`scripts/load-test.mjs`, 8 workers, 45 s, 20% writes: consume and asset checkout→check-in; realistic org). Same hardware, before → after the read-model:

| | requests/s | dashboard p50 / p95 | collections p50 | outstanding p50 | write p95 | non-2xx |
|---|---|---|---|---|---|---|
| before | 5.4 | 7.3 s / 8.0 s | 6.2 s | 3.9 s | ≤ 1.1 s | 0 |
| after | 17.1 | 0.8 s / 1.1 s | 1.2 s | 0.55 s | 0.47–0.69 s | 0 |

The integrity oracle reports **0 violations after every run** (2.53M rows in ~5 s, including the `custody_balances_mismatch` check). Remaining under-load latency is CPU contention on one core (every read competes with Postgres); a second core or a read replica is the next lever, and a short Redis cache of dashboard/Collections counts is available if an org's dashboard is polled aggressively (not built: the read-model made it unnecessary at the measured volumes).

**Failure drills** (API running against the load database, `curl` probes):

| Dependency stopped | Behaviour | Recovery |
|---|---|---|
| Redis | every request still succeeds (sessions fall back to the DB, rate limiting fails open, idempotency still enforced by the DB); `/readyz` reports `degraded`, `redis:false`; no hangs | automatic once Redis returns |
| Postgres | **found a defect**: answered `500 INTERNAL_ERROR`. Now `503 TEMPORARILY_UNAVAILABLE` with `Retry-After: 5`, ~5 ms, including login; `/healthz` stays 200, `/readyz` 503 | automatic, first request after the restart succeeds |
| Mailgun / S3 | **not run** (no accounts here). Covered by tests only: the outbox retries with backoff and stays queued; the storage breaker opens and uploads answer 503 while the rest of the API works | — |

**Operating the read-model**
- It is maintained by the `transactions_custody` AFTER INSERT trigger in the same transaction as the ledger row, so it cannot disagree with a committed row. The integrity job's `custody_balances_mismatch` check recomputes it from the ledger; any violation pages like any other.
- To rebuild (after manual data surgery, or if the check ever fires): `TRUNCATE custody_balances;` then run `npm run db:migrate` — the backfill runs when the table is empty (2.5M ledger rows backfilled in ~1 s).
- The two indexes in `0200_perf_indexes.sql` are created with a plain `CREATE INDEX` on first deploy (they take a write lock on `transactions` for the build; ~1 s at 1.7M rows). On a much larger ledger create them first with `CREATE INDEX CONCURRENTLY` under the same names.
- **Reproduce:** `scripts/seed-load.ts` (repeat runs append), `scripts/time-queries.ts`, `scripts/explain-heavy.ts`, `scripts/measure-endpoints.mjs`, `scripts/load-test.mjs`, `scripts/verify-integrity.ts`.
- **Measurement hygiene:** a client that times out does **not** cancel its Postgres query; abandoned heavy queries keep running and poison every later measurement (this happened during WS5 and invalidated the first numbers). Check `pg_stat_activity` is idle before timing anything.

**Not covered:** the plan's full volumes; more than one app instance; a connection pooler in front of Postgres; slow-disk and replica-lag behaviour; real Mailgun/S3.
