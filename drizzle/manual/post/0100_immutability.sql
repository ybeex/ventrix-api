-- PRD §24 / §50 / LOG-01: historical records are never silently rewritten.
-- This is enforced by the database, not by application discipline: even a buggy deploy,
-- a stray psql session or an ORM bulk update cannot edit or delete these rows.
-- (TRUNCATE is deliberately not blocked so test suites can reset state.)
create or replace function storekeeper_forbid_mutation() returns trigger as $$
begin
  raise exception '% rows are immutable (% blocked); issue a corrective transaction instead', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$ language plpgsql;

drop trigger if exists transactions_immutable on transactions;
create trigger transactions_immutable before update or delete on transactions
  for each row execute function storekeeper_forbid_mutation();

drop trigger if exists audit_events_immutable on audit_events;
create trigger audit_events_immutable before update or delete on audit_events
  for each row execute function storekeeper_forbid_mutation();

drop trigger if exists reconciliation_counts_immutable on reconciliation_counts;
create trigger reconciliation_counts_immutable before update or delete on reconciliation_counts
  for each row execute function storekeeper_forbid_mutation();
