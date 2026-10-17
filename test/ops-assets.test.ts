/** Alert rules and the Grafana dashboard are code: they must stay valid, tested, documented, and tied to metrics the app really exports. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { registry } from '../src/lib/metrics.js';
import '../src/plugins/observability.js'; // registers nothing at import; keeps this test honest about the module graph

const RULES = 'deploy/prometheus/storekeeper.rules.yml', RULE_TESTS = 'deploy/prometheus/storekeeper.rules.test.yml', DASH = 'deploy/grafana/storekeeper-overview.json';
const rules = parse(readFileSync(RULES, 'utf8')) as { groups: Array<{ name: string; rules: Array<{ alert: string; expr: string; for?: string; labels: Record<string, string>; annotations: Record<string, string> }> }> };
const alerts = rules.groups.flatMap((g) => g.rules);
const dash = JSON.parse(readFileSync(DASH, 'utf8')) as { uid: string; panels: Array<{ id: number; title: string; targets: Array<{ expr: string }>; gridPos: { x: number; w: number } }> };
const exposed = async () => new Set([...(await registry.metrics()).matchAll(/^# HELP (\S+)/gm)].map((m) => m[1]));
const METRIC = /\b((?:storekeeper_|circuit_breaker_|http_request_duration_seconds|nodejs_|process_)[a-z0-9_]*)/g;
const base = (n: string) => n.replace(/_(count|bucket|sum)$/, '');
const exprs = (list: string[]) => list.flatMap((e) => [...e.matchAll(METRIC)].map((m) => m[1]));

test('every metric the rules and the dashboard use is really exported by the app (typos and renames fail here)', async () => {
  const have = await exposed(); const used = new Set([...exprs(alerts.map((a) => a.expr)), ...exprs(dash.panels.flatMap((p) => p.targets.map((t) => t.expr)))]);
  assert.ok(used.size >= 12, `only ${used.size} metrics referenced`);
  const missing = [...used].filter((m) => !have.has(m) && !have.has(base(m))); assert.deepEqual(missing, []);
});

test('alert rules are well-formed: unique names, severity page|warn|info, summary + description, every page-level alert has a runbook pointer', () => {
  assert.ok(alerts.length >= 14); assert.equal(new Set(alerts.map((a) => a.alert)).size, alerts.length);
  for (const a of alerts) {
    assert.ok(a.expr.trim().length > 10, a.alert); assert.ok(['page', 'warn', 'info'].includes(a.labels.severity), `${a.alert} severity`);
    assert.ok(a.annotations.summary && a.annotations.description, `${a.alert} annotations`);
    if (a.labels.severity === 'page') assert.match(a.annotations.description, /OPERATIONS\.md|Check |See |scrapeable|stalled/, `${a.alert} says what to do`);
  }
  assert.ok(alerts.some((a) => a.labels.severity === 'page' && a.alert === 'StoreKeeperIntegrityViolation'));
});

test('every alert is documented in OPERATIONS.md by name (docs cannot drift from the rules)', () => {
  const doc = readFileSync('docs/OPERATIONS.md', 'utf8'); assert.deepEqual(alerts.map((a) => a.alert).filter((n) => !doc.includes(n)), []);
});

test('rule unit tests exist for every page-level alert', () => {
  const tested = readFileSync(RULE_TESTS, 'utf8'); for (const a of alerts.filter((x) => x.labels.severity === 'page')) assert.ok(tested.includes(a.alert), `${a.alert} has no unit test`);
});

test('dashboard JSON: stable uid, unique panel ids, every panel queries something, panels fit the 24-column grid', () => {
  assert.equal(dash.uid, 'storekeeper-overview'); assert.equal(new Set(dash.panels.map((p) => p.id)).size, dash.panels.length);
  for (const p of dash.panels) { assert.ok(p.targets.length > 0 && p.targets.every((t) => t.expr.length > 5), p.title); assert.ok(p.gridPos.x + p.gridPos.w <= 24, p.title); }
});

const hasPromtool = spawnSync('promtool', ['--version']).status === 0;
test('promtool accepts the rules and their unit tests', { skip: hasPromtool ? false : 'promtool not installed (CI installs it)' }, () => {
  const c = spawnSync('promtool', ['check', 'rules', RULES], { encoding: 'utf8' }); assert.equal(c.status, 0, c.stdout + c.stderr);
  const t = spawnSync('promtool', ['test', 'rules', 'storekeeper.rules.test.yml'], { encoding: 'utf8', cwd: 'deploy/prometheus' }); assert.equal(t.status, 0, t.stdout + t.stderr);
});
