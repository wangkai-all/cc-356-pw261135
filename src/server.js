// HTTP server: JSON API plus the static operator console.
//
// The API is deliberately small. Every mutating endpoint writes an event and
// returns the new state. Errors carry a machine code and a human detail, so the
// console can show why an action was refused without parsing prose.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { Store } from './db.js';
import { collectBatch, SourceRegistry } from './collect.js';
import { DetectionSupervisor } from './supervisor.js';
import { applyApprovedMapping, ingestIfMapped, ingestPackage, replayPackage, readVerifiedPackage, IngestError } from './ingest.js';
import { buildReadPlan, validateMapping } from './spec.js';
import { ROOT, stableStringify, sha256 } from './util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createApp({ root = ROOT, dbFile = join(root, 'data', 'contract-gate.sqlite3'), fixtureUrl = null, workerPath = null } = {}) {
  const store = new Store(dbFile);
  // `root` is the data root; when it is a temp directory the worker script still
  // has to come from the checkout, so the path is injectable.
  const supervisor = new DetectionSupervisor({ store, root, dbFile, workerPath });
  const registry = new SourceRegistry(store);
  const fixtureBase = fixtureUrl ?? store.getSetting('fixture_url', 'http://127.0.0.1:4100');

  const api = {
    store,
    supervisor,
    registry,
    close() {
      supervisor.shutdown();
      store.close();
    },
    sweep() {
      return supervisor.sweep();
    },
    async handle(method, path, query, body) {
      const seg = path.split('/').filter(Boolean);
      // GET /api/state — everything the console needs in one round trip.
      if (method === 'GET' && path === '/api/state') {
        return {
          sources: registry.list().map((s) => ({ ...s, packages: store.listPackages({ sourceId: s.id, limit: 50 }) })),
          counts: store.counts(),
          mappings: store.listMappings().map(publicMapping(store)),
          jobs: store.latestJobs(24).map((j) => ({ ...j, result_json: undefined })),
          events: store.recentEvents(80),
          contract: CONTRACT_FIELDS_LIGHT,
          setting_fixture_url: fixtureBase,
        };
      }
      if (method === 'GET' && path === '/api/health') {
        return { ok: true, frozen: frozenState(store) };
      }
      if (method === 'GET' && path === '/api/contract') return { fields: CONTRACT_FIELDS_LIGHT };

      // POST /api/sources — register or update a source.
      if (method === 'POST' && path === '/api/sources') {
        const def = { ...body };
        if (!def.base_url) def.base_url = `${fixtureBase}/pack?source=${def.id}`;
        const source = registry.register(def);
        return { source };
      }
      if (method === 'PATCH' && seg[0] === 'api' && seg[1] === 'sources' && seg[2] && seg[3] === 'policy') {
        const source = store.setPolicy(seg[2], body.policy);
        return { source };
      }
      if (method === 'POST' && path === '/api/collect') {
        const source = store.getSource(body.source_id);
        if (!source) throw httpError(404, 'E_SOURCE', 'source not found');
        const result = await collectBatch(store, root, source, { batch: body.batch });
        // Land with the approved mapping first, then let detection propose new
        // versions in parallel. Detection never gates ingestion of known shapes.
        const ingest = ingestIfMapped(store, result.package);
        const job = supervisor.requestDetection(store.getPackage(result.package.id));
        return { package: store.getPackage(result.package.id), job: store.getDetectionJob(job.id), ingest };
      }
      if (method === 'GET' && path === '/api/batches') {
        const res = await fetch(`${fixtureBase}/batches`);
        return await res.json();
      }
      if (method === 'POST' && path === '/api/detect') {
        const pkg = store.getPackage(body.package_id);
        if (!pkg) throw httpError(404, 'E_PACKAGE', 'package not found');
        const job = supervisor.requestDetection(pkg, { crash_after: body.crash_after ?? 0 });
        return { job: store.getDetectionJob(job.id) };
      }
      if (method === 'POST' && seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'retry') {
        try {
          const job = supervisor.retry(seg[2]);
          return { job };
        } catch (e) {
          throw httpError(e.code === 'E_JOB' ? 404 : 409, e.code ?? 'E_JOB', e.message);
        }
      }
      if (method === 'GET' && path === '/api/mappings') {
        return { mappings: store.listMappings(query.get('source_id') ?? undefined).map(publicMapping(store)) };
      }
      if (method === 'POST' && path === '/api/mappings/draft') {
        // Persist a candidate exactly as detected, or an edited spec from the editor.
        const pkg = store.getPackage(body.package_id);
        if (!pkg) throw httpError(404, 'E_PACKAGE', 'package not found');
        const job = store.latestJobForPackage(pkg.id);
        const result = job?.result_json ? JSON.parse(job.result_json) : null;
        const spec = body.spec ?? result?.candidates?.[body.candidate ?? result.best]?.spec;
        if (!spec) throw httpError(400, 'E_NO_CANDIDATE', 'no candidate mapping available for this package');
        const check = validateMapping({ ...spec, version: store.nextVersion(spec.source_id) });
        const version = store.nextVersion(spec.source_id);
        const stored = { ...spec, version };
        const mapping = store.createMapping({
          sourceId: spec.source_id,
          spec: stored,
          fingerprint: fingerprintOf(stored),
          findings: {
            validation: check,
            candidate: body.candidate ?? null,
            package_id: pkg.id,
            findings: spec.findings ?? [],
            origin_label: spec.label ?? null,
          },
          originPackageId: pkg.id,
        });
        store.setPackageStatus(pkg.id, 'mapping_drafted', { mappingId: mapping.id });
        return { mapping: publicMapping(store)(mapping), validation: check };
      }
      if (method === 'POST' && seg[0] === 'api' && seg[1] === 'mappings' && seg[2] && seg[3] === 'approve') {
        const mapping = store.getMapping(seg[2]);
        if (!mapping) throw httpError(404, 'E_MAPPING', 'mapping not found');
        const spec = JSON.parse(mapping.spec_json);
        const check = validateMapping(spec);
        if (!check.ok) throw httpError(409, 'E_MAPPING_INVALID', `mapping does not satisfy the contract spec: ${check.errors.map((e) => e.detail).join('; ')}`);
        const approved = store.approveMapping(mapping.id, body.by ?? 'operator');
        // Approval is also the trigger to retry everything that was waiting. A
        // package the new version still cannot read stays queued with a reason.
        const applied = applyApprovedMapping(store, approved);
        return { mapping: publicMapping(store)(approved), applied };
      }
      if (method === 'POST' && seg[0] === 'api' && seg[1] === 'mappings' && seg[2] && seg[3] === 'revoke') {
        const mapping = store.getMapping(seg[2]);
        if (!mapping) throw httpError(404, 'E_MAPPING', 'mapping not found');
        const revoked = store.revokeMapping(mapping.id, body.reason ?? null);
        return { mapping: publicMapping(store)(revoked), current: store.currentApproved(revoked.source_id)?.id ?? null };
      }
      if (method === 'POST' && seg[0] === 'api' && seg[1] === 'mappings' && seg[2] && seg[3] === 'delete') {
        const mapping = store.getMapping(seg[2]);
        if (!mapping) throw httpError(404, 'E_MAPPING', 'mapping not found');
        if (mapping.status === 'approved') throw httpError(409, 'E_MAPPING_ACTIVE', 'cannot delete an approved mapping; revoke it first');
        store.db.prepare('DELETE FROM mappings WHERE id=?').run(mapping.id);
        store.event('mapping.deleted', { sourceId: mapping.source_id, mappingId: mapping.id, message: `Deleted draft ${mapping.id}` });
        return { deleted: mapping.id };
      }
      if (method === 'GET' && seg[0] === 'api' && seg[1] === 'mappings' && seg[2] && !seg[3]) {
        const m = store.getMapping(seg[2]);
        if (!m) throw httpError(404, 'E_MAPPING', 'mapping not found');
        return { mapping: publicMapping(store)(m), spec: JSON.parse(m.spec_json) };
      }
      if (method === 'POST' && path === '/api/ingest/replay') {
        const pkg = store.getPackage(body.package_id);
        if (!pkg) throw httpError(404, 'E_PACKAGE', 'package not found');
        const mappingId = body.mapping_id ?? store.currentApproved(pkg.source_id)?.id;
        const mapping = mappingId ? store.getMapping(mappingId) : null;
        if (!mapping) throw httpError(409, 'E_MAPPING_MISSING', 'no approved mapping for this source');
        if (mapping.status !== 'approved') throw httpError(409, 'E_MAPPING_NOT_APPROVED', `mapping ${mapping.id} is ${mapping.status}`);
        const policy = store.getSource(pkg.source_id).policy;
        const res = replayPackage(store, { pkg, mapping, policy, reason: body.reason ?? null });
        return res;
      }
      if (method === 'POST' && path === '/api/ingest/run') {
        const pkg = store.getPackage(body.package_id);
        if (!pkg) throw httpError(404, 'E_PACKAGE', 'package not found');
        const mapping = store.getMapping(body.mapping_id);
        if (!mapping) throw httpError(404, 'E_MAPPING', 'mapping not found');
        const policy = store.getSource(pkg.source_id).policy;
        return ingestPackage(store, { pkg, mapping, policy, trigger: 'manual' });
      }
      if (method === 'GET' && path === '/api/packages') {
        return { packages: store.listPackages({ sourceId: query.get('source_id') ?? undefined, limit: Number(query.get('limit') ?? 100) }) };
      }
      if (method === 'GET' && seg[0] === 'api' && seg[1] === 'packages' && seg[2] && !seg[3]) {
        return packageDetail(store, seg[2]);
      }
      if (method === 'GET' && seg[0] === 'api' && seg[1] === 'packages' && seg[2] && seg[3] === 'raw') {
        const pkg = store.getPackage(seg[2]);
        if (!pkg) throw httpError(404, 'E_PACKAGE', 'package not found');
        return { raw: readFileSync(pkg.raw_path, 'utf8'), sha256: pkg.sha256, bytes: pkg.bytes, path: pkg.raw_path };
      }
      if (method === 'GET' && seg[0] === 'api' && seg[1] === 'packages' && seg[2] && seg[3] === 'plan') {
        const pkg = store.getPackage(seg[2]);
        if (!pkg) throw httpError(404, 'E_PACKAGE', 'package not found');
        const mappingId = query.get('mapping_id') ?? store.currentApproved(pkg.source_id)?.id;
        const mapping = mappingId ? store.getMapping(mappingId) : null;
        if (!mapping) throw httpError(409, 'E_MAPPING_MISSING', 'no mapping to plan with');
        const spec = JSON.parse(mapping.spec_json);
        const { bundle } = readVerifiedPackage(store, pkg);
        return { mapping: mapping.id, plan: buildReadPlan(spec, bundle) };
      }
      if (method === 'GET' && seg[0] === 'api' && seg[1] === 'packages' && seg[2] && seg[3] === 'runs') {
        return { runs: store.listRuns(seg[2]) };
      }
      if (method === 'GET' && seg[0] === 'api' && seg[1] === 'runs' && seg[2]) {
        const run = store.getRun(seg[2]);
        if (!run) throw httpError(404, 'E_RUN', 'run not found');
        return { run, stats: JSON.parse(run.stats_json ?? '{}'), lines: store.linesForRun(run.id).map(publicLine) };
      }
      if (method === 'GET' && path === '/api/lines') {
        const sourceId = query.get('source_id');
        return { lines: store.currentLines(sourceId).map(publicLine) };
      }
      if (method === 'GET' && path === '/api/events') return { events: store.recentEvents(Number(query.get('limit') ?? 100)) };
      throw httpError(404, 'E_ROUTE', `no route for ${method} ${path}`);
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      try {
        const body = await readBody(req);
        const out = await api.handle(req.method, url.pathname, url.searchParams, body);
        sendJson(res, 200, out);
      } catch (e) {
        const status = e.status ?? 500;
        if (status >= 500) console.error(e);
        sendJson(res, status, { error: e.code ?? 'E_INTERNAL', message: e.message, details: e.details ?? null });
      }
      return;
    }
    serveStatic(req, res, url);
  });

  server.on('close', () => api.close());
  return { server, api, store, supervisor };
}

