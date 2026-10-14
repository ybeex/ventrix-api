# Frontend integration notes

`docs/openapi.json` describes every endpoint's shape. It does **not** describe the protocols a client must follow. This
document does, and every statement here is pinned by a test (mostly `test/ui-contract.test.ts`, plus the module suites
named in brackets). Base path: `/v1`. All bodies are JSON unless stated.

## 1. Sign-in and the session

1. **Register an organization** (once): `POST /auth/register-org`. **Invited users** accept with `POST /auth/accept-invite {token, password}`; the link in the e-mail carries `?token=`.
2. **Sign in**: `POST /auth/login {orgSlug, email, password, trustDevice?, deviceId?}` → `{token, expiresAt, user}`. A wrong password, an unknown user, an unknown organization and a locked account all return the **same 401**; never try to tell them apart in the UI. Five consecutive failures lock the account for 15 minutes (still a plain 401).
3. **Send the token** as `Authorization: Bearer <token>` on every request. Tokens are opaque; do not parse them. Prefer memory over `localStorage` (see SECURITY.md).
4. **Bootstrap the UI** with `GET /auth/me`: role, `sessionKind` (`primary` | `pin`), `trustedDevice`, `hasPin`, `organization {name, slug, timezone}` and the org `settings` the UI needs (`staffCanManageItems`, `requirePhotoFor`). Drive menu visibility from `role`, but treat the server as the authority: a hidden button must still handle a 403.
5. **Any 401 on an authenticated call means the session is gone** (expired, signed out elsewhere, user deactivated, role changed): clear the token and show sign-in. Do not retry.
6. **Shared devices**: a supervisor/admin signs in with `trustDevice: true, deviceId`; staff then switch with `POST /auth/pin-switch {userId, pin}` (never for admins). Set a PIN with `PUT /auth/pin {password, pin}`.
7. **Sessions screen**: `GET /auth/sessions` (one row has `current: true`), `DELETE /auth/sessions/:id`; admins use `GET|DELETE /users/:id/sessions`. Revocation is immediate. `[sessions.test.ts]`
8. **Reset**: `POST /auth/password-reset/request` always answers 202 (it never reveals whether the address exists); `POST /auth/password-reset/confirm {token, password}`.

