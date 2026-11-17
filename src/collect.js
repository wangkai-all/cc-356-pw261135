// Source adapters and the collector. A source is an HTTP endpoint (in the demo,
// a local fixture server) that returns a JSON package. Collection is dumb on
// purpose: it stores the exact bytes, records their hash, and queues structure
// detection. It never inspects the payload beyond parsing JSON enough to reject
// non-JSON responses — understanding is the detection stage's job.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './util.js';

export class SourceRegistry {
  constructor(store) {
    this.store = store;
  }

  list() {
    return this.store.listSources().map((s) => ({
      ...s,
      enabled: Boolean(s.enabled),
      current_mapping: this.store.currentApproved(s.id)?.id ?? null,
      awaiting: this.store.packagesPendingMapping(s.id).length,
    }));
  }

  register(def) {
    for (const key of ['id', 'label', 'base_url']) {
      if (!def[key]) throw Object.assign(new Error(`source.${key} is required`), { code: 'E_SOURCE_DEF' });
    }
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(def.id)) throw Object.assign(new Error('source.id must be a lowercase slug'), { code: 'E_SOURCE_DEF' });
    return this.store.upsertSource(def);
  }
}

/**
 * Collect one batch from a source. `batch` selects a fixture by name; a real
 * adapter would use per-source query parameters. Returns the package row even
 * when the content type is wrong, so the failure is visible and stored.
 *
 * The collector does not queue detection: the caller decides when to detect
 * (normally the supervisor), so there is exactly one job per request.
 */
export async function collectBatch(store, root, source, { batch, revisionHint = null } = {}) {
  if (!source) throw Object.assign(new Error('unknown source'), { code: 'E_SOURCE_UNKNOWN' });
  if (!batch) throw Object.assign(new Error('batch name is required'), { code: 'E_BATCH' });
  const url = new URL(source.base_url);
  url.searchParams.set('batch', batch);
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    store.touchPoll(source.id, `collection failed: ${e.message}`);
    store.event('collection.error', { sourceId: source.id, message: `Could not reach ${source.label}: ${e.message}`, data: { batch } });
    throw Object.assign(new Error(`could not reach ${source.label}: ${e.message}`), { code: 'E_SOURCE_UNREACHABLE' });
  }
  const body = await res.text();
  store.touchPoll(source.id, `HTTP ${res.status} for ${batch}`);
  const headers = Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k, v]));

  if (!res.ok) {
    store.event('collection.error', {
      sourceId: source.id,
      message: `Source ${source.id} returned HTTP ${res.status} for ${batch}`,
      data: { batch, status: res.status, body: body.slice(0, 2000) },
    });
    throw Object.assign(new Error(`source ${source.id} returned HTTP ${res.status}`), { code: 'E_SOURCE_HTTP', status: res.status, body });
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    store.event('collection.error', {
      sourceId: source.id,
      message: `Source ${source.id} returned non-JSON for ${batch}`,
      data: { batch, error: e.message, body: body.slice(0, 2000) },
    });
    throw Object.assign(new Error(`source ${source.id} returned non-JSON`), { code: 'E_SOURCE_JSON' });
  }

  const revision = revisionHint ?? store.nextRevision(source.id, batch);
  const dir = join(root, 'data', 'raw', source.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${batch}.r${revision}.json`);
  writeFileSync(file, body, 'utf8');
  const pkg = store.createPackage({
    sourceId: source.id,
    batchName: batch,
    revision,
    rawPath: file,
    sha256: 'sha256:' + sha256(body),
    bytes: Buffer.byteLength(body),
    headers: { ...headers, 'x-collected-url': url.pathname + url.search },
  });
  return { package: store.getPackage(pkg.id), parsed_shape_hint: Array.isArray(parsed) ? 'array' : typeof parsed };
}
