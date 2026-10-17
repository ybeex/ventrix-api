/**
 * The module registry. Each bounded module exposes one Fastify plugin that registers its routes;
 * modules talk to each other only through their exported service functions and through domain
 * events (lib/events.ts). Adding a module = one line here.
 */
import type { FastifyInstance } from 'fastify';
import authRoutes from './identity/auth.routes.js';
import usersRoutes from './identity/users.routes.js';
import organizationRoutes from './organization/routes.js';
import locationRoutes from './locations/routes.js';
import holderRoutes from './holders/routes.js';
import jobRoutes from './jobs/routes.js';
import shelfRoutes from './shelves/routes.js';
import categoryRoutes from './categories/routes.js';
import fileRoutes from './files/routes.js';
import itemRoutes from './items/routes.js';
import transactionRoutes from './transactions/routes.js';
import approvalRoutes from './approvals/routes.js';
import operationsRoutes from './operations/routes.js';
import activityRoutes from './activity/routes.js';
import reportRoutes from './reports/routes.js';
import reconciliationRoutes from './reconciliation/routes.js';
import importRoutes from './imports/routes.js';
import syncRoutes from './sync/routes.js';
import notificationRoutes from './notifications/routes.js';
import announcementRoutes from './notifications/announcements.routes.js';
import mailWebhookRoutes from './mail/webhook.routes.js';

export async function registerModules(app: FastifyInstance): Promise<void> {
  await app.register(async (v1) => {
    await v1.register(authRoutes);
    await v1.register(usersRoutes);
    await v1.register(organizationRoutes);
    await v1.register(locationRoutes);
    await v1.register(holderRoutes);
    await v1.register(jobRoutes);
    await v1.register(shelfRoutes);
    await v1.register(categoryRoutes);
    await v1.register(fileRoutes);
    await v1.register(itemRoutes);
    await v1.register(transactionRoutes);
    await v1.register(approvalRoutes);
    await v1.register(operationsRoutes);
    await v1.register(activityRoutes);
    await v1.register(reportRoutes);
    await v1.register(reconciliationRoutes);
    await v1.register(importRoutes);
    await v1.register(syncRoutes);
    await v1.register(notificationRoutes);
    await v1.register(announcementRoutes);
    await v1.register(mailWebhookRoutes);
  }, { prefix: '/v1' });
}
