import { buildApp } from './app.js';
import { env } from './env.js';

const app = await buildApp();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down: draining in-flight requests');
  // Hard stop if draining hangs, so the orchestrator can replace us.
  setTimeout(() => process.exit(1), 25_000).unref();
  try { await app.close(); process.exit(0); } catch (err) { app.log.error({ err }, 'error during shutdown'); process.exit(1); }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
// A rejected promise nobody awaited means we are in an unknown state: log it and let the orchestrator restart us cleanly.
process.on('unhandledRejection', (err) => { app.log.fatal({ err }, 'unhandled rejection'); void shutdown('unhandledRejection'); });

await app.listen({ port: env.PORT, host: env.HOST });
