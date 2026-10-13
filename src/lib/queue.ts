/**
 * BullMQ queues (Redis). Used for work that must not run inside a request: large CSV imports, e-mail dispatch,
 * the overdue scan, event fan-out, maintenance. The API process only ENQUEUES (through a circuit breaker — an
 * unreachable Redis becomes a clean 503, never a hung request); the worker process (src/worker.ts) consumes.
 * BullMQ requires its own connection with maxRetriesPerRequest=null; it is never shared with the cache connection.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../env.js';
import { createBreaker } from './resilience/circuit.js';

export const PREFIX = 'sk';
export type QueueName = 'imports' | 'maintenance';

let connection: Redis | null = null;
const queues = new Map<QueueName, Queue>();

export const newBullConnection = () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export function getQueue(name: QueueName): Queue {
  connection ??= newBullConnection();
  let q = queues.get(name);
  if (!q) { q = new Queue(name, { connection, prefix: PREFIX }); queues.set(name, q); }
  return q;
}

export const enqueue = createBreaker('queue', async (name: QueueName, job: string, data: Record<string, unknown>, jobId: string) => {
  await getQueue(name).add(job, data, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 });
}, { timeoutMs: 3000 });

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  connection?.disconnect();
  connection = null;
}
