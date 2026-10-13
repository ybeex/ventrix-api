/** Writes docs/openapi.json from the LIVE route schemas (so it can never drift from the implementation). */
import { mkdirSync, writeFileSync } from 'node:fs';
process.env.NODE_ENV ??= 'development';
const { buildApp } = await import('../src/app.js');
const app = await buildApp();
await app.ready();
const spec = app.swagger();
mkdirSync('docs', { recursive: true });
writeFileSync('docs/openapi.json', JSON.stringify(spec, null, 2) + '\n');
console.log(`openapi: ${Object.keys(spec.paths ?? {}).length} paths -> docs/openapi.json`);
await app.close();
process.exit(0);
