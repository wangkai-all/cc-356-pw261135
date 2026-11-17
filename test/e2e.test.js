// End-to-end tests: the real HTTP API, a real fixture source server, real
// detection worker processes, and a throwaway data root per test group. These
// are the regression tests for the behaviour the operator console demonstrates:
// contract gating, per-field degradation vs whole-source quarantine, replay from
// stored bytes, detection crashes/retries/sweep, and mapping supersede/revoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceServer, loadFixtures } from '../src/source-server.js';
import { createApp } from '../src/server.js';

const WORKER = new URL('../src/detect-worker.js', import.meta.url).pathname;

async function makeEnv({ workerPath = WORKER } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-e2e-'));
  const sourceServer = await createSourceServer({ port: 0 });
  const app = createApp({ root: dir, dbFile: join(dir, 'db.sqlite3'), fixtureUrl: sourceServer.url, workerPath });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.message ?? `HTTP ${res.status}`), {
        code: data.error,
        status: res.status,
        details: data.details,
      });
    }
    return data;
  };

  const register = (id, { fixture = id, label = id } = {}) =>
    call('/api/sources', { method: 'POST', body: { id, label, base_url: `${sourceServer.url}/pack?source=${fixture}` } });

  const collect = (source_id, batch) => call('/api/collect', { method: 'POST', body: { source_id, batch } });

  const waitFor = async (fn, { timeout = 15000, interval = 50 } = {}) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const hit = await fn();
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error('timed out');
  };

  const waitJob = (packageId, states = ['done', 'crashed', 'failed']) =>
    waitFor(async () => {
      const detail = await call(`/api/packages/${packageId}`);
      return detail.job && states.includes(detail.job.status) ? detail : null;
    });

  const packageByBatch = async (sourceId, batch, revision = null) => {
    const state = await call('/api/state');
    const source = state.sources.find((s) => s.id === sourceId);
    assert.ok(source, `source ${sourceId} is registered`);
    const pkg = source.packages.find((p) => p.batch_name === batch && (revision === null || p.revision === revision));
    assert.ok(pkg, `package ${sourceId}/${batch} exists`);
    return pkg;
  };

  const approveBest = async (packageId, by = 'test') => {
    const detail = await call(`/api/packages/${packageId}`);
    const index = detail.best ?? detail.candidates.find((c) => c.ok)?.index;
    assert.notEqual(index, undefined, 'a usable candidate is available');
    const drafted = await call('/api/mappings/draft', { method: 'POST', body: { package_id: packageId, candidate: index } });
    const approved = await call(`/api/mappings/${drafted.mapping.id}/approve`, { method: 'POST', body: { by } });
    return { drafted, approved, index };
  };

  const cleanup = async () => {
    await app.supervisor.drain(5000);
    await new Promise((r) => app.server.close(r));
    await sourceServer.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { dir, sourceServer, app, base, call, register, collect, waitFor, waitJob, packageByBatch, approveBest, cleanup };
}

const rowsOf = (run) => run.lines.map((l) => [l.line_id, l.sku, l.quantity, l.unit_price, l.currency, l.amount, l.unit]);

// ---------------------------------------------------------------------------
// The northwind story: baseline, new types, ambiguous array, packed strings,
// supersede, replay and revocation.
// ---------------------------------------------------------------------------

