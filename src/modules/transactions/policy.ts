import type { Db } from '../../db/index.js';
import type { Actor } from '../../lib/actor.js';
import { modeRequiresApproval, type ApprovalMode } from '../approvals/store.js';
import { getPolicy } from '../organization/settings.service.js';

export type GatedOp = 'adjustment' | 'loss' | 'retirement' | 'checkout' | 'checkin';

/** Does THIS actor have to ask for approval for THIS operation under the org's current policy? */
export async function approvalRequired(tx: Db, actor: Actor, op: GatedOp, magnitude = 0): Promise<boolean> {
  const p = await getPolicy(tx, actor.orgId);
  let mode: ApprovalMode = ({
    adjustment: p.adjustmentMode, loss: p.lossMode, retirement: p.retirementMode, checkout: p.checkoutMode, checkin: p.checkinMode,
  } satisfies Record<GatedOp, ApprovalMode>)[op];
  // PRD §32 "large stock adjustments": at or above the threshold, everyone but an admin needs approval, whatever the base mode says.
  if (op === 'adjustment' && p.largeAdjustmentThreshold !== null && magnitude >= p.largeAdjustmentThreshold) mode = 'all_approval';
  return modeRequiresApproval(mode, actor.role);
}
