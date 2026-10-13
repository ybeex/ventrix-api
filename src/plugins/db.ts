import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { db, closeDb, type Db } from '../db/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

export default fp(async function dbPlugin(app: FastifyInstance) {
  app.decorate('db', db);
  app.addHook('onClose', async () => {
    await closeDb();
  });
});