test('northwind: every revision is gated, degraded explicitly, and replayable', async (t) => {
  const env = await makeEnv();
  t.after(env.cleanup);
  const { call, register, collect, waitJob, approveBest, packageByBatch } = env;

  await register('northwind', { label: 'Northwind Supply' });

  let v1;
  await t.test('a source with no mapping waits, and the raw bytes are kept verbatim', async () => {
    const r = await collect('northwind', 'nw-2026-11-a');
    assert.equal(r.ingest.status, 'awaiting_mapping');
    const detail = await waitJob(r.package.id);
    assert.equal(detail.package.status, 'awaiting_mapping');
    assert.equal(detail.candidates.length, 1);
    assert.equal(detail.candidates[0].ok, true);

    const fixture = loadFixtures().by_source.northwind.find((b) => b.name === 'nw-2026-11-a');
    assert.equal(readFileSync(detail.package.raw_path, 'utf8'), JSON.stringify(fixture.body, null, 2));
    assert.match(detail.package.sha256, /^sha256:[0-9a-f]{64}$/);
  });

  await t.test('approval lands the waiting package and exposes raw next to ingested values', async () => {
    const pkg = await packageByBatch('northwind', 'nw-2026-11-a');
    v1 = await approveBest(pkg.id);
    assert.equal(v1.drafted.mapping.status, 'draft');
    assert.equal(v1.approved.mapping.status, 'approved');
    assert.equal(v1.approved.mapping.version, 1);

    const applied = v1.approved.applied.find((a) => a.batch === 'nw-2026-11-a');
    assert.equal(applied.status, 'ok');
    const run = await call(`/api/runs/${applied.runId}`);
    assert.equal(run.run.trigger, 'approval');
    assert.deepEqual(rowsOf(run), [
      ['NW-1', 'nw-1001', 4, '12.50', 'USD', '50.00', 'case'],
      ['NW-2', 'nw-1002', 100, '0.35', 'USD', '35.00', 'each'],
      ['NW-3', 'nw-1003', 12, '2.25', 'USD', '27.00', 'each'],
    ]);

    const line = run.lines[0];
    assert.equal(line.fields.unit_price.raw, 12.5);
    assert.equal(line.fields.amount.raw, 50);
    assert.deepEqual(line.fields.unit_price.origin, {
      scope: 'line',
      path: 'unit_price',
      selector: { path: 'unit_price', target: 'decimal', steps: [{ number: true }] },
      sequence: 0,
      key: '0',
    });
  });

  await t.test('replay refuses altered raw bytes, and works again once restored', async () => {
    const pkg = await packageByBatch('northwind', 'nw-2026-11-a', 1);
    const original = readFileSync(pkg.raw_path, 'utf8');
    writeFileSync(pkg.raw_path, original.replace('NW-1', 'NW-9'), 'utf8');

    const replayErr = await call('/api/ingest/replay', { method: 'POST', body: { package_id: pkg.id } }).then(
      () => null,
      (e) => e,
    );
    assert.equal(replayErr?.code, 'E_RAW_CHANGED');
    assert.equal(replayErr.status, 409);
    const planErr = await call(`/api/packages/${pkg.id}/plan`).then(
      () => null,
      (e) => e,
    );
    assert.equal(planErr?.code, 'E_RAW_CHANGED');

    writeFileSync(pkg.raw_path, original, 'utf8');
    const ok = await call('/api/ingest/replay', { method: 'POST', body: { package_id: pkg.id, reason: 'after restore' } });
    assert.equal(ok.status, 'ok');
    assert.equal(readFileSync(pkg.raw_path, 'utf8'), original);
  });

  await t.test('a new type degrades per field instead of dropping the line', async () => {
    const r = await collect('northwind', 'nw-2026-11-b');
    assert.equal(r.ingest.status, 'partial');
    assert.equal(r.ingest.stats.partial, 3);
    assert.deepEqual(r.ingest.stats.by_field, {
      unit_price: { type_mismatch: 3, retained: 2 },
      amount: { type_mismatch: 3, retained: 2 },
      quantity: { type_mismatch: 1 },
    });

    const run = await call(`/api/runs/${r.ingest.runId}`);
    const nw1 = run.lines.find((l) => l.line_id === 'NW-1');
    // The text money was recorded as a loss, and the previous good value kept.
    assert.equal(nw1.unit_price, '12.50');
    assert.equal(nw1.fields.unit_price.raw, '$12.50');
    assert.ok(nw1.losses.some((l) => l.field === 'unit_price' && l.kind === 'type_mismatch'));
    assert.ok(nw1.losses.some((l) => l.field === 'unit_price' && l.kind === 'retained'));
    // The new field is reported, not silently ignored.
    assert.ok(nw1.unmapped.some((u) => u.path === 'supplier_note'));

    // A brand-new line has nothing to retain: unreadable fields stay empty.
    const nw4 = run.lines.find((l) => l.line_id === 'NW-4');
    assert.equal(nw4.status, 'partial');
    assert.equal(nw4.sku, 'nw-1004');
    assert.equal(nw4.quantity, null);
    assert.equal(nw4.fields.quantity.raw, '1,200');
    assert.deepEqual(nw4.fields.unit_price.raw, { value: 3.1, currency: 'USD' });
    assert.ok(nw4.losses.some((l) => l.field === 'quantity' && l.kind === 'type_mismatch'));
  });

  let v2;
  await t.test('detection proposes a replacement; approval supersedes and repairs the package', async () => {
    const pkg = await packageByBatch('northwind', 'nw-2026-11-b');
    const detail = await waitJob(pkg.id);
    // Detection cannot overwrite the ingest outcome; the package stays partial.
    assert.equal(detail.package.status, 'partial');
    assert.equal(detail.job.existing_check.mapping, v1.approved.mapping.id);
    assert.ok(detail.job.existing_check.problems.some((p) => p.field === 'unit_price'));
    assert.equal(detail.candidates.filter((c) => c.ok).length, 1);

    v2 = await approveBest(pkg.id);
    assert.equal(v2.approved.mapping.version, 2);
    const state = await call('/api/state');
    const old = state.mappings.find((m) => m.id === v1.approved.mapping.id);
    assert.equal(old.status, 'superseded');
    assert.equal(old.superseded_by, v2.approved.mapping.id);
    assert.equal(state.sources.find((s) => s.id === 'northwind').current_mapping, v2.approved.mapping.id);
    // Only the still-partial package is re-landed; the clean baseline is untouched.
    assert.deepEqual(v2.approved.applied.map((a) => a.batch), ['nw-2026-11-b']);

    const applied = v2.approved.applied[0];
    assert.equal(applied.status, 'ok');
    const run = await call(`/api/runs/${applied.runId}`);
    const nw4 = run.lines.find((l) => l.line_id === 'NW-4');
    assert.deepEqual([nw4.quantity, nw4.unit_price, nw4.amount], [1200, '3.10', '3720.00']);
    assert.equal(nw4.fields.quantity.status, 'mapped');
  });

  await t.test('replay of the original package reproduces the same values', async () => {
    const pkg = await packageByBatch('northwind', 'nw-2026-11-b');
    const before = await call(`/api/packages/${pkg.id}`);
    const replay = await call('/api/ingest/replay', { method: 'POST', body: { package_id: pkg.id, reason: 'audit' } });
    assert.equal(replay.status, 'ok');
    const after = await call(`/api/packages/${pkg.id}`);
    assert.equal(after.runs.length, before.runs.length + 1);
    assert.equal(after.package.sha256, before.package.sha256);
    const run = await call(`/api/runs/${replay.runId}`);
    assert.equal(run.run.trigger, 'replay');
    assert.equal(run.lines.length, 3);
    assert.ok(run.lines.every((l) => l.changes.length === 0), 'replay of identical bytes invents no changes');
  });

  let v3;
  await t.test('an ambiguous array yields one candidate per reading, never a silent pick', async () => {
    const r = await collect('northwind', 'nw-2026-11-c');
    assert.equal(r.ingest.status, 'partial');
    const detail = await waitJob(r.package.id);
    const usable = detail.candidates.filter((c) => c.ok);
    assert.equal(usable.length, 2);
    assert.deepEqual(usable.map((c) => c.spec.selectors.amount.steps[0].array_item).sort(), [0, 1]);
    for (const candidate of usable) {
      assert.ok(candidate.notes.some((n) => n.code === 'N_AMBIGUOUS_ARRAY'));
      assert.ok(candidate.notes.some((n) => n.code === 'N_VARIANT_CHOICE'));
    }

    // Approving the second reading is an explicit operator decision, and only
    // that reading lands.
    const second = usable.find((c) => c.spec.selectors.amount.steps[0].array_item === 1);
    const drafted = await call('/api/mappings/draft', { method: 'POST', body: { package_id: r.package.id, candidate: second.index } });
    const approved = await call(`/api/mappings/${drafted.mapping.id}/approve`, { method: 'POST', body: { by: 'test' } });
    v3 = { drafted, approved };
    assert.equal(approved.mapping.version, 3);
    const applied = approved.applied.find((a) => a.batch === 'nw-2026-11-c');
    assert.equal(applied.status, 'ok');
    const run = await call(`/api/runs/${applied.runId}`);
    assert.deepEqual(run.lines.map((l) => l.amount), ['5.00', '0.00', '1.40']);
    const state = await call('/api/state');
    assert.equal(state.mappings.find((m) => m.id === v2.approved.mapping.id).superseded_by, approved.mapping.id);
  });

  await t.test('a package no proposed mapping can read waits for a hand-written mapping', async () => {
    const r = await collect('northwind', 'nw-2026-11-d');
    assert.equal(r.ingest.status, 'failed');
    // The refusal is the mapping's, not a guess: the read plan says exactly why.
    assert.match(r.ingest.stats.reason, /not an array/);
    const detail = await waitJob(r.package.id);
    assert.equal(detail.package.status, 'needs_mapping');
    assert.equal(detail.candidates.length, 0);
    // Other packages for the source kept their outcomes.
    assert.equal((await packageByBatch('northwind', 'nw-2026-11-c')).status, 'applied');

    const hand = {
      spec: 'cg.map/1',
      source_id: 'northwind',
      version: 1,
      label: 'packed string lines',
      lines: { path: 'lines', mode: 'object_of_objects' },
      selectors: {
        line_id: { path: '', target: 'string', steps: [{ derived_line_id: { parts: ['$key'] } }] },
        sku: { path: '', target: 'string', steps: [{ split: '|' }, { array_item: 0 }] },
        quantity: { path: '', target: 'integer', steps: [{ split: '|' }, { array_item: 1 }, { number: true }] },
        unit_price: { path: '', target: 'decimal', steps: [{ split: '|' }, { array_item: 2 }, { number: true }] },
        currency: { path: 'root.currency', target: 'string', steps: [{ currency: true }, { case: 'upper' }] },
      },
      notes: {},
    };
    const drafted = await call('/api/mappings/draft', { method: 'POST', body: { package_id: r.package.id, spec: hand } });
    assert.equal(drafted.validation.ok, true);
    assert.equal(drafted.mapping.version, 4);
    const plan = await call(`/api/packages/${r.package.id}/plan?mapping_id=${drafted.mapping.id}`);
    assert.equal(plan.plan.ok, true);

    const approved = await call(`/api/mappings/${drafted.mapping.id}/approve`, { method: 'POST', body: { by: 'test' } });
    const applied = approved.applied.find((a) => a.batch === 'nw-2026-11-d');
    assert.equal(applied.status, 'ok');
    const run = await call(`/api/runs/${applied.runId}`);
    assert.deepEqual(
      run.lines.map((l) => [l.line_id, l.sku, l.quantity, l.unit_price, l.currency]),
      [
        ['NW-1', 'nw-1001', 4, '12.50', 'USD'],
        ['NW-2', 'nw-1002', 100, '0.35', 'USD'],
        ['NW-6', 'nw-1006', 10, '2.10', 'USD'],
      ],
    );
  });

  await t.test('revoking the active mapping stops new ingests without blocking detection', async () => {
    const current = (await call('/api/state')).sources.find((s) => s.id === 'northwind').current_mapping;
    assert.ok(current);
    const revoked = await call(`/api/mappings/${current}/revoke`, { method: 'POST', body: { reason: 'supplier withdrew format' } });
    assert.equal(revoked.mapping.status, 'revoked');
    assert.equal(revoked.current, null);

    const r = await collect('northwind', 'nw-2026-11-a');
    assert.equal(r.ingest.status, 'awaiting_mapping');
    assert.match(r.ingest.reason, /no approved mapping/);
    const detail = await waitJob(r.package.id);
    assert.equal(detail.package.status, 'awaiting_mapping');
    assert.ok(detail.candidates.length >= 1, 'detection still runs and proposes');

    const replacement = await approveBest(r.package.id);
    assert.notEqual(replacement.approved.mapping.id, current);
    const applied = replacement.approved.applied.find((a) => a.packageId === r.package.id);
    assert.equal(applied.status, 'ok');
    const state = await call('/api/state');
    const old = state.mappings.find((m) => m.id === current);
    assert.equal(old.status, 'revoked');
    assert.equal(old.revoked_reason, 'supplier withdrew format');
    // Revoked mappings are historical only: a new version took over.
    assert.ok(state.mappings.find((m) => m.id === current).superseded_by === null);
  });
});