function fingerprintOf(spec) {
  return 'sha256:' + sha256(stableStringify({ lines: spec.lines, selectors: spec.selectors }));
}

const CONTRACT_FIELDS_LIGHT = [
  { name: 'line_id', type: 'string', required: true, note: 'Stable per-line key; drives upsert.' },
  { name: 'sku', type: 'string', required: true, note: 'Catalog key.' },
  { name: 'description', type: 'string', required: false, note: 'Human text.' },
  { name: 'quantity', type: 'integer', required: false, note: 'Integers only; fractional input is rejected, never rounded.' },
  { name: 'unit_price', type: 'decimal', required: false, note: 'Canonical 2dp text.' },
  { name: 'currency', type: 'string', required: false, note: 'Uppercase code.' },
  { name: 'amount', type: 'decimal', required: false, note: 'Canonical 2dp text.' },
  { name: 'unit', type: 'string', required: false, note: 'Unit of measure.' },
];

function publicMapping(store) {
  return (m) => ({
    id: m.id,
    source_id: m.source_id,
    version: m.version,
    status: m.status,
    fingerprint: m.fingerprint,
    created_at: m.created_at,
    approved_at: m.approved_at,
    approved_by: m.approved_by,
    revoked_at: m.revoked_at,
    revoked_reason: m.revoked_reason,
    superseded_by: m.superseded_by ?? null,
    origin_package_id: m.origin_package_id,
    findings: m.findings_json ? JSON.parse(m.findings_json) : {},
    notes: m.notes_json ? JSON.parse(m.notes_json) : {},
  });
}

