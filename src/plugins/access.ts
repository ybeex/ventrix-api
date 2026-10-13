/**
 * Fail-closed access control for the whole API.
 *
 * Every route MUST declare either `config: { public: true }` or `config: { permission: '<name>' }`.
 * This plugin hooks route registration (`onRoute`): a route that declares neither makes the
 * application throw at BOOT — it can never be deployed "by accident open". For protected routes it
 * installs, in `onRequest` (before body parsing/validation):
 *     1. authenticate   → 401 if the bearer session is missing/invalid/expired/deactivated
 *     2. permission     → 403 if the caller's role lacks the permission (PRD §31)
 * so individual route files cannot forget auth, and cannot get the order wrong.
 *
 * test/access-coverage.test.ts additionally enumerates every registered route and asserts the matrix.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ForbiddenError } from '../lib/errors.js';
import { auditSafe } from '../lib/audit.js';
import { PERMISSIONS, needsSettings, roleHas, type Permission } from '../lib/permissions.js';
import { getSettings } from '../modules/organization/settings.service.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
    permission?: Permission;
  }
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Swagger UI registers its own asset routes in non-production. */
const isDocsRoute = (url: string) => url === '/docs' || url.startsWith('/docs/');

export const registeredRoutes: Array<{ method: string; url: string; permission: Permission | 'public' }> = [];

export default fp(async function accessPlugin(app: FastifyInstance) {
  app.addHook('onRoute', (opts) => {
    if (isDocsRoute(opts.url)) return;
    const methods = asArray(opts.method);
    const cfg = opts.config ?? {};

    if (cfg.public) {
      for (const m of methods) registeredRoutes.push({ method: m, url: opts.url, permission: 'public' });
      return;
    }
    const permission = cfg.permission;
    if (!permission || !(permission in PERMISSIONS)) {
      throw new Error(`Route ${methods.join(',')} ${opts.url} must declare config.public or a valid config.permission`);
    }
    for (const m of methods) registeredRoutes.push({ method: m, url: opts.url, permission });

    const requirePermission = async (req: FastifyRequest) => {
      const user = req.user!;
      const settings = needsSettings(permission) ? await getSettings(app.db, user.orgId, app.cache) : undefined;
      if (!roleHas(user.role, permission, settings)) {
        // A refused attempt is itself a security event (who tried what, from where) — logged before the 403 is returned.
        await auditSafe(app.db, { orgId: user.orgId, id: user.id, requestId: req.id, ip: req.ip }, { action: 'access.denied', entityType: 'route', entityId: `${req.method} ${req.routeOptions.url}`, next: { permission, role: user.role } });
        throw new ForbiddenError('Your role does not permit this action');
      }
    };
    opts.onRequest = [app.authenticate, requirePermission, ...asArray(opts.onRequest)] as typeof opts.onRequest;
  });
});