// ---------------------------------------------------------------------------
// One supplier's revision must not block another supplier.
// ---------------------------------------------------------------------------

test('a source that is waiting or crashed is isolated from the others', async (t) => {
  const env = await makeEnv();
  t.after(env.cleanup);
  const { call, register, collect, waitJob, approveBest, packageByBatch } = env;

  await register('northwind');
  await register('acme', { label: 'Acme' });

  const nw = await collect('northwind', 'nw-2026-11-a');
  await waitJob(nw.package.id);
  await approveBest(nw.package.id);

  // Northwind changes shape and its package waits for a mapping. Acme must be
  // unaffected: its own collection, detection and approval all proceed.
  const changed = await collect('northwind', 'nw-2026-11-d');
  assert.equal(changed.ingest.status, 'failed');
  await waitJob(changed.package.id);
  assert.equal((await packageByBatch('northwind', 'nw-2026-11-d')).status, 'needs_mapping');

  const acme = await collect('acme', 'acme-inv-7781');
  assert.equal(acme.ingest.status, 'awaiting_mapping');
  const detail = await waitJob(acme.package.id);
  assert.equal(detail.package.status, 'awaiting_mapping');
  const approved = await approveBest(acme.package.id);
  assert.equal(approved.approved.mapping.source_id, 'acme');
  const applied = approved.approved.applied.find((a) => a.batch === 'acme-inv-7781');
  assert.equal(applied.status, 'ok');
  const run = await call(`/api/runs/${applied.runId}`);
  assert.deepEqual(
    run.lines.map((l) => [l.line_id, l.sku, l.quantity, l.unit_price, l.amount]),
    [
      ['AC-1', 'ACME-77', 10, '2.25', '22.50'],
      ['AC-2', 'ACME-78', 25, '0.12', '3.00'],
      ['AC-3', 'ACME-79', 25, '0.18', '4.50'],
    ],
  );

  // Northwind's approved mapping was not touched by acme's approval.
  const state = await call('/api/state');
  assert.equal(state.sources.find((s) => s.id === 'northwind').current_mapping, 'northwind@v1');
  assert.equal(state.sources.find((s) => s.id === 'acme').current_mapping, 'acme@v1');
});

