/**
 * Background worker process (BullMQ). Run separately from the API so heavy or slow work never competes with request
 * latency and can be scaled independently:   node dist/src/worker.js
 *
 *   imports      CSV commits too large for a request
 *   maintenance  repeatable jobs: outbox e-mail dispatch (10s), domain-event fan-out (5s), overdue scan (15m), shelf cycle-count reminders (hourly),
 *                housekeeping (hourly), ledger integrity audit (6h)
 *
 * Every job is idempotent and safe to run on several workers at once (SKIP LOCKED claims, dedupe keys, per-row
 * keys), so scaling out or a retry after a crash can never double-process anything.
 */
import { Worker, Queue, type Job } from 'bullmq';
import { pathToFileURL } from 'node:url';
import { db, closeDb } from './db/index.js';
import { newBullConnection, PREFIX } from './lib/queue.js';
import { metrics } from './lib/metrics.js';
import { shutdownBreakers } from './lib/resilience/circuit.js';
import { loadActor, runCommit } from './modules/imports/service.js';
import { auditIntegrity, purgeExpired } from './modules/maintenance/jobs.js';
import { dispatchDueEmails } from './modules/mail/outbox.js';
import { processDomainEvents, scanCycleCounts, scanOverdue } from './modules/notifications/service.js';

export const SCHEDULES: Record<string, { every: number }> = {
  email: { every: 10_000 }, events: { every: 5_000 }, overdue: { every: 15 * 60_000 }, cycle: { every: 60 * 60_000 }, purge: { every: 60 * 60_000 }, integrity: { every: 6 * 60 * 60_000 },
};

export async function runMaintenanceJob(name: string): Promise<unknown> {
  switch (name) {
    case 'email': return dispatchDueEmails(db);
    case 'events': return processDomainEvents(db);
    case 'overdue': return scanOverdue(db);
    case 'cycle': return scanCycleCounts(db);
    case 'purge': return purgeExpired(db);
    case 'integrity': return auditIntegrity(db);
    default: throw new Error(`Unknown maintenance job ${name}`);
  }
}

export async function runImportJob(data: { importId: string; orgId: string; userId: string }) {
  return runCommit(db, await loadActor(db, data.orgId, data.userId), data.importId);
}

export async function startWorkers(opts: { schedule?: boolean } = {}) {
  // BullMQ does not close connections it is handed, so every one is tracked and disconnected on close() (else the process hangs on shutdown).
  const conns = [newBullConnection(), newBullConnection(), newBullConnection()];
  const [maintConn, importConn, queueConn] = conns;
  const maintenance = new Queue('maintenance', { connection: queueConn, prefix: PREFIX });
  if (opts.schedule !== false) {
    for (const [name, s] of Object.entries(SCHEDULES)) {
      // upsertJobScheduler is idempotent: N workers starting up produce ONE schedule, not N.
      await maintenance.upsertJobScheduler(`sched:${name}`, { every: s.every }, { name, opts: { removeOnComplete: 50, removeOnFail: 200 } });
    }
  }
  const track = (job: string) => ({ ok: () => metrics.jobs.inc({ job, outcome: 'ok' }), fail: () => metrics.jobs.inc({ job, outcome: 'failed' }) });
  const maint = new Worker('maintenance', async (job: Job) => { const t = track(job.name); try { const r = await runMaintenanceJob(job.name); t.ok(); return r as never; } catch (e) { t.fail(); throw e; } }, { connection: maintConn, prefix: PREFIX, concurrency: 3 });
  const imports = new Worker('imports', async (job: Job) => { const t = track('import'); try { const r = await runImportJob(job.data); t.ok(); return r; } catch (e) { t.fail(); throw e; } }, { connection: importConn, prefix: PREFIX, concurrency: 2 });
  for (const w of [maint, imports]) w.on('failed', (job, err) => console.error(JSON.stringify({ level: 'error', msg: 'job failed', queue: w.name, job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message })));
  return {
    async close() { await Promise.all([maint.close(), imports.close(), maintenance.close()]); for (const c of conns) c.disconnect(); shutdownBreakers(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const w = await startWorkers();
  console.log(JSON.stringify({ level: 'info', msg: 'worker started', queues: ['imports', 'maintenance'] }));
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return; stopping = true;
    console.log(JSON.stringify({ level: 'info', msg: 'worker stopping', sig }));
    setTimeout(() => process.exit(1), 25_000).unref();
    await w.close(); await closeDb(); process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}
