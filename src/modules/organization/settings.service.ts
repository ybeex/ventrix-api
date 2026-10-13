import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { organizationSettings, approvalPolicies } from '../../db/schema.js';
import type { Cache } from '../../lib/resilience/cache.js';

export interface OrgSettings {
  reconciliationRequireReason: boolean;
  staffCanManageItems: boolean;
  requirePhotoFor: string[];
  notificationEmailTypes: string[];
  dueSoonHours: number;
  nearMinimumPercent: number;
  supervisorsCanInvite: boolean;
}

const CACHE_TTL = 30;
const key = (orgId: string) => `org-settings:${orgId}`;

export async function getSettings(db: Db, orgId: string, cache?: Cache): Promise<OrgSettings> {
  if (cache) {
    const hit = await cache.get(key(orgId));
    if (hit) return JSON.parse(hit) as OrgSettings;
  }
  const [row] = await db.select().from(organizationSettings).where(eq(organizationSettings.orgId, orgId)).limit(1);
  const settings: OrgSettings = row
    ? {
        reconciliationRequireReason: row.reconciliationRequireReason, staffCanManageItems: row.staffCanManageItems,
        requirePhotoFor: row.requirePhotoFor, notificationEmailTypes: row.notificationEmailTypes, dueSoonHours: row.dueSoonHours,
        nearMinimumPercent: row.nearMinimumPercent, supervisorsCanInvite: row.supervisorsCanInvite,
      }
    : { reconciliationRequireReason: true, staffCanManageItems: false, requirePhotoFor: [], notificationEmailTypes: ['approval_pending', 'overdue_checkout'], dueSoonHours: 24, nearMinimumPercent: 10, supervisorsCanInvite: true };
  if (cache) await cache.set(key(orgId), JSON.stringify(settings), CACHE_TTL);
  return settings;
}

export async function invalidateSettings(cache: Cache, orgId: string): Promise<void> {
  await cache.del(key(orgId));
}

export async function getPolicy(db: Db, orgId: string) {
  const [row] = await db.select().from(approvalPolicies).where(eq(approvalPolicies.orgId, orgId)).limit(1);
  return row ?? {
    orgId, adjustmentMode: 'staff_approval' as const, lossMode: 'staff_approval' as const, retirementMode: 'staff_approval' as const,
    checkoutMode: 'direct' as const, checkinMode: 'direct' as const, largeAdjustmentThreshold: null as number | null,
    updatedAt: new Date(), updatedBy: null as string | null,
  };
}
