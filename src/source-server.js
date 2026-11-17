// Local fixture source server. Three suppliers whose payloads evolve: each has a
// "stable" batch and at least one "changed" batch with new or altered types.
// The point is to exercise ingestion, not to imitate a real supplier API.
//
//   GET /pack?batch=<name>   returns the JSON package for that batch
//   GET /batches             lists available batch names
//
// Money is deliberately inconsistent between sources: numbers, "1,234.50 USD",
// "$4.00", split arrays, single-element arrays, nested order structure.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function loadFixtures() {
  const file = join(here, '..', 'fixtures', 'batches.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function createSourceServer({ port = 0, fixtures = loadFixtures() } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    if (url.pathname === '/batches') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Object.entries(fixtures.by_source).map(([id, list]) => ({ source_id: id, batches: list.map((b) => b.name) }))));
      return;
    }
    if (url.pathname === '/pack' || url.pathname === '/') {
      const batch = url.searchParams.get('batch');
      const sourceId = url.searchParams.get('source');
      const lookup = (batches) => batches.find((b) => b.name === batch);
      let found = null;
      if (sourceId) {
        const list = fixtures.by_source[sourceId];
        found = list ? lookup(list) : null;
      } else {
        for (const list of Object.values(fixtures.by_source)) {
          found = lookup(list);
          if (found) break;
        }
      }
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `unknown batch ${batch}` }));
        return;
      }
      const body = JSON.stringify(found.body, null, 2);
      res.writeHead(200, { 'content-type': 'application/json', 'x-fixture-batch': batch, 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('source-server.js')) {
  const port = Number(process.env.FIXTURE_PORT ?? 4100);
  const s = await createSourceServer({ port });
  console.log(`fixture sources on ${s.url}`);
}
