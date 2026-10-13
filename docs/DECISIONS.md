# Design decisions & PRD reconciliation

Where the PRD, the starter, or the backlog conflicted, the conflict was flagged and resolved with the product owner
before building. This is the record of what was decided and how it is implemented.

| # | Conflict | Decision (as built) |
|---|---|---|
| 1 | Holders vs. login users (§8, §5) | One `holders` table (person, team, department, job_site, other). A person need not have an account; an account links to exactly one person holder. The ledger stores one `holder_id`. |
| 2 | Asset state vs. condition (§12 vs §15.2) | Exactly the six §12 states (`available, checked_out, lost, damaged, under_repair, retired`) plus a separate condition (`good, damaged, needs_inspection, replaced`). Mapping on return: good→available, damaged→damaged, needs_inspection→under_repair, replaced→retired. `archived_at` is a separate visibility flag (§51). |
| 3 | Corrections (§24, §50) | A `CORRECTION` ledger type: a reversal row linked to the original (+ optional replacement row). Refused (409 `CORRECTION_BLOCKED`) if later activity depends on the original. One reversal per transaction (unique index). Admin only. |
| 4 | Derived vs. stored balance (§12) | A guarded balance column + signed `stock_delta` on every row; `findViolations()` proves they agree (tests + nightly). Pure SUM-on-read cannot give race-safe stock checks at scale. |
| 5 | LOSS / DAMAGE / RECONCILIATION (§11.1 "future" vs §17/§19 "core") | Built as core, for assets *and* consumables. |
| 6 | Roles (§31) | Admin ⊇ everything. Supervisors also issue/return items. Store Staff manage items only if `staffCanManageItems`. Adjustments/loss/retirement are policy-gated. Reconciliation and reports: admin + supervisor. |
| 7 | Approvals (§18, §32) | Per-operation modes: `direct`, `staff_approval`, `all_approval` (admins never queued). Operations: adjustment, loss, retirement, checkout, check-in. Large-adjustment threshold escalates to `all_approval`. Defaults: adjustment/loss/retirement need approval for staff; routine ops direct (§32). Approvals re-validate against live state. No self-approval. |
| 8 | Checkout override vs. no negative stock (§13.3 vs §38) | Supervisor-authorized override first records an explicit `unrecorded_movement` adjustment for the shortfall, then draws stock down. Stock never goes negative; the gap is visible and attributed. |
| 9 | Location vs. job/site (§9, §10) | `locations` (stores/areas; item home location; `location_id` on every transaction; MVP = 1 active store via `MAX_LOCATIONS_PER_ORG`) are separate from `jobs` (optional context on a transaction). |
| 10 | Quantities | Whole numbers + a unit label. |
| 11 | Offline timestamps (§11, §21) | `occurred_at` (device claim, clamped against clock skew) and `created_at` (server receive time). Order is by server ledger sequence (`seq`). |
| 12 | Shared devices (§49) | Supervisor/admin registers a trusted device; staff switch with a PIN (never admins; lockout; PIN sessions cannot mint sessions). |
| 13 | Infrastructure | Mail: nodemailer over Mailgun SMTP. Storage: S3-compatible (private buckets, signed URLs) with a local driver for dev/test. Background work: BullMQ on Redis. |
| 14 | Scope | Phase 1 + 1.5 fully built. Phase 2/3 only as structural readiness (location-aware schema, `TRANSFER` not implemented, no public API / WhatsApp / SMS). |

## Additional choices worth knowing

- **Item IDs**: UUID primary key + human-readable `PREFIX-0001` (category prefix; gapless per-prefix counter). `code` (the scannable value) defaults to the Item ID; a custom code may never equal another item's Item ID.
- **Due dates** are fixed at issue time (stored on the checkout row), so a later policy change never rewrites history.
- **Low stock** = quantity ≤ item minimum, else category default; no minimum ⇒ not monitored. Events fire on each *downward crossing*.
- **Discrepancy resolution** is derived live (counts are immutable): matched · adjusted · pending_approval · rejected · unresolved. "Open" = latest count for the item that is pending/rejected/unresolved.
- **Audit**: every ledger row also writes an audit event (previous/new state, reason, transaction) in the same DB transaction.
- **Validation**: JSON bodies are strict (no coercion, no unknown fields); query strings are coerced.
- **Dashboard "today"** is the organization's local day (`organizations.timezone`, default `Africa/Lagos`).
