#!/usr/bin/env node
// Smoke test for a running instance. Exercises the operator paths end to end and
// prints one line per check, so `npm run smoke` answers "is this build healthy
// and does the demo still work?" without opening the page.
//
//   node src/main.js &            # or PORT=4300 npm start
//   BASE=http://127.0.0.1:4300 npm run smoke
//
// It is additive: it registers a source named `smoke_<timestamp>`, collects the
// northwind baseline and a changed batch, approves a mapping, and checks the
// results. It never deletes or mutates other sources' data.
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4200';
const SOURCE = `smoke_${Date.now().toString(36)}`;
let failures = 0;

async function api(path, { method = 'GET', body, expectStatus = 200 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== expectStatus) {
    throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${data.error ?? ''} ${data.message ?? ''}`), { data });
  }
  return data;
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

async function waitJob(packageId) {
  for (let i = 0; i < 300; i++) {
    const detail = await api(`/api/packages/${packageId}`);
    if (detail.job && ['done', 'crashed', 'failed'].includes(detail.job.status)) return detail;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`detection for ${packageId} did not finish`);
}

await check('the server is healthy and the contract is published', async () => {
  const health = await api('/api/health');
  assert.equal(health.ok, true);
  const contract = await api('/api/contract');
  assert.ok(contract.fields.some((f) => f.name === 'quantity' && f.type === 'integer'));
});

await check('the fixture sources are reachable through the app', async () => {
  const batches = await api('/api/batches');
  const names = batches.flatMap((s) => s.batches);
  for (const batch of ['nw-2026-11-a', 'nw-2026-11-b', 'gx-orders-552', 'acme-inv-7802']) {
    assert.ok(names.includes(batch), `${batch} is served`);
  }
});

const source = await api('/api/sources', {
  method: 'POST',
  body: { id: SOURCE, label: 'Smoke source', base_url: (await api('/api/state')).setting_fixture_url + '/pack?source=northwind' },
}).then((r) => r.source);

await check('an unmapped source waits instead of guessing', async () => {
  const r = await api('/api/collect', { method: 'POST', body: { source_id: SOURCE, batch: 'nw-2026-11-a' } });
  assert.equal(r.ingest.status, 'awaiting_mapping');
  const detail = await waitJob(r.package.id);
  assert.equal(detail.candidates[0].ok, true);
});

await check('approval lands the baseline with canonical values', async () => {
  const pkg = (await api('/api/state')).sources.find((s) => s.id === SOURCE).packages.find((p) => p.batch_name === 'nw-2026-11-a');
  const detail = await api(`/api/packages/${pkg.id}`);
  const drafted = await api('/api/mappings/draft', { method: 'POST', body: { package_id: pkg.id, candidate: detail.best } });
  const approved = await api(`/api/mappings/${drafted.mapping.id}/approve`, { method: 'POST', body: { by: 'smoke' } });
  const run = await api(`/api/runs/${approved.applied[0].runId}`);
  assert.equal(run.run.status, 'ok');
  assert.deepEqual(
    run.lines.map((l) => [l.quantity, l.unit_price, l.currency]),
    [[4, '12.50', 'USD'], [100, '0.35', 'USD'], [12, '2.25', 'USD']],
  );
});

await check('new types degrade per field with named losses', async () => {
  const r = await api('/api/collect', { method: 'POST', body: { source_id: SOURCE, batch: 'nw-2026-11-b' } });
  assert.equal(r.ingest.status, 'partial');
  const run = await api(`/api/runs/${r.ingest.runId}`);
  const nw4 = run.lines.find((l) => l.line_id === 'NW-4');
  assert.equal(nw4.quantity, null);
  assert.ok(nw4.losses.some((l) => l.field === 'quantity' && l.kind === 'type_mismatch'));
});

await check('a new mapping version supersedes and repairs the package', async () => {
  const pkg = (await api('/api/state')).sources.find((s) => s.id === SOURCE).packages.find((p) => p.batch_name === 'nw-2026-11-b');
  const detail = await waitJob(pkg.id);
  const candidate = detail.candidates.find((c) => c.ok);
  const drafted = await api('/api/mappings/draft', { method: 'POST', body: { package_id: pkg.id, candidate: candidate.index } });
  const approved = await api(`/api/mappings/${drafted.mapping.id}/approve`, { method: 'POST', body: { by: 'smoke' } });
  const applied = approved.applied.find((a) => a.batch === 'nw-2026-11-b');
  assert.equal(applied.status, 'ok');
  const state = await api('/api/state');
  assert.equal(state.sources.find((s) => s.id === SOURCE).current_mapping, drafted.mapping.id);
  assert.ok(state.mappings.some((m) => m.source_id === SOURCE && m.status === 'superseded'));
});

await check('replay reads stored bytes and appends a run', async () => {
  const pkg = (await api('/api/state')).sources.find((s) => s.id === SOURCE).packages.find((p) => p.batch_name === 'nw-2026-11-b');
  const before = await api(`/api/packages/${pkg.id}`);
  const replay = await api('/api/ingest/replay', { method: 'POST', body: { package_id: pkg.id, reason: 'smoke' } });
  const after = await api(`/api/packages/${pkg.id}`);
  assert.equal(replay.status, 'ok');
  assert.equal(after.runs.length, before.runs.length + 1);
  assert.equal(after.package.sha256, before.package.sha256);
});

await check('a crash is visible, retryable and bounded', async () => {
  const pkg = (await api('/api/state')).sources.find((s) => s.id === SOURCE).packages.find((p) => p.batch_name === 'nw-2026-11-a');
  await api('/api/detect', { method: 'POST', body: { package_id: pkg.id, crash_after: 1 } });
  let detail;
  for (let i = 0; i < 200; i++) {
    detail = await api(`/api/packages/${pkg.id}`);
    if (detail.job.status === 'crashed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(detail.job.status, 'crashed');
  assert.match(detail.job.error, /SIGKILL|killed/);
  const retried = await api(`/api/jobs/${detail.job.id}/retry`, { method: 'POST', body: {} });
  assert.equal(retried.job.status, 'queued');
  const done = await waitJob(pkg.id);
  assert.equal(done.job.status, 'done');
});

await check('revocation is immediate and leaves the source unmapped', async () => {
  const current = (await api('/api/state')).sources.find((s) => s.id === SOURCE).current_mapping;
  const revoked = await api(`/api/mappings/${current}/revoke`, { method: 'POST', body: { reason: 'smoke' } });
  assert.equal(revoked.current, null);
  const r = await api('/api/collect', { method: 'POST', body: { source_id: SOURCE, batch: 'nw-2026-11-a' } });
  assert.equal(r.ingest.status, 'awaiting_mapping');
});

await check('the console is served', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>/);
  assert.match(html, /app\.js/);
  const js = await fetch(BASE + '/app.js');
  assert.equal(js.status, 200);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
