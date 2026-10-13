/**
 * The single source of truth for who may do what (PRD §31). Routes declare a permission
 * name — never a role list — in `config.permission`; the access plugin enforces it for
 * every route and REFUSES TO BOOT if a route declares nothing (fail closed).
 *
 * PRD §31 read strictly, with the decisions recorded during PRD review:
 *   Admin       everything (also a superset of Store Staff operations).
 *   Supervisor  view, approve adjustments, reconcile, reports — and issue/return items (field supervisors cover for the storekeeper).
 *   Store Staff search/scan/check-out/in/consume/restock/photos; adjustments & loss/damage are policy-gated; item management only if the org enables it.
 *   Viewer      read-only.
 */
import type { Role } from './actor.js';

const ALL: readonly Role[] = ['admin', 'supervisor', 'store_staff', 'viewer'];
const OPERATORS: readonly Role[] = ['admin', 'supervisor', 'store_staff'];
const REVIEWERS: readonly Role[] = ['admin', 'supervisor'];
const ADMIN: readonly Role[] = ['admin'];

export const PERMISSIONS = {
  'session:own': ALL, // logout, /me, PIN management for oneself
  'org:read': ALL,
  'org:manage': ADMIN,
  'policy:manage': ADMIN,
  'users:manage': ADMIN,
  'users:invite': REVIEWERS, // admins invite any role; supervisors only store staff & viewers (and only if the org allows it) — see identity/users.service
  'announcements:read': ALL,
  'announcements:manage': ADMIN,
  'locations:read': ALL,
  'locations:manage': ADMIN,
  'holders:read': ALL,
  'holders:write': OPERATORS, // person holders; other kinds are admin-only (checked in the service)
  'jobs:read': ALL,
  'jobs:manage': REVIEWERS,
  'shelves:read': ALL,
  'shelves:manage': ADMIN,
  'categories:read': ALL,
  'categories:manage': ADMIN,
  'items:read': ALL,
  'items:write': ADMIN, // + store_staff when organization_settings.staff_can_manage_items
  'items:archive': ADMIN,
  'files:read': ALL,
  'files:write': OPERATORS,
  'tx:read': ALL,
  'tx:issue': OPERATORS, // checkout, check-in, consume, restock
  'tx:adjust': OPERATORS, // adjustments / loss / damage / condition — approval policy decides who commits
  'tx:override': REVIEWERS, // exceed-stock checkout, over-return
  'tx:correct': ADMIN,
  'approvals:read': OPERATORS, // store_staff see only their own requests (service-enforced)
  'approvals:review': REVIEWERS,
  'reconciliation:read': ALL,
  'reconciliation:run': REVIEWERS,
  'imports:run': ADMIN, // + store_staff when staff_can_manage_items
  'sync:push': OPERATORS,
  'sync:read': ALL,
  'sync:resolve': REVIEWERS,
  'ops:read': ALL, // outstanding / overdue / low-stock / dashboard
  'activity:read': REVIEWERS,
  'reports:read': REVIEWERS,
  'notifications:own': ALL,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Permissions a store_staff user additionally holds when the org turns the named setting on. */
export const STAFF_GATED: Partial<Record<Permission, 'staffCanManageItems'>> = {
  'items:write': 'staffCanManageItems',
  'imports:run': 'staffCanManageItems',
};

export function roleHas(role: Role, permission: Permission, settings?: { staffCanManageItems: boolean }): boolean {
  if ((PERMISSIONS[permission] as readonly Role[]).includes(role)) return true;
  const gate = STAFF_GATED[permission];
  return role === 'store_staff' && !!gate && !!settings?.[gate];
}

export const needsSettings = (permission: Permission): boolean => permission in STAFF_GATED;
