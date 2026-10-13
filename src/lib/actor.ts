import type { FastifyRequest } from 'fastify';

export type Role = 'admin' | 'supervisor' | 'store_staff' | 'viewer';

/** Who is performing an operation, plus the request metadata every audit row needs. Passed explicitly to services. */
export interface Actor {
  id: string;
  orgId: string;
  role: Role;
  requestId?: string;
  ip?: string;
  deviceId?: string | null;
}

export function actorOf(req: FastifyRequest): Actor {
  const u = req.user!;
  return { id: u.id, orgId: u.orgId, role: u.role, deviceId: u.deviceId, requestId: req.id, ip: req.ip };
}
