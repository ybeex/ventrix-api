# Findings: before → after

Two sources: **(A)** defects in the reference starter (`chore/baseline-starter`), found by reading it against the
backlog and PRD before building on it; **(B)** defects introduced or exposed during this build and caught by the
test suite. Each has a regression test.

## A. Starter defects

| # | Before | After | Test |
|---|---|---|---|
| A1 | `PATCH /items/:id` accepted `quantityAvailable`: stock could be changed with **no ledger row**, breaking the stock = Σ ledger invariant. | Body schema is strict; stock/state/holder/condition are not editable fields (400). Only ledger operations change them. | `catalog` REGRESSION |
| A2 | Adjustments stored `Math.abs(delta)`: **+5 and −5 were indistinguishable** in the ledger; "loss" could increase stock. | Every row carries signed `stock_delta`/`custody_delta`; loss/damage are separate typed events that can only reduce. | `transactions` adjustments |
| A3 | Opening stock was never in the ledger (balance formula §12 unprovable). | Item creation writes a CREATE row with the opening balance; integrity oracle proves balance = Σ deltas. | `catalog`, `integrity` |
| A4 | `?status=bogus` on items → **500** (unvalidated string cast to a DB enum). | Typed enum in the schema → 400. | `catalog` search |
| A5 | Asset check-in didn't verify who was returning it; the ledger could name the wrong holder. | Holder derived from custody when omitted; mismatch → 409 `HOLDER_MISMATCH`; compare-and-set on (state, holder). | `transactions` |
| A6 | Assets checked in as "needs inspection" had **no way back** into service. | Full state model (§12) with recorded transitions: repair, found-again, retire; terminal states enforced. | `transactions` condition test |
| A7 | Offline sync: one failing action **aborted the whole batch** (poison pill); each retry inserted another conflict row. | Per-action outcomes; conflicts unique per (org, device, client id); a retry that now succeeds closes its own issue. | `sync` |
| A8 | Dashboard "today" used the UTC day (Lagos/Accra are off by up to an hour at midnight). | Evaluated in the organization's timezone. | `operations` timezone test |
| A9 | Keyset pagination round-tripped microsecond timestamps through a millisecond JS `Date`: rows written in the same ms could be **skipped** across pages. | `created_at` truncated to ms; ledger/audit page on a monotonic `seq`. | `catalog` timeline |
| A10 | A malformed pagination cursor threw a plain `Error` → **500**. | `ValidationError` → 400. | `catalog`, `operations` |
| A11 | Idempotent replay with the same key but a *different* request silently returned the old result. | Request fingerprint stored with the ledger row; mismatch → 409 `IDEMPOTENCY_KEY_REUSED`. | `transactions` |
| A12 | Reconciliation: resolution never updated after an approval → dashboard counted resolved discrepancies forever. | Resolution derived live from the approval outcome; one SQL definition shared by dashboard and report. | `reconciliation` POLICY test |
| A13 | Reconciliation `scope_id` was never validated or enforced (cross-tenant reference, counts outside scope). | Verified against the org at creation; each count must be in scope (422 `OUT_OF_SCOPE`). | `reconciliation` |
| A14 | Ledger immutability was a convention only. | DB triggers on `transactions`, `audit_events`, `reconciliation_counts`. | `DATABASE GUARDS` |
| A15 | Low-stock rule treated "no threshold" as 0 (every empty unmonitored item flagged). | Threshold = item min, else category default; none ⇒ not monitored. | `catalog`, `operations` |
| A16 | Batch checkout could deadlock between concurrent batches over the same items. | Canonical (item-id) lock order; responses in request order. | `transactions` batch |
| A17 | Users were created with an admin-chosen password; no invite acceptance; last admin could be demoted. | Hashed single-use invite tokens, password reset, last-admin guard serialised by advisory lock. | `identity` |
| A18 | `SKILL.md` claimed "every P0 epic" was covered; categories, holders CRUD, photos, outstanding/low-stock/overdue, QR, corrections, reports, etc. had no endpoints. | All implemented against PRD v3. | all suites |

## B. Defects found during this build

| # | Before | After | Test |
|---|---|---|---|
| B1 | **Ajv coerced JSON `null` → `0`** in request bodies: `{"largeAdjustmentThreshold": null}` stored `0`, so *every* adjustment required approval. Same class: `null → false`, `"" `. | Part-aware validation: bodies are never coerced; query/params are. | `transactions` null regression |
| B2 | Raw `sql` templates passed JS `Date` straight to postgres.js; with `prepare:false` (required for PgBouncer) it threw → 500 on dashboard/outstanding. | `ts()` helper sends ISO strings with `::timestamptz`. | `operations` |
| B3 | Raw query rows returned timestamps as strings; serializers called `.getTime()` → 500 once a due date existed. | Normalised to `Date` at the query boundary. | `operations` overdue |
| B4 | A malformed `itemId` in a queued sync payload was copied into a `uuid` column → **500 for the whole batch**. | Only well-formed UUIDs are copied; the action is `rejected`. | `sync` |
| B5 | Reserving `PREFIX-0001`-shaped custom codes banned natural tags (`TAG-7731`). | No reservation: generated IDs skip claimed codes; a code may never equal another item's Item ID. | `catalog` |
| B6 | Batch responses came back in storage (lock) order, and replays differed from first responses. | Request order everywhere (keyed `<key>#<requestIndex>`). | `transactions` batch |
| B7 | Worker `close()` left BullMQ connections open → process hung on shutdown. | All connections tracked and disconnected. | `notifications` e2e |
| B8 | Infra routes (`/healthz`, `/metrics`) were registered before the access plugin, so the route audit couldn't see them. | Access plugin registered first; allowlist pinned in a test. | `access` |
| B9 | Fastify accepted `text/plain` JSON-ish bodies. | JSON-only; other types → 415. | `security` |
| B10 | Production dependencies had 5 advisories (nodemailer high ×2, drizzle-orm high, csv-parse, swagger-ui→@fastify/static). | Upgraded to patched majors; swagger moved to dev-only dynamic import. 0 advisories. | CI `npm run audit` |
| B11 | `incident`/approval defaults: low-stock event fired for items *created* below minimum — judged correct (fires on downward crossing); documented rather than changed. | Documented in DECISIONS.md. | `notifications` |