// ---------------------------------------------------------------------------
// Policy: the same changed package under per_field and under whole_source.
// ---------------------------------------------------------------------------

test('policy: per_field lands what it can, whole_source quarantines the package', async (t) => {
  const env = await makeEnv();
  t.after(env.cleanup);
  const { call, register, collect, waitJob, approveBest, packageByBatch } = env;

  await register('northwind');
  const base = await collect('northwind', 'nw-2026-11-a');
  await waitJob(base.package.id);
  await approveBest(base.package.id);

  await t.test('per_field: a partly readable package still lands its readable fields', async () => {
    await call('/api/sources/northwind/policy', { method: 'PATCH', body: { policy: 'per_field' } });
    const r = await collect('northwind', 'nw-2026-11-b');
    assert.equal(r.ingest.stats.package_status, 'partial');
    const run = await call(`/api/runs/${r.ingest.runId}`);
    assert.ok(run.lines.every((l) => l.applied === 1));
    const lines = (await call('/api/lines?source_id=northwind')).lines;
    assert.deepEqual(
      lines.map((l) => l.line_id),
      ['NW-1', 'NW-2', 'NW-3', 'NW-4'],
    );
    assert.equal(lines.find((l) => l.line_id === 'NW-4').status, 'partial');
  });

  await t.test('whole_source: the same shape is refused as a unit and nothing is applied', async () => {
    await register('northwind_ws', { fixture: 'northwind', label: 'Northwind (whole source)' });
    const baseline = await collect('northwind_ws', 'nw-2026-11-a');
    await waitJob(baseline.package.id);
    await approveBest(baseline.package.id);

    await call('/api/sources/northwind_ws/policy', { method: 'PATCH', body: { policy: 'whole_source' } });
    const r = await collect('northwind_ws', 'nw-2026-11-b');
    assert.equal(r.ingest.status, 'quarantined');
    assert.equal(r.ingest.stats.quarantined, 3);
    assert.match(r.ingest.stats.reason, /whole_source/);
    assert.equal((await packageByBatch('northwind_ws', 'nw-2026-11-b')).status, 'quarantined');

    // The quarantined package applied nothing: current lines are still the
    // baseline only, and the stored rows are marked not applied.
    const lines = (await call('/api/lines?source_id=northwind_ws')).lines;
    assert.deepEqual(lines.map((l) => l.line_id), ['NW-1', 'NW-2', 'NW-3']);
    const run = await call(`/api/runs/${r.ingest.runId}`);
    assert.ok(run.lines.every((l) => l.applied === 0));
    assert.equal(run.stats.lines_total, 3);
    assert.equal(run.stats.quarantined, 3);
    // The reason names the offending field rather than a generic refusal.
    assert.deepEqual(
      run.stats.plan.problems.map((p) => p.field),
      ['unit_price'],
    );

    // Replaying the quarantined package after switching policy lands it.
    await call('/api/sources/northwind_ws/policy', { method: 'PATCH', body: { policy: 'per_field' } });
    const pkg = await packageByBatch('northwind_ws', 'nw-2026-11-b');
    const replay = await call('/api/ingest/replay', { method: 'POST', body: { package_id: pkg.id, reason: 'policy changed' } });
    assert.equal(replay.status, 'partial');
    const after = (await call('/api/lines?source_id=northwind_ws')).lines;
    assert.equal(after.length, 4);
    assert.ok(after.some((l) => l.line_id === 'NW-4' && l.status === 'partial'));
  });
});

