import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { approvalPolicies, organizations, organizationSettings } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { isValidTimezone } from '../../lib/time.js';
import type { Cache } from '../../lib/resilience/cache.js';
import { invalidateSettings } from './settings.service.js';

export async function getOrganization(db: Db, orgId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new NotFoundError('Organization');
  return org;
}

export async function updateOrganization(db: Db, actor: Actor, patch: { name?: string; timezone?: string }) {
  if (patch.timezone && !isValidTimezone(patch.timezone)) throw new UnprocessableError('INVALID_TIMEZONE', 'Unknown IANA time zone');
  return db.transaction(async (tx) => {
    const before = await getOrganization(tx, actor.orgId);
    const [after] = await tx.update(organizations).set({ ...(patch.name ? { name: patch.name.trim() } : {}), ...(patch.timezone ? { timezone: patch.timezone } : {}) })
      .where(eq(organizations.id, actor.orgId)).returning();
    await audit(tx, actor, { action: 'org.updated', entityType: 'organization', entityId: actor.orgId, previous: { name: before.name, timezone: before.timezone }, next: { name: after.name, timezone: after.timezone } });
    return after;
  });
}

type SettingsPatch = Partial<Pick<typeof organizationSettings.$inferInsert,
  'reconciliationRequireReason' | 'staffCanManageItems' | 'requirePhotoFor' | 'notificationEmailTypes' | 'dueSoonHours' | 'nearMinimumPercent' | 'supervisorsCanInvite'>>;

export async function updateSettings(db: Db, cache: Cache, actor: Actor, patch: SettingsPatch) {
  const result = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(organizationSettings).where(eq(organizationSettings.orgId, actor.orgId)).limit(1);
    const [after] = await tx.update(organizationSettings).set({ ...patch, updatedAt: new Date() }).where(eq(organizationSettings.orgId, actor.orgId)).returning();
    await audit(tx, actor, { action: 'settings.updated', entityType: 'organization_settings', entityId: actor.orgId, previous: before, next: after });
    return after;
  });
  await invalidateSettings(cache, actor.orgId);
  return result;
}

type PolicyPatch = Partial<Pick<typeof approvalPolicies.$inferInsert,
  'adjustmentMode' | 'lossMode' | 'retirementMode' | 'checkoutMode' | 'checkinMode' | 'largeAdjustmentThreshold'>>;

export async function updatePolicy(db: Db, actor: Actor, patch: PolicyPatch) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(approvalPolicies).where(eq(approvalPolicies.orgId, actor.orgId)).limit(1);
    const [after] = await tx.update(approvalPolicies).set({ ...patch, updatedAt: new Date(), updatedBy: actor.id }).where(eq(approvalPolicies.orgId, actor.orgId)).returning();
    await audit(tx, actor, { action: 'policy.updated', entityType: 'approval_policy', entityId: actor.orgId, previous: before, next: after });
    return after;
  });
}
