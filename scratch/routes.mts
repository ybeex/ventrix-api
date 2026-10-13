import { makeApp } from '../test/helpers.js';
import { registeredRoutes } from '../src/plugins/access.js';
const app = await makeApp();
const seen = new Set<string>();
for (const r of registeredRoutes) { if (['HEAD','OPTIONS','GET'].includes(r.method)) continue; const k=`${r.method} ${r.url}`; if(!seen.has(k)){seen.add(k); console.log(k, r.permission);} }
await app.close(); process.exit(0);
