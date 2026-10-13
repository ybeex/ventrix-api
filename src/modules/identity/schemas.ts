import { Type } from '@sinclair/typebox';
import { Email, Nullable, Obj, Password, Uuid, IsoDate } from '../../lib/strict.js';

export const RoleSchema = Type.Union([Type.Literal('admin'), Type.Literal('supervisor'), Type.Literal('store_staff'), Type.Literal('viewer')]);
export const OrgSlug = Type.String({ minLength: 2, maxLength: 60, pattern: '^[A-Za-z0-9-]+$' });

export const SessionResponse = Obj({
  token: Type.String(), expiresAt: IsoDate,
  user: Obj({ id: Uuid, email: Type.String(), role: RoleSchema, orgId: Uuid }),
});

export const UserView = Obj({
  id: Uuid, email: Type.String(), role: RoleSchema, active: Type.Boolean(),
  hasPassword: Type.Boolean(), hasPin: Type.Boolean(), name: Nullable(Type.String()),
  lastLoginAt: Nullable(IsoDate), createdAt: IsoDate,
});

export { Email, Password };