function publicLine(row) {
  const json = (v, fallback) => {
    try { return JSON.parse(v ?? fallback); } catch { return fallback; }
  };
  return {
    ...row,
    fields: json(row.fields_json, {}),
    losses: json(row.losses_json, []),
    unmapped: json(row.unmapped_json, []),
    changes: json(row.changes_json, []),
  };
}

function packageDetail(store, id) {
  const pkg = store.getPackage(id);
  if (!pkg) throw httpError(404, 'E_PACKAGE', 'package not found');
  const runs = store.listRuns(id).map((r) => ({ ...r, stats: r.stats_json ? JSON.parse(r.stats_json) : {} }));
  const job = store.latestJobForPackage(id);
  const result = job?.result_json ? JSON.parse(job.result_json) : null;
  return {
    package: pkg,
    runs,
    job: job
      ? {
          id: job.id,
          status: job.status,
          attempts: job.attempts,
          error: job.error,
          started_at: job.started_at,
          ended_at: job.ended_at,
          pid: job.pid,
          options: job.options_json ? JSON.parse(job.options_json) : {},
          existing_check: result?.existing_check ?? null,
        }
      : null,
    // Candidates carry their own evidence so the console never needs a second
    // request to explain why a proposal is or is not usable.
    candidates:
      result?.candidates?.map((c, i) => ({
        index: i,
        label: c.label,
        family: c.family,
        confidence: c.confidence,
        ok: Boolean(c.validation?.ok && c.coverage?.ok),
        validation: c.validation,
        coverage: c.coverage,
        notes: c.notes ?? [],
        spec: c.spec ?? null,
      })) ?? [],
    best: result?.best ?? null,
    mapping: pkg.mapping_id ? publicMapping(store)(store.getMapping(pkg.mapping_id)) : null,
  };
}

export function frozenState(store) {
  const sources = store.listSources();
  const rows = store.db.prepare("SELECT source_id, status, COUNT(*) AS n FROM packages GROUP BY source_id, status").all();
  return sources.map((s) => ({ source_id: s.id, frozen: store.currentApproved(s.id) === null, packages: rows.filter((r) => r.source_id === s.id) }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve({});
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(httpError(413, 'E_BODY_TOO_LARGE', 'request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(httpError(400, 'E_BODY_JSON', 'body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = normalize(join(ROOT, 'public', pathname));
  if (!file.startsWith(join(ROOT, 'public'))) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

export function httpError(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, details });
}