// ---------------------------------------------------------------------------
// Interleaved old and new types inside one package (globex gx-orders-552).
// ---------------------------------------------------------------------------

test('globex: old and new shapes interleaved in one package', async (t) => {
  const env = await makeEnv();
  t.after(env.cleanup);
  const { call, register, collect, waitJob, approveBest, packageByBatch } = env;

  await register('globex');
  const base = await collect('globex', 'gx-orders-551');
  await waitJob(base.package.id);
  const v1 = await approveBest(base.package.id);
  assert.equal(v1.approved.applied[0].status, 'ok');

  const r = await collect('globex', 'gx-orders-552');

  await t.test('the old mapping reads the old order and marks the new one', async () => {
    assert.equal(r.ingest.status, 'partial');
    const run = await call(`/api/runs/${r.ingest.runId}`);
    const bySku = new Map(run.lines.map((l) => [l.sku, l]));
    assert.equal(bySku.get('gx-11').status, 'ok');
    assert.equal(bySku.get('gx-9').status, 'partial');
    // The scalar value from the previous package is retained, explicitly.
    assert.equal(bySku.get('gx-9').quantity, 3);
    assert.ok(bySku.get('gx-9').losses.some((l) => l.kind === 'type_mismatch' && l.field === 'quantity'));
    assert.ok(bySku.get('gx-9').losses.some((l) => l.kind === 'retained' && l.field === 'quantity'));
    assert.ok(bySku.get('gx-9').unmapped.some((u) => u.path.startsWith('dims.')));
  });

  await t.test('an approved unwrap mapping reads both shapes in the same package', async () => {
    const pkg = await packageByBatch('globex', 'gx-orders-552');
    const detail = await waitJob(pkg.id);
    const candidate = detail.candidates.find((c) => c.ok);
    assert.ok(candidate, 'detection proposed a readable mapping');
    assert.equal(candidate.spec.selectors.quantity.steps[0].unwrap, true);
    assert.equal(candidate.spec.selectors.unit_price.steps[0].unwrap, true);
    assert.equal(candidate.spec.selectors.currency.path, 'parent.currency');

    const drafted = await call('/api/mappings/draft', { method: 'POST', body: { package_id: pkg.id, candidate: candidate.index } });
    const approved = await call(`/api/mappings/${drafted.mapping.id}/approve`, { method: 'POST', body: { by: 'test' } });
    const applied = approved.applied.find((a) => a.batch === 'gx-orders-552');
    assert.equal(applied.status, 'ok');
    const run = await call(`/api/runs/${applied.runId}`);
    assert.deepEqual(
      run.lines.map((l) => [l.sku, l.quantity, l.unit_price, l.currency]),
      [
        ['gx-9', 3, '9.99', 'EUR'],
        ['gx-10', 2, '14.50', 'EUR'],
        ['gx-11', 1, '7.25', 'EUR'],
      ],
    );
    // The new nested dimension field is reported unmapped, not guessed at.
    assert.deepEqual(
      run.lines.flatMap((l) => l.unmapped.map((u) => u.path)).filter((p) => p.startsWith('dims.')),
      ['dims.l', 'dims.w', 'dims.h', 'dims.l', 'dims.w', 'dims.h'],
    );
  });
});

