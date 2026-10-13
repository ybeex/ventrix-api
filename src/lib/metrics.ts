/**
 * Prometheus metrics — PRD §39 / §55 asks for transaction failure rate, sync failure
 * rate, conflict rate, duplicate (replayed) transaction rate, discrepancy rate and
 * authentication failures to be monitorable. They are plain counters here; the rates
 * are computed by the monitoring system (e.g. rate(failed)/rate(total)).
 */
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const reg = [registry];

export const metrics = {
  httpDuration: new client.Histogram({
    name: 'http_request_duration_seconds', help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: reg,
  }),
  transactions: new client.Counter({
    name: 'storekeeper_transactions_total', help: 'Ledger operations by type and outcome',
    labelNames: ['type', 'outcome'] as const, registers: reg, // outcome: committed | replayed | deferred | conflict | rejected
  }),
  syncActions: new client.Counter({
    name: 'storekeeper_sync_actions_total', help: 'Offline-queued actions by outcome',
    labelNames: ['outcome'] as const, registers: reg, // applied | replayed | conflict | rejected
  }),
  authFailures: new client.Counter({
    name: 'storekeeper_auth_failures_total', help: 'Authentication failures by reason',
    labelNames: ['reason'] as const, registers: reg,
  }),
  discrepancies: new client.Counter({
    name: 'storekeeper_reconciliation_discrepancies_total', help: 'Reconciliation counts with non-zero variance',
    registers: reg,
  }),
  reconciliationCounts: new client.Counter({
    name: 'storekeeper_reconciliation_counts_total', help: 'All reconciliation counts recorded', registers: reg,
  }),
  breakerState: new client.Gauge({
    name: 'circuit_breaker_state', help: '0=closed 1=half-open 2=open',
    labelNames: ['name'] as const, registers: reg,
  }),
  breakerEvents: new client.Counter({
    name: 'circuit_breaker_events_total', help: 'Circuit breaker events',
    labelNames: ['name', 'event'] as const, registers: reg,
  }),
  jobs: new client.Counter({
    name: 'storekeeper_jobs_total', help: 'Background job runs',
    labelNames: ['job', 'outcome'] as const, registers: reg,
  }),
  integrityViolations: new client.Gauge({
    name: 'storekeeper_integrity_violations', help: 'Ledger integrity violations found by the last audit (should be 0)', registers: reg,
  }),
  emails: new client.Counter({
    name: 'storekeeper_emails_total', help: 'Outbound emails by outcome',
    labelNames: ['outcome'] as const, registers: reg,
  }),
};
