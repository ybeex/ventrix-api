/**
 * Ledger integrity audit — recomputes truth from the append-only ledger and compares it with the guarded
 * state columns. The design promise (PRD §12 "derived from recorded transactions") is only worth something
 * if it can be CHECKED, so this exists as code: tests assert it after every scenario, and the worker runs it
 * on a schedule in production (any violation is logged at error level and exported as a metric).
 *
 *  stock_matches_ledger     consumable quantity_available == Σ stock_delta
 *  balance_chain_broken     every consumable ledger row's balance_before == the previous row's balance_after
 *  negative_custody         no holder's outstanding balance for an item is below zero
 *  asset_custody_mismatch   an asset is checked_out ⇔ exactly one holder has custody (and it is current_holder_id)
 *  asset_state_chain_broken every asset ledger row's state_before == the previous row's state_after
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';

export interface Violation { check: string; itemId: string | null; detail: Record<string, unknown> }

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

export async function findViolations(db: Db, orgId?: string): Promise<Violation[]> {
  const org = orgId ? sql`and i.org_id = ${orgId}` : sql``;
  const out: Violation[] = [];

  for (const r of rowsOf<{ id: string; q: number; ledger: number }>(await db.execute(sql`
    select i.id, i.quantity_available as q, coalesce(sum(t.stock_delta), 0)::int as ledger
    from items i left join transactions t on t.item_id = i.id
    where i.type = 'consumable' ${org}
    group by i.id having i.quantity_available <> coalesce(sum(t.stock_delta), 0)`))) {
    out.push({ check: 'stock_matches_ledger', itemId: r.id, detail: { quantityAvailable: r.q, ledgerSum: r.ledger } });
  }

  for (const r of rowsOf<{ item_id: string; seq: number; before: number; prev_after: number }>(await db.execute(sql`
    select * from (
      select t.item_id, t.seq, t.balance_before as before,
             lag(t.balance_after) over (partition by t.item_id order by t.seq) as prev_after
      from transactions t join items i on i.id = t.item_id
      where i.type = 'consumable' ${org}) x
    where prev_after is not null and before is distinct from prev_after`))) {
    out.push({ check: 'balance_chain_broken', itemId: r.item_id, detail: { seq: r.seq, balanceBefore: r.before, previousBalanceAfter: r.prev_after } });
  }

  for (const r of rowsOf<{ item_id: string; holder_id: string; s: number }>(await db.execute(sql`
    select t.item_id, t.holder_id, sum(t.custody_delta)::int as s
    from transactions t join items i on i.id = t.item_id
    where t.holder_id is not null ${org}
    group by t.item_id, t.holder_id having sum(t.custody_delta) < 0`))) {
    out.push({ check: 'negative_custody', itemId: r.item_id, detail: { holderId: r.holder_id, outstanding: r.s } });
  }

  for (const r of rowsOf<{ id: string; asset_state: string; current_holder_id: string | null; holder_id: string | null; s: number | null }>(await db.execute(sql`
    select i.id, i.asset_state, i.current_holder_id, c.holder_id, c.s
    from items i
    left join (select item_id, holder_id, sum(custody_delta)::int as s from transactions where holder_id is not null group by 1, 2 having sum(custody_delta) <> 0) c on c.item_id = i.id
    where i.type = 'asset' ${org} and (
      (i.asset_state = 'checked_out' and (c.holder_id is distinct from i.current_holder_id or c.s is distinct from 1))
      or (i.asset_state <> 'checked_out' and c.item_id is not null))`))) {
    out.push({ check: 'asset_custody_mismatch', itemId: r.id, detail: { state: r.asset_state, currentHolderId: r.current_holder_id, ledgerHolderId: r.holder_id, ledgerCustody: r.s } });
  }

  for (const r of rowsOf<{ item_id: string; seq: number; before: string; prev_after: string }>(await db.execute(sql`
    select * from (
      select t.item_id, t.seq, t.state_before::text as before,
             lag(t.state_after) over (partition by t.item_id order by t.seq)::text as prev_after
      from transactions t join items i on i.id = t.item_id
      where i.type = 'asset' and t.state_after is not null ${org}) x
    where prev_after is not null and before is distinct from prev_after`))) {
    out.push({ check: 'asset_state_chain_broken', itemId: r.item_id, detail: { seq: r.seq, stateBefore: r.before, previousStateAfter: r.prev_after } });
  }
  return out;
}