// ---------------------------------------------------------------------------
// Detection as a real process: crash, retry, bounded attempts, orphan sweep.
// ---------------------------------------------------------------------------

test('detection crash: package untouched, retry bounded, orphan sweep recovers', async (t) => {
  const env = await makeEnv();
  t.after(env.cleanup);
  const { call, register, collect, waitJob, waitFor, app } = env;

  await register('globex');
  const r = await collect('globex', 'gx-orders-551');
  const baseline = await waitJob(r.package.id);

  await t.test('an injected crash is a real process death and leaves no result', async () => {
    const started = await call('/api/detect', { method: 'POST', body: { package_id: r.package.id, crash_after: 1 } });
    assert.equal(started.job.status, 'queued');
    const crashed = await waitFor(async () => {
      const detail = await call(`/api/packages/${r.package.id}`);
      return detail.job?.status === 'crashed' ? detail : null;
    });
    assert.match(crashed.job.error, /SIGKILL|killed/);
    assert.equal(crashed.package.status, 'needs_attention');
    assert.equal(crashed.candidates.length, 0);
    assert.equal(crashed.package.sha256, baseline.package.sha256);
  });

  await t.test('retry runs a normal worker and records the second attempt', async () => {
    const before = await call(`/api/packages/${r.package.id}`);
    const retried = await call(`/api/jobs/${before.job.id}/retry`, { method: 'POST', body: {} });
    assert.equal(retried.job.status, 'queued');
    const done = await waitJob(r.package.id);
    assert.equal(done.job.status, 'done');
    assert.equal(done.job.attempts, 2);
    assert.ok(done.candidates.length >= 1);

    const wrongState = await call(`/api/jobs/${done.job.id}/retry`, { method: 'POST', body: {} }).then(
      () => null,
      (e) => e,
    );
    assert.equal(wrongState?.status, 409);
    assert.equal(wrongState.code, 'E_JOB_STATE');
  });

  await t.test('the startup sweep recovers a job whose worker vanished', async () => {
    const job = app.store.createDetectionJob(r.package.id, 'globex');
    app.store.db
      .prepare("UPDATE detection_jobs SET status='running', pid=999999, started_at=? WHERE id=?")
      .run(new Date().toISOString(), job.id);
    app.store.setPackageStatus(r.package.id, 'queued_detection', { jobId: job.id });

    const recovered = app.api.sweep();
    const fresh = app.store.getDetectionJob(job.id);
    assert.equal(fresh.status, 'crashed');
    assert.match(fresh.error, /disappeared/);
    assert.ok(recovered.some((x) => x.job === job.id));
    assert.equal(app.store.getPackage(r.package.id).status, 'needs_attention');
  });

  await t.test('the sweep does not downgrade a package ingestion already landed', async () => {
    // The earlier sweep test left the last job crashed, so ask for detection
    // again: this test is about the ingest outcome, not about job history.
    await call('/api/detect', { method: 'POST', body: { package_id: r.package.id } });
    await waitJob(r.package.id);
    const applied = await env.approveBest(r.package.id);
    assert.equal(applied.approved.applied[0].status, 'ok');
    assert.equal((await call(`/api/packages/${r.package.id}`)).package.status, 'applied');

    // A second, orphaned detection job for an already-applied package must not
    // make it look unusable: the ingest outcome outranks detection bookkeeping.
    const job = app.store.createDetectionJob(r.package.id, 'globex');
    app.store.db
      .prepare("UPDATE detection_jobs SET status='running', pid=999999, started_at=? WHERE id=?")
      .run(new Date().toISOString(), job.id);
    app.api.sweep();
    assert.equal(app.store.getDetectionJob(job.id).status, 'crashed');
    assert.equal(app.store.getPackage(r.package.id).status, 'applied');
  });
});

