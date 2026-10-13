/**
 * The single definition of "reconciliation count resolution" and "open discrepancy", shared by the
 * dashboard count, the discrepancy report and the reconciliation endpoints — so the number on the dashboard
 * can never disagree with the list behind it.
 *
 * Resolution is DERIVED (counts are immutable): matched · adjusted (adjustment committed directly, or its
 * approval was granted) · pending_approval · rejected (approval refused/cancelled) · unresolved (variance
 * recorded, no adjustment requested). A discrepancy is OPEN when it is the LATEST count for that item and its
 * resolution is pending_approval, rejected or unresolved — a later matching recount (or adjustment) closes it.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';

export const countsResolved = (orgId: string) => sql`
  select c.*,
    case when c.variance = 0 then 'matched'
         when c.adjustment_transaction_id is not null then 'adjusted'
         when pa.status = 'approved' then 'adjusted'
         when pa.status = 'pending' then 'pending_approval'
         when pa.status in ('rejected', 'cancelled') then 'rejected'
         else 'unresolved' end as resolution,
    (row_number() over (partition by c.item_id order by c.created_at desc, c.id desc) = 1) as is_latest,
    case when c.adjustment_transaction_id is not null then c.counted_by when pa.status = 'approved' then pa.reviewed_by else null end as resolved_by
  from reconciliation_counts c
  left join pending_approvals pa on pa.id = c.pending_approval_id
  where c.org_id = ${orgId}`;

export const isOpen = sql`(rc.is_latest and rc.resolution in ('pending_approval', 'rejected', 'unresolved'))`;

export async function openDiscrepancyCount(db: Db, orgId: string): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from (${countsResolved(orgId)}) rc where ${isOpen}`);
  return ((Array.isArray(r) ? r : (r as unknown as { rows: Array<{ n: number }> }).rows)[0] as { n: number }).n;
}
