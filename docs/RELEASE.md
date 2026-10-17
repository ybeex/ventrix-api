# Release & operations runbook

How to put a build in front of real users, how to undo it, and what has and has not been proven. Pair with `OPERATIONS.md` (monitoring, runbooks), `SECURITY.md` and `DECISIONS.md`.

## 1. Before every rollout

1. **CI green** on the release commit: lint, build, full tests, `npm audit`, OpenAPI up to date, alert rules validated (`promtool`).
2. **Configuration review** with the *exact variables the API and worker will receive*:
   ```
   npm run check-config               # static review (no network); exit 1 on any error
   npm run check-config -- --connect  # also: Postgres + Redis reachable, all migrations applied, ledger/audit/custody triggers present
   ```
   It forces `NODE_ENV=production`, so the boot rules in `env.ts` apply too. Errors block a rollout; warnings need a conscious decision (write the reason in the release notes). It flags placeholder or low-entropy secrets, localhost endpoints, wildcard or non-https CORS, `LOAD_SHEDDING` off, local storage, missing Mailgun webhook key, and similar.
3. **Backups**: confirm the last automated backup is recent and that a restore has been rehearsed this quarter (section 4).
4. **Read the diff of `drizzle/` and `drizzle/manual/post/`**: migrations run before the new code takes traffic, so they must be backward compatible with the *previous* version for the duration of the rollout.

## 2. Staged rollout

| Step | Do | Proceed if |
|---|---|---|
| 1 Migrate | `npm run db:migrate` (once, from one place). Generated migrations, then `drizzle/manual/post/*.sql` (idempotent: triggers, read-models, indexes). | exits 0; `check-config --connect` shows no errors |
| 2 Worker first | Deploy the **worker** (it owns the schedulers and the outbox) and watch one minute of logs. | `storekeeper_jobs_total{outcome="ok"}` increments; no `failed` |
| 3 Canary API | One API instance on the new version; keep the rest on the old one. | `/readyz` 200; 5xx ratio flat; p95 flat for 10 minutes; no `StoreKeeper*` alert |
| 4 Roll the rest | Replace the remaining instances one at a time. | same signals |
| 5 Verify | Sign in, scan an item, check out and return one, open the dashboard and Activity; run `scripts/verify-integrity.ts` against production. | oracle reports `violations: 0` |

The API sheds load with 503 + `Retry-After` and clients retry with their saved Idempotency-Key, so replacing instances is safe mid-traffic.

## 3. Rollback

- **Code**: redeploy the previous image (API first, then worker). Safe as long as the migration was backward compatible (section 1.4). Keep the previous image tag in the release notes.
- **Schema**: migrations are forward-only. A bad migration is fixed with a *new* migration. The ledger and audit tables are append-only by trigger; **never** repair data with `UPDATE`/`DELETE` there. Reverse a wrong ledger entry with a correction (`POST /transactions/:id/correct`).
- **Derived tables are disposable**: `custody_balances` can be truncated and rebuilt (`TRUNCATE custody_balances; npm run db:migrate`) at any time; the integrity job proves it matches the ledger.
- **Data disaster / bad deploy that damaged data**: restore (section 4). Point-in-time recovery to just before the mistake is the tool, not manual surgery.

## 4. Backup and restore

**Policy** (set these in your Postgres host): daily full backup retained 14–35 days **and** continuous WAL archiving for point-in-time recovery (set `archive_timeout = 60` so the worst-case data loss is about a minute). On a managed Postgres (RDS, Cloud SQL, Neon, Supabase…) use the provider's PITR and backups; the drills below are the self-hosted equivalents and show what a good result looks like.

**Drill results** (WS5; sandbox with 1 CPU, 4 GB, 1.73 GB database = 2.5M ledger rows, 0.67M audit rows; treat times as indicative):

| Drill | Result |
|---|---|
| Logical backup `pg_dump -Fc -Z 3` | 46 s, 178 MB |
| Logical restore `pg_restore` into a fresh database | **84 s**; row counts identical to the source (transactions 2,525,638 · audit 670,463 · custody_balances 45,058 · items 45,000); all three ledger/audit/custody triggers present; **integrity oracle: 0 violations** |
| Physical base backup `pg_basebackup` + WAL archiving | 38 s, 1.8 GB |
| **Point-in-time recovery** to a named restore point after deliberately damaging production (renamed organizations, emptied `custody_balances`) | recovered in ~6 s (base copy + 3 WAL segments); the damage was gone, a legitimate change made *before* the restore point was kept, all 45,058 custody rows back; **integrity oracle: 0 violations** on the recovered instance |

**Restore procedure (logical):**
1. `createdb storekeeper_restore` · `pg_restore -d storekeeper_restore --no-owner --role=<app role> backup.dump`
2. `ANALYZE;` — the restore carries no planner statistics; without it screens are slower until autovacuum catches up.
3. Run `DATABASE_URL=… npx tsx scripts/verify-integrity.ts` against the restored database. **Do not switch traffic until it reports 0 violations.**
4. Point the API and worker at it (or swap names), run `npm run check-config -- --connect`, then the section 2 step 5 smoke test.

