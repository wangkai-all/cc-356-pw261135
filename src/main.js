// Entry point: boots the collector API and the operator console on one port.
//
//   node src/server.js            # API on :4200, fixture sources on :4100
//   PORT=4300 node src/server.js
//   FIXTURE_PORT=0 node src/server.js   # random port for tests
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.js';
import { createSourceServer } from './source-server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 4200);
const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 4100);

const fixtures = await createSourceServer({ port: FIXTURE_PORT });
const app = createApp({ root: ROOT, fixtureUrl: fixtures.url });

app.store.setSetting('fixture_url', fixtures.url);
await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));

// A restart mid-detection must not wedge packages: sweep orphaned jobs once.
const recovered = app.api.sweep();
if (recovered.length) console.log(`recovered ${recovered.length} orphaned detection job(s)`);

console.log(`sources:       ${fixtures.url}/pack?batch=nw-2026-11-a`);
console.log(`contract gate: http://127.0.0.1:${PORT}/`);
if (process.env.SEED_ON_START !== '0') {
  const { seedDemo } = await import('./seed.js');
  const seeded = await seedDemo(app.api);
  if (seeded) console.log('seeded demo sources and baseline mappings');
}
