// Demo seeding. Registers the three fixture sources, collects their baseline
// batches, waits for detection, and leaves the candidate mappings as drafts for
// the operator to approve on the page. Seeding never auto-approves: approval is
// the decision point the demo is about.
import { collectBatch } from './collect.js';
import { ingestIfMapped } from './ingest.js';

const SOURCES = [
  { id: 'northwind', label: 'Northwind Supply', kind: 'json', contact: 'ops@northwind.example' },
  { id: 'acme', label: 'Acme Industrial', kind: 'json', contact: 'billing@acme.example' },
  { id: 'globex', label: 'Globex Distribution', kind: 'json', contact: 'edi@globex.example' },
];

const BASELINE = {
  northwind: 'nw-2026-11-a',
  acme: 'acme-inv-7781',
  globex: 'gx-orders-551',
};

export async function seedDemo(app, { root = null } = {}) {
  const { store, supervisor, registry } = app;
  if (store.getSetting('seeded_at')) return false;
  const fixtureUrl = store.getSetting('fixture_url', 'http://127.0.0.1:4100');
  for (const def of SOURCES) {
    registry.register({ ...def, base_url: `${fixtureUrl}/pack?source=${def.id}` });
  }
  for (const [id, batch] of Object.entries(BASELINE)) {
    const source = store.getSource(id);
    try {
      const collected = await collectBatch(store, root ?? process.cwd(), source, { batch });
      if (collected?.package) {
        ingestIfMapped(store, collected.package);
        supervisor.requestDetection(store.getPackage(collected.package.id));
      }
    } catch (e) {
      store.event('seed.error', { sourceId: id, message: `Could not collect ${batch}: ${e.message}` });
    }
  }
  await supervisor.drain(20000);
  store.setSetting('seeded_at', new Date().toISOString());
  return true;
}