Roles: `admin` ⊇ `supervisor` ⊇ `store_staff` ⊇ `viewer` for reading; writing differs by endpoint (see `docs/DECISIONS.md` #6, #19). Viewers can read and scan but never write.

## 2. Idempotency

- `Idempotency-Key: <uuid>` (8–200 chars) is **required** (else `400 VALIDATION_ERROR`, "An Idempotency-Key header … is required") on: every `POST /transactions/*` (checkout, checkout/batch, checkin, consume, restock, adjust, condition, loss, damage, `:id/correct`), `POST /items`, `POST /reconciliations`, `POST /reconciliations/:id/counts`, `POST /users/invitations` (+ `/bulk`) and `POST /announcements`. It is optional elsewhere (holders, shelves, categories, approvals…); sending one is harmless. `[ui-contract: Idempotency-Key matrix]`
- `POST /sync/batch` needs none: `deviceId + clientGeneratedId` is its key (§6).
- **Generate the key once per user intent**, store it with the pending action, and **reuse it on every retry** (timeouts, 5xx, flaky networks). A new key means a new action.
- A retry with the same key and the same body returns the **original body with status 200** (the first answer was 201); `Idempotent-Replayed: true` is set. The side effect happened once. `[ui-contract: batch checkout]`
- Same key + a *different* body → `409 IDEMPOTENCY_KEY_REUSED` (a client bug: do not retry, generate a new key). Same key while the first request is still running → `409 REQUEST_IN_PROGRESS` (wait a moment and retry with the same key).
- A 5xx is never cached: retrying the same key is a genuine second attempt.

## 3. 202 `pending_approval`

Policy (Settings → approvals) decides, per operation (`adjustment`, `loss`, `retirement`, `checkout`, `checkin`), whether staff act directly or file a request. The **same endpoint** therefore answers either:

- `201 {status:"committed", transaction:{…}}` — done, or
- `202 {status:"pending_approval", approval:{id, operation, status:"pending", item, request, requestedBy, createdAt, …}}` — nothing has moved yet.

Branch on **`status`**, not only the HTTP code. For 202 show an "awaiting approval" state (the approval object is everything an approval card needs). A reviewer calls `POST /approvals/:id/approve` or `/reject {note}` (a key is optional here); the requester can `POST /approvals/:id/cancel`. Approving re-validates against live state, so it can fail with a 409 (e.g. the item moved meanwhile) — show the message. Admins are never queued. Nobody approves their own request. `[ui-contract: policy defers a checkout; approvals switch]`

Batch endpoints (`/transactions/checkout/batch`) are **atomic**: either every line commits or none does. Results come back in request order. `[ui-contract: batch checkout]`

## 4. Lists, cursors and filters

- Every list returns `{items:[…], nextCursor}`. Pass `nextCursor` back as `?cursor=`; `null` means the end. `limit` is 1–100 (default 25). Never build a cursor yourself, and never combine a cursor with changed filters.
- Ledger-backed lists (timeline, activity, reports) page on a monotonic `sequence`, **newest first**; each row carries it.
- Lists that support search take `?q=` (items, holders, low-stock are verified; case-insensitive substring). Unknown enum values (`?status=bogus`) are `400`, not ignored.
- **Scan** lookups are exact and case-insensitive: `GET /items/lookup?code=`, `GET /shelves/lookup?code=` → 404 if unknown. Archived records still resolve (so old labels explain themselves); check `archivedAt`.
- Counts shown on cards come from the same SQL as the lists behind them: `GET /collections` and `GET /dashboard` numbers equal `/outstanding`, `/overdue`, `/low-stock` (`?includeNear=true` adds the "close to minimum" rows). Tapping a card can safely show the matching list and expect the same count. `[ui-contract: Collections cards]`
- Quantities are whole numbers with a unit label. Timestamps are ISO-8601 UTC; "today" on the dashboard is the organization's local day (`me.organization.timezone`).

## 5. Errors

Every non-2xx has one envelope: `{"error":{"code","message","requestId", "details"?}}`.

- Show `message` to people (it is written for them); branch on `code` in code. Quote `requestId` in support requests.
- `400 VALIDATION_ERROR` carries `details[]` (`instancePath`, `message`): map `instancePath` to the field. Bodies are strict: an unknown field is a 400, so do not send extra properties.
- `401` → sign in again. `403 FORBIDDEN` → the role lacks the permission (also logged). `404 NOT_FOUND` also covers "exists in another organization".
- `409` is a business conflict, e.g. `INSUFFICIENT_STOCK`, `HOLDER_MISMATCH`, `CORRECTION_BLOCKED`, `SHELF_NOT_EMPTY`, `CATEGORY_NOT_EMPTY`, `RECONCILIATION_CLOSED`, `ISSUE_RESOLVED`, `EMAIL_TAKEN`, `IDEMPOTENCY_KEY_REUSED`. `422` is a rule the request broke, e.g. `REASON_REQUIRED` (a count that differs from the system needs a reason), `NOT_REPLAYABLE`, `INVALID_EXPIRY`, `SHELF_ARCHIVED`.
- `429` (rate limit) and `503` (load shedding / dependency down; `Retry-After` is sent on 503): back off and retry **with the same Idempotency-Key**.

## 6. Offline protocol

1. **Prime the cache** (online): `GET /sync/snapshot/reference` (shelves, categories, locations, settings), `GET /sync/snapshot/items?limit=500` and `/sync/snapshot/holders` — each returns `{items, cursor, hasMore, serverTime}`. Follow `cursor` while `hasMore`. *(These use `cursor`/`hasMore`, not `nextCursor`.)*
2. **Refresh** with `?since=<serverTime from your last full pass>`: you get the items changed since, **including archived ones** (mark them inactive). Duplicates across pages are possible and harmless: upsert by `id`.
3. **Queue actions** while offline. Each gets a stable `clientGeneratedId` (≥ 8 chars, e.g. a UUID), the operation `type`, `queuedAt` (when the person acted) and the same `payload` the online endpoint takes. Types: `checkout`, `checkin`, `consume`, `restock`, `adjustment`, `loss`, `damage`, `condition`.
4. **Send** `POST /sync/batch {deviceId (≥ 4 chars), actions:[…]}` (no Idempotency-Key needed: `deviceId + clientGeneratedId` is the key). The response is **200 with one result per action, in request order**:

   | `status` | Meaning | UI |
   |---|---|---|
   | `applied` | Recorded; `transactionId` | remove from queue |
   | `duplicate` | Already recorded earlier (a resend) | remove from queue — it is done |
   | `pending_approval` | Policy queued it; `approvalId` | remove; show "awaiting approval" |
   | `conflict` | The world changed (e.g. `INSUFFICIENT_STOCK`); `issueId`, `code`, `message` | remove from queue; it now lives under **Sync problems** |
   | `rejected` | Malformed/invalid payload; `issueId`, `code`, `message` | remove; Sync problems (cannot be applied, only dismissed) |

   One bad action never blocks the others. Resending the whole batch is always safe.
5. **Sync problems** (`GET /sync/conflicts`, reviewers): `POST /sync/conflicts/:id/resolve {resolution:"keep_server"|"apply_client", note}`. `apply_client` re-runs the action *as the original person* and can still fail with the original reason (the issue stays open); a `rejected` issue can only be `keep_server` (`422 NOT_REPLAYABLE` otherwise). `[ui-contract: offline round trip; sync.test.ts]`
6. The server orders history by its own ledger `sequence`; `occurredAt` is the device's claim (clamped against clock skew), `createdAt` is when the server received it.

## 7. Screens → endpoints (as verified)

| Screen / control | Endpoint(s) | Notes |
|---|---|---|
| Scan an item / shelf | `GET /items/lookup?code=`, `GET /shelves/lookup?code=` | result includes `shelfName`, `categoryName`, `assetState`, `dueStatus`, `lowStock`, `nearMinimum` |
| Holder picker | `GET /holders?q=`, `GET /holders/recent` | kinds: `person`, `team`, `department`, `job_site`, `other`; archived hidden |
| Batch checkout | `POST /transactions/checkout/batch {holderId, lines:[{itemId, quantity?}]}` | atomic; 201/200 (replay)/202 |
| Outstanding table | `GET /outstanding` | `issuedQuantity`, `returnedQuantity`, `partialReturn`, `dueAt` (oldest unreturned issue), `dueStatus` (`on_time`/`due_soon`/`overdue`; `null` for a consumable line with no due date — an asset with no due date reads `on_time`), `overdueByHours` |
| Check in / inspection / lost | `POST /transactions/checkin {condition}`, `/condition`, `/loss` | `good→available`, `needs_inspection→under_repair`, `damaged→damaged`; loss/retirement usually 202 for staff |
| Count against the shelf | `POST /reconciliations {scope:"shelf",scopeId}` → `GET /:id/expected` (checklist, `counted` flag) → `POST /:id/counts {itemId, physicalQuantity, reason?}` → `GET /:id` (`reconciliation`, `counts`, `summary`) → `POST /:id/close` | `reason` required on a variance; a closed count refuses entries |
| Collections cards | `GET /collections` | per shelf and per category: assets, products, units, checkedOut, underRepair, damaged, lost, lowStock, nearMinimum, overdue |
| Low stock / close to minimum | `GET /low-stock?includeNear=true` | `status: low|near`, `shortfall`, `headroom`; low rows first |
| Item detail + timeline | `GET /items/:id`, `GET /items/:id/timeline` | timeline newest-first by `sequence`; rows have `actor`, `holder`, `stateBefore/After`, `summary` |
| Activity | `GET /activity?category=&action=` (`action=transaction.*` allowed), `GET /activity/actions` (filter options) | `summary` is a ready-made sentence; admins/supervisors only |
| Approvals switch | `GET|PUT /organization/approval-policy` | `adjustmentMode: direct|staff_approval|all_approval` |
| Announcement banner, bell | `GET /announcements`, `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all`, `GET|PUT /notifications/preferences[/:type]` | banner is role-scoped; admins manage with `GET /announcements?all=true`, `POST`, `PATCH`, `/retract` |
| Notification routing (admin) | `GET /organization/notification-rules`, `PUT …/:type {roles}` | six routable types |
| Invites (admin/supervisor) | `POST /users/invitations`, `/bulk`, `GET /users/invitations?status=`, `POST /users/:id/invitations/resend|revoke` | bulk returns a per-row `status`: `invited`, `exists`, `forbidden`, `invalid` |

## 8. Wording the product owner should review

Server-written sentences are plain English and can be changed in one place (`src/lib/describe.ts`): activity summaries, notification titles/bodies, announcement e-mails. One known quirk: **item-scoped timeline summaries say "an item"** ("Stella checked out an item to John") because the item is implicit on that screen; compose your own line from `type`, `actor`, `holder` and the item you are showing if you want the name. See AUDIT-FINDINGS D4.
