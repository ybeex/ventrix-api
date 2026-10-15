# Findings: before → after

Four sections: **(A)** defects in the reference starter (`chore/baseline-starter`), found by reading it against the
backlog and PRD before building on it; **(B)** defects introduced or exposed during the first build and caught by the
test suite; **(C)** defects found while adding the governance test suites; **(D)** open questions flagged for the product
owner and deliberately not changed. Every defect has a regression test.

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

## C. Defects found while adding the governance and UI-contract test suites (WS1, WS4)

| # | Before | After | Test |
|---|---|---|---|
| C1 | The e-mail outbox claimed rows with `UPDATE … RETURNING`, which does **not** preserve the subquery's `ORDER BY`. Under row churn (retries/backoff) mails were sent in heap order — a superseded invite or reset link could be delivered *after* its replacement (18 of 20 trials inverted). Surfaced as an intermittent failure in the re-invite test. | The claim is a CTE that carries each row's due time out; the final `SELECT` orders by it. | `outbox.test.ts` (fails on the old code) |
| C2 | Activity sentences for report views read "viewed the **a** report": the report name is the audit row's `entityId`, which was never resolved. | A report's id is used as its name. | `activity.test.ts` summaries |
| C3 | `session.revoked` sentences never said whose session ("X signed out a session") because the formatter read a field that is never written. | Uses `own` / `allDevices` / `sessions` and the target's name: "signed out one of their own devices" / "signed out Stella Staff everywhere (3 sessions)". | `activity.test.ts` session test |
| C4 | The fallback sentence for an unregistered audit action printed the raw key (`legacy.thing_happened`). | Humanised label; category "Other"; never an error. | `activity.test.ts` fallback test |
| C5 | Resolving a **rejected** (malformed) sync issue with `apply_client` replayed the garbage payload into the database and returned **500** (`INTERNAL_ERROR`). Found by the offline round-trip contract test. | A rejected action is not replayable: 422 `NOT_REPLAYABLE`, the issue stays open, `keep_server` dismisses it. | `sync.test.ts` REGRESSION (fails on the old code) |
| C6 | **Collections** computed overdue with a correlated subquery over the outstanding CTE once per category; at 1.7M ledger rows it did not finish in 120 s. | Overdue lines are aggregated per category once and joined: 1.7 s on the stress org, ~93 ms on a realistic one. | `operations-governance.test.ts` (cards == lists); `scripts/time-queries.ts` |
| C7 | Dashboard / Outstanding / Collections aggregated the org's **entire custody ledger on every request** (O(ledger)): 3.3 s each at 1.7M rows, 4–8 s under 8 concurrent users. | Trigger-maintained `custody_balances` read-model + two covering partial indexes; the oracle verifies parity (`custody_balances_mismatch`). 0.7 s stress / ~70 ms realistic; throughput 5.4 → 17.1 req/s on the same core. | `custody-balances.test.ts` (7 tests), oracle |
| C8 | With Postgres down the API answered **500 INTERNAL_ERROR** (found by the failure drill), so clients and alerts could not tell an outage from a bug and nothing told them to retry. | Connection-level failures (ECONNREFUSED, CONNECTION_ENDED, SQLSTATE 08xxx / 57P0x / 53300, also through Drizzle's `.cause`) → `503 TEMPORARILY_UNAVAILABLE` + `Retry-After: 5`; no driver text in the body. Verified live: stop Postgres, probe, restart. | `error-handler.test.ts` (12 tests) |

Verified by deliberately breaking behaviour and watching a test fail: FIFO comparison (`>`→`>=`), FIFO order, near-band boundary (`<=`→`<`), supervisor invite matrix, `supervisorsCanInvite`, lockout-once, the migration default, and one audit action name.

## D. Open questions (flagged, not changed)

| # | Observation | Options | Pinned by |
|---|---|---|---|
| D1 | Closing a **shelf** count with zero items counted still resets that shelf's cycle-count clock, so reminders can be silenced with an empty count. | Require ≥1 count / all expected items / a configurable percentage before the clock resets. | `cycle-counts.test.ts` "documented behaviour…" |
| D2 | A supervisor acting on an admin-role invitation gets 403, revealing the user id exists; the code comment intends 404. | Check visibility before permission (404), at the cost of a slightly less helpful message. | `invites.test.ts` |
| D3 | Any role (including viewers) can read a reconciliation's counts and system quantities (`reconciliation:read` = every role); DECISIONS #6 had implied admin + supervisor only. | Keep (transparency for the floor) or restrict reading to reviewers. | `ui-contract.test.ts` count test |
| D4 | Item-scoped timeline summaries say "an item" ("Stella checked out an item to John") because the item is implicit on that screen; the batch response and activity feed name it. | Pass the item name into item-timeline summaries, or leave it to the client to compose. | probe in WS4; `docs/FRONTEND-INTEGRATION.md` §8 |