test('detection attempts are bounded when the worker genuinely keeps dying', async (t) => {
  const workerDir = mkdtempSync(join(tmpdir(), 'cg-worker-'));
  const crashWorker = join(workerDir, 'always-crash.mjs');
  writeFileSync(crashWorker, "process.kill(process.pid, 'SIGKILL');\n", 'utf8');
  const env = await makeEnv({ workerPath: crashWorker });
  t.after(async () => {
    await env.cleanup();
    rmSync(workerDir, { recursive: true, force: true });
  });

  await env.register('northwind');
  const r = await env.collect('northwind', 'nw-2026-11-a');

  let jobId = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await env.call(`/api/jobs/${jobId}/retry`, { method: 'POST', body: {} });
    const detail = await env.waitFor(async () => {
      const d = await env.call(`/api/packages/${r.package.id}`);
      return d.job?.status === 'crashed' && d.job.attempts === attempt ? d : null;
    });
    assert.equal(detail.package.status, 'needs_attention');
    jobId ??= detail.job.id;
  }

  const refused = await env.call(`/api/jobs/${jobId}/retry`, { method: 'POST', body: {} }).then(
    () => null,
    (e) => e,
  );
  assert.equal(refused?.status, 409);
  assert.equal(refused.code, 'E_JOB_ATTEMPTS');
  assert.match(refused.message, /3 attempts/);
});

