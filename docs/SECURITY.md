# Security model

## Controls implemented (and where they are tested)

| Area | Control | Test |
|---|---|---|
| Access control | Every route must declare `config.permission` or `config.public`, else **the app refuses to boot**. Auth + permission run in `onRequest` (before body parsing/validation), so anonymous callers learn nothing about schemas. | `access.test.ts` walks every registered route × every role |
| Tenancy | Every table carries `org_id`; every query filters on it; every client-supplied reference (category, holder, file, location, scope id…) is verified against the caller's org — a foreign key proves existence, not ownership. | tenant-isolation test in each module |
| Authentication | 256-bit random bearer tokens, only SHA-256 stored; argon2id passwords; atomic failed-attempt counter + lockout; timing-equalised, enumeration-resistant login; sessions revoked immediately on logout / deactivation / role change / password reset (cache invalidated). | `identity.test.ts` |
| Invites & resets | Single-use, hashed, expiring tokens redeemed by one atomic `UPDATE`; reset signs out everywhere; reset request always returns 202. | `identity.test.ts` |
| Shared devices | PIN switch only from a supervisor/admin-registered device; never for admins; per-user lockout; PIN sessions cannot mint sessions. | `identity.test.ts`, `access.test.ts` |
| Input | Strict schemas (`additionalProperties:false`, no body coercion — JSON `null` never becomes `0`); unknown fields → 400 (mass-assignment defence); LIKE metacharacters escaped; all SQL parameterised. | `catalog`, `transactions`, `security` |
| Integrity | Ledger, audit log and reconciliation counts are immutable via DB triggers; CHECK constraints forbid negative stock and stateless holders even for raw SQL. | `DATABASE GUARDS` test |
| Files | Type decided by magic bytes (JPEG/PNG/WebP only; SVG/HTML refused), size cap, server-generated keys, private storage, short-lived HMAC/presigned URLs, served with `nosniff` + `sandbox` CSP. | `catalog.test.ts` |
| CSV | Formula-injection neutralisation on every export; import parsing caps (size, rows, columns, binary). | `operations`, `imports` |
| Transport | `FORCE_HTTPS` (426 on plain HTTP; probes exempt), HSTS in production, strict CORS allowlist (fails closed). | `security.test.ts` |
| Headers | CSP `default-src 'none'`, `nosniff`, `no-referrer`, `Cache-Control: no-store` on API responses, no `X-Powered-By`. | `security.test.ts` |
| Abuse | Redis-backed rate limits: per-IP on credential routes, per-session elsewhere (a shared warehouse NAT is not one client); load shedding with `Retry-After`. | `security.test.ts` |
| Secrets | Production boot validation (strong secrets, https, Mailgun + S3 required); secrets and bearer tokens redacted from logs. | `security.test.ts` (child process) |
| Supply chain | `npm audit` gate in CI; swagger UI is a dev-only dependency loaded dynamically (not in the production image). 0 known production vulnerabilities at the time of writing. | CI |
| Resilience | Circuit breakers on mail, storage, queue, Redis; outbox patterns; no request ever blocks on a third party for long. | `identity`, `catalog`, `imports` |
| Auditability | Every material event audited with actor, request id, IP, previous/new state; report/export actions are themselves audited. | `transactions`, `operations` |
| Security-event logging | Failed sign-ins are recorded with a reason (`bad_password`, `unknown_user`, `inactive`, `locked`) and attributed to the user, or to the organization when the user is unknown; the response is byte-identical in every case. `auth.account_locked` fires exactly once per lockout (also under concurrent guesses). Passwords, PINs and tokens are never written to the log. | `security-events.test.ts` |
| Access-denied log | A 403 writes `access.denied` (route, required permission, role — never the request body). 401s are not logged (no identity to attribute). | `security-events.test.ts` |
| Logging never alters behaviour | An audit-write failure cannot turn a 401/403/202 into a 500 or change the response. | `security-events.test.ts` (forces every audit insert to fail) |
| Session management | Users list and revoke their own sessions (including the current one); admins list and revoke all sessions of anyone in their org; revocation is immediate (cache invalidated); other tenants get 404. | `sessions.test.ts` |
| Role-based invites | Invite/resend/revoke/list follow the matrix in DECISIONS #19, including the `supervisorsCanInvite` switch; a refused invite creates nothing; invite links are single-use and replaced on resend; revoke kills the link. | `invites.test.ts` (full 4×4 role matrix) |
| Read logging | Viewing the activity feed or a report writes `activity.viewed` / `report.viewed` (first page only), CSV export writes `report.exported`. | `activity.test.ts` |
| Audit completeness | Every mutating route must write an audit row or be on an explicit allowlist; the test fails when a new route is neither. | `audit-mutations.test.ts` |

## Not covered (be aware)

- **No MFA / SSO** (PRD does not require it). Passwords + lockout + rate limits only.
- **No Postgres row-level security.** Tenant isolation is enforced in application code and tested per module; RLS would add defence-in-depth (needs `SET LOCAL app.org_id` per transaction; compatible with PgBouncer transaction pooling).
- **No malware scanning** of uploaded images (type/size validated; served sandboxed from a private bucket).
- **No field-level encryption**; rely on disk/volume encryption and TLS. Item photos are as sensitive as the customer decides.
- **Bearer tokens in browsers**: if the web client stores the token in `localStorage`, XSS in the client can steal it. Prefer memory + short idle logout, or put the API behind a BFF that holds the session in an `HttpOnly` cookie.
- Rate limits and breakers are per process / per Redis; they are not a substitute for an edge WAF/DDoS layer.

- **The audit log is append-only by DB trigger, not tamper-evident.** A database superuser can still disable the trigger; there is no hash chain or external log shipping. Ship audit rows to write-once storage if your threat model includes a malicious DBA.
- **Failed sign-ins for an unknown organization are not logged** (there is no tenant to attribute them to); they are visible only through rate-limit and `storekeeper_auth_failures_total` metrics.
- **`access.denied` bursts are recorded but not alerted on by the app**; wire the query in OPERATIONS.md into your alerting.
- **Known low-severity leak:** a supervisor resending/revoking an invitation for an admin-role user gets 403 rather than 404, confirming that user id exists in their organization (ids are random UUIDs; same tenant only). See AUDIT-FINDINGS D2.
- Audit rows contain e-mail addresses and IPs (personal data); plan retention accordingly — rows cannot be deleted through the app.

## Reporting & response
Treat any `storekeeper_integrity_violations > 0`, a sustained `circuit_breaker_state{name=…} == 2`, a spike in
`storekeeper_auth_failures_total`, any `auth.account_locked` event, or a burst of `access.denied` rows from one user as security-relevant signals (see OPERATIONS.md).
