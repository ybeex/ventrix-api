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

## Runbooks
- **Integrity violation** — the log line `LEDGER INTEGRITY VIOLATIONS` lists check name, item and numbers. Do **not** edit rows. Identify the cause (a manual SQL change, a deploy bug), then repair by *appending* a correcting transaction through the API (or a reviewed SQL insert that follows the ledger invariants), and re-run the audit job.
- **A breaker is open** — `mailgun`: mail queues in `email_outbox` (status `pending`) and drains on recovery; check Mailgun status/creds. `storage*`: uploads/downloads return 503, everything else works. `redis`: sessions fall back to Postgres, limits fail open, queue enqueue returns 503. `queue`: large imports return 503 and revert to `ready`.
- **Stuck import** — the hourly housekeeping marks imports `committing` >30 min as `failed`; re-run `POST /imports/:id/commit` (per-row keys make it safe).
- **Dead e-mails** — `select * from email_outbox where status='failed'`; fix the cause (bad address/creds) and set `status='pending', attempts=0`.
- **Poison domain event** — parked after 8 attempts with `last_error`; fix the cause and `update domain_events set processed_at=null, attempts=0 where id=…`.
- **Locked-out user** — they self-recover after 15 min, or an admin resets via password-reset flow / `DELETE /users/:id/pin`.

## Capacity notes
Hot paths are single-row conditional UPDATEs + one INSERT per ledger row; advisory locks are per idempotency key / per (item, holder), so unrelated work never contends. Dashboard counts read live from indexed tables (no cache) — fine into the hundreds of thousands of items; beyond that, cache per org for a few seconds.
