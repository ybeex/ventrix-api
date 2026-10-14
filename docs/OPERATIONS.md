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
