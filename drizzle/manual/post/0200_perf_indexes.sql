-- Performance indexes for the custody read-model (see docs/OPERATIONS.md "Performance evidence").
-- Idempotent. On a very large existing ledger, create these once with CREATE INDEX CONCURRENTLY first (same names) so the deploy does not block writes.
create index if not exists tx_custody_bal_idx on transactions (org_id, item_id, holder_id) include (custody_delta, type, created_at) where holder_id is not null and custody_delta <> 0;
create index if not exists tx_custody_issues_idx on transactions (org_id, item_id, holder_id, seq) include (custody_delta, due_at) where custody_delta > 0 and holder_id is not null;
