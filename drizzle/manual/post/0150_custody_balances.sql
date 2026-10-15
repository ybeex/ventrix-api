-- Custody read-model: one row per (item, holder) holding the running totals the Outstanding / Collections / Dashboard screens need.
-- It is DERIVED from the append-only ledger by an AFTER INSERT trigger (same transaction, so it can never disagree with a committed row),
-- and the integrity oracle recomputes it from the ledger and compares (check "custody_balances_mismatch").
-- Replaces a full-ledger aggregate on every request: the screens now cost O(outstanding lines), not O(ledger rows).
-- Idempotent; backfills once when the table is empty.
create table if not exists custody_balances (
  org_id     uuid not null references organizations(id) on delete cascade,
  item_id    uuid not null references items(id),
  holder_id  uuid not null references holders(id),
  quantity   integer not null default 0,        -- Σ custody_delta (what the holder has now)
  issued_all integer not null default 0,        -- Σ positive custody_delta incl. corrections (drives FIFO due-date selection)
  issued     integer not null default 0,        -- Σ positive custody_delta excluding corrections
  returned   integer not null default 0,        -- Σ -negative custody_delta excluding corrections
  since      timestamptz,                       -- latest checkout
  primary key (item_id, holder_id)
);
create index if not exists custody_balances_org_open_idx on custody_balances (org_id) where quantity > 0;

create or replace function storekeeper_apply_custody() returns trigger as $$
begin
  if new.holder_id is not null and new.custody_delta <> 0 then
    insert into custody_balances as cb (org_id, item_id, holder_id, quantity, issued_all, issued, returned, since)
    values (new.org_id, new.item_id, new.holder_id, new.custody_delta, greatest(new.custody_delta, 0),
            case when new.custody_delta > 0 and new.type <> 'correction' then new.custody_delta else 0 end,
            case when new.custody_delta < 0 and new.type <> 'correction' then -new.custody_delta else 0 end,
            case when new.type = 'checkout' then new.created_at end)
    on conflict (item_id, holder_id) do update set
      quantity = cb.quantity + excluded.quantity, issued_all = cb.issued_all + excluded.issued_all,
      issued = cb.issued + excluded.issued, returned = cb.returned + excluded.returned, since = greatest(cb.since, excluded.since);
  end if;
  return null;
end $$ language plpgsql;

drop trigger if exists transactions_custody on transactions;
create trigger transactions_custody after insert on transactions for each row execute function storekeeper_apply_custody();

do $$ begin
  if not exists (select 1 from custody_balances limit 1) and exists (select 1 from transactions where holder_id is not null and custody_delta <> 0 limit 1) then
    lock table transactions in share mode; -- no ledger writes between the backfill snapshot and the (already installed) trigger
    insert into custody_balances (org_id, item_id, holder_id, quantity, issued_all, issued, returned, since)
    select t.org_id, t.item_id, t.holder_id, sum(t.custody_delta), coalesce(sum(t.custody_delta) filter (where t.custody_delta > 0), 0),
           coalesce(sum(t.custody_delta) filter (where t.custody_delta > 0 and t.type <> 'correction'), 0),
           coalesce(sum(-t.custody_delta) filter (where t.custody_delta < 0 and t.type <> 'correction'), 0),
           max(t.created_at) filter (where t.type = 'checkout')
    from transactions t where t.holder_id is not null and t.custody_delta <> 0 group by t.org_id, t.item_id, t.holder_id;
  end if;
end $$;