**Point-in-time recovery (self-hosted):** restore the base backup into a new data directory; create `recovery.signal`; set `restore_command` (copy from the WAL archive), `recovery_target_name` (create markers with `select pg_create_restore_point('before_deploy_123')` before risky changes) or `recovery_target_time`, and `recovery_target_action = 'promote'`; start it; verify with the oracle; then cut over. Before every risky deploy, create a restore point: it costs nothing and makes this a one-line recovery.

**Rehearse quarterly** and after any Postgres version change, on a copy that is production-sized. A backup that has never been restored is a hope, not a backup.

## 5. Provider checklists

### Mailgun (e-mail)
- [ ] Sending domain added and verified; **SPF, DKIM and a DMARC policy** published; the `MAIL_FROM` address is on that domain.
- [ ] Region matches `MAILGUN_SMTP_HOST` (`smtp.mailgun.org` or `smtp.eu.mailgun.org`); SMTP credentials are a dedicated sending key, not the account password.
- [ ] **Webhook**: Sending → Webhooks → add `https://<api-host>/v1/webhooks/mailgun` for *Permanent Failure*, *Spam Complaints* and *Unsubscribes*; copy the **HTTP webhook signing key** into `MAILGUN_WEBHOOK_SIGNING_KEY` (>= 16 chars; the API refuses to boot in production without it).
- [ ] Send a test invite to a real mailbox and one to a known-bad address; confirm the second ends up in `email_suppressions` (`select * from email_suppressions;`) and a second invite to it is not sent.
- [ ] Alert `StoreKeeperEmailDeadLetters` and `StoreKeeperEmailSuppressionSpike` are routed to a person.
- Removing a suppression (the address was fixed): `delete from email_suppressions where email = 'person@example.org';` then resend the invitation.

### Object storage (S3 / Cloudflare R2)
- [ ] Bucket **private** (block all public access); the API serves files through short-lived signed URLs.
- [ ] Credentials are a dedicated IAM user/token limited to this bucket (`GetObject`, `PutObject`, `DeleteObject`, `ListBucket`).
- [ ] `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION` (AWS: the real region; R2: `auto` **and** `S3_ENDPOINT`).
- [ ] Bucket CORS allows the web app origin for `GET` — needed only if the web app `fetch()`es the file; a plain `<img src>` pointing at the presigned URL works without it. (`GET /files/:id` returns `{url, expiresAt}`; with S3 that URL is a presigned bucket URL, with local storage it is the API's own signed `/files/:id/content`.)
- [ ] Lifecycle rule to expire abandoned multipart uploads; versioning on if you need recovery from deletes.
- [ ] Upload a photo through the app, open it from the item page, then delete the item's photo and confirm it is gone.

### Postgres / Redis / platform
- [ ] `DATABASE_URL` uses TLS (`sslmode=require` or `verify-full`); if more than one API instance runs, a pooler (PgBouncer, transaction mode) sits in front and `DB_POOL_MAX` per instance is small.
- [ ] Redis is private (or `rediss://`) with `maxmemory-policy noeviction` for the queue database.
- [ ] TLS terminates at the load balancer, which sets `X-Forwarded-Proto`; `FORCE_HTTPS` and `TRUST_PROXY` are on.
- [ ] Prometheus scrapes `/metrics` with the bearer `METRICS_TOKEN`; `deploy/prometheus/storekeeper.rules.yml` loaded; `deploy/grafana/storekeeper-overview.json` imported; page-level alerts reach a human.

## 6. Release-candidate checklist (state as of this build)

| # | Item | State |
|---|---|---|
| 1 | Full automated suite, lint, build, audit, OpenAPI | **Done** in CI and locally |
| 2 | Ledger invariants and custody read-model proven by the integrity oracle, including under concurrent load, after backup/restore and after PITR | **Done** |
| 3 | Performance evidence at scale and fixes (custody read-model, Collections) | **Done at sandbox scale** (2.5M ledger rows). **Not done:** the plan's 20M-row volume, multi-instance, pooler |
| 4 | Failure drills: Redis down, Postgres down (503 + Retry-After, auto-recovery) | **Done** |
| 5 | Alerts and dashboard as code, validated and unit-tested | **Done** (`promtool`) |
| 6 | Backup, restore and point-in-time recovery drilled | **Done on a sandbox cluster**; rehearse on production-like hardware |
| 7 | Production configuration review tooling | **Done** (`npm run check-config`) |
| 8 | Mailgun bounce/complaint webhook | **Implemented and tested with signed synthetic events. NOT yet tried against a real Mailgun account** |
| 9 | **Mailgun real send** (SPF/DKIM, deliverability, region) | **Not done** — needs your account |
| 10 | **S3/R2 real upload, signed-URL download, CORS** | **Not done** — needs your account |
| 11 | Staging rollout rehearsal using section 2 (including a rollback) | **Not done** |
| 12 | UI walk-through against `StoreKeeper_UI_kit.html` | **Not done** — the file was not available; the API side is pinned by `ui-contract.test.ts` and `FRONTEND-INTEGRATION.md` |
| 13 | Open product questions D1–D4 in `AUDIT-FINDINGS.md` | **Waiting on the product owner** |
| 14 | Demo/staging data | **Done** (`npm run seed:demo`, test-covered) |

Items 9–12 are the gate to calling this a release rather than a release candidate.