// ---------------------------------------------------------------------------
// API refusals: typed errors, never a silent success.
// ---------------------------------------------------------------------------

test('the API refuses invalid input with typed errors', async (t) => {
  const env = await makeEnv();
  t.after(env.cleanup);
  const { call, register, collect, waitJob } = env;
  await register('northwind');

  await t.test('unknown routes, sources and packages are distinguishable', async () => {
    for (const [path, code, status] of [
      ['/api/nope', 'E_ROUTE', 404],
      ['/api/packages/pkg_missing', 'E_PACKAGE', 404],
    ]) {
      const err = await call(path).then(
        () => null,
        (e) => e,
      );
      assert.equal(err?.code, code);
      assert.equal(err.status, status);
    }
    const badSource = await call('/api/collect', { method: 'POST', body: { source_id: 'nope', batch: 'x' } }).then(
      () => null,
      (e) => e,
    );
    assert.equal(badSource?.status, 404);
    assert.equal(badSource.code, 'E_SOURCE');
  });

  await t.test('a source response that is not a known batch is never stored', async () => {
    const err = await call('/api/collect', { method: 'POST', body: { source_id: 'northwind', batch: 'no-such-batch' } }).then(
      () => null,
      (e) => e,
    );
    assert.equal(err?.code, 'E_SOURCE_HTTP');
    const state = await call('/api/state');
    const nw = state.sources.find((s) => s.id === 'northwind');
    assert.equal(nw.packages.filter((p) => p.batch_name === 'no-such-batch').length, 0);
  });

  await t.test('a mapping outside the contract can be drafted for inspection but never approved', async () => {
    const r = await collect('northwind', 'nw-2026-11-a');
    await waitJob(r.package.id);
    const drafted = await call('/api/mappings/draft', {
      method: 'POST',
      body: {
        package_id: r.package.id,
        spec: {
          spec: 'cg.map/1',
          source_id: 'northwind',
          version: 1,
          lines: { path: 'lines', mode: 'array' },
          selectors: {
            line_id: { path: 'line_id', target: 'string' },
            sku: { path: 'sku', target: 'string' },
            discount: { path: 'discount', target: 'decimal' },
          },
        },
      },
    });
    assert.equal(drafted.validation.ok, false);
    assert.ok(drafted.validation.errors.some((e) => e.code === 'E_UNKNOWN_FIELD'));

    const approveErr = await call(`/api/mappings/${drafted.mapping.id}/approve`, { method: 'POST', body: {} }).then(
      () => null,
      (e) => e,
    );
    assert.equal(approveErr?.status, 409);
    assert.equal(approveErr.code, 'E_MAPPING_INVALID');
    assert.equal((await call('/api/state')).mappings.find((m) => m.id === drafted.mapping.id).status, 'draft');

    // Even the manual ingest endpoint refuses an unapproved mapping.
    const runErr = await call('/api/ingest/run', { method: 'POST', body: { package_id: r.package.id, mapping_id: drafted.mapping.id } }).then(
      () => null,
      (e) => e,
    );
    assert.equal(runErr?.status, 409);
    assert.equal(runErr.code, 'E_MAPPING_NOT_APPROVED');
  });
});
