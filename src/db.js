// SQLite storage. Every write goes through here so the API layer cannot invent
// half-states: packages, mappings, detection jobs, ingest runs and events all
// commit in one place, and provenance columns are never rewritten.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nowIso, newId } from './util.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 8000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  contact       TEXT,
  policy        TEXT NOT NULL DEFAULT 'per_field' CHECK (policy IN ('whole_source','per_field')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_poll_at  TEXT,
  last_poll_note TEXT
);

CREATE TABLE IF NOT EXISTS packages (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES sources(id),
  batch_name     TEXT NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 1,
  received_at    TEXT NOT NULL,
  raw_path       TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  http_headers   TEXT,
  status         TEXT NOT NULL,
  mapping_id     TEXT,
  current_run_id TEXT,
  detection_job_id TEXT,
  note           TEXT,
  updated_at     TEXT NOT NULL,
  UNIQUE (source_id, batch_name, revision)
);
CREATE INDEX IF NOT EXISTS packages_status ON packages(status, source_id);

CREATE TABLE IF NOT EXISTS mappings (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES sources(id),
  version           INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('draft','approved','superseded','revoked')),
  spec_json         TEXT NOT NULL,
  fingerprint       TEXT NOT NULL,
  notes_json        TEXT NOT NULL DEFAULT '{}',
  findings_json     TEXT NOT NULL DEFAULT '{}',
  origin_package_id TEXT,
  created_at        TEXT NOT NULL,
  approved_at       TEXT,
  approved_by       TEXT,
  revoked_at        TEXT,
  revoked_reason    TEXT,
  superseded_by     TEXT,
  UNIQUE (source_id, version)
);
CREATE INDEX IF NOT EXISTS mappings_source ON mappings(source_id, version);

CREATE TABLE IF NOT EXISTS detection_jobs (
  id          TEXT PRIMARY KEY,
  package_id  TEXT NOT NULL REFERENCES packages(id),
  source_id   TEXT NOT NULL REFERENCES sources(id),
  status      TEXT NOT NULL CHECK (status IN ('queued','running','done','crashed','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '{}',
  pid         INTEGER,
  queued_at   TEXT NOT NULL,
  started_at  TEXT,
  ended_at    TEXT,
  error       TEXT,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS detection_status ON detection_jobs(status, source_id);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id          TEXT PRIMARY KEY,
  package_id  TEXT NOT NULL REFERENCES packages(id),
  source_id   TEXT NOT NULL REFERENCES sources(id),
  mapping_id  TEXT NOT NULL,
  policy      TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','partial','quarantined','failed')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  stats_json  TEXT
);
CREATE INDEX IF NOT EXISTS ingest_package ON ingest_runs(package_id, started_at);

CREATE TABLE IF NOT EXISTS lines (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES ingest_runs(id),
  package_id    TEXT NOT NULL REFERENCES packages(id),
  source_id     TEXT NOT NULL REFERENCES sources(id),
  mapping_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  line_id       TEXT,
  sku           TEXT,
  description   TEXT,
  quantity      INTEGER,
  unit_price    TEXT,
  currency      TEXT,
  amount        TEXT,
  unit          TEXT,
  status        TEXT NOT NULL CHECK (status IN ('ok','partial','rejected')),
  applied       INTEGER NOT NULL DEFAULT 0,
  raw_pointer   TEXT NOT NULL,
  fields_json   TEXT NOT NULL,
  losses_json   TEXT NOT NULL,
  unmapped_json TEXT NOT NULL,
  changes_json  TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lines_run ON lines(run_id, seq);

CREATE TABLE IF NOT EXISTS line_current (
  source_id    TEXT NOT NULL REFERENCES sources(id),
  line_id      TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  package_id   TEXT NOT NULL,
  mapping_id   TEXT NOT NULL,
  status       TEXT NOT NULL,
  sku          TEXT,
  description  TEXT,
  quantity     INTEGER,
  unit_price   TEXT,
  currency     TEXT,
  amount       TEXT,
  unit         TEXT,
  fields_json  TEXT NOT NULL,
  losses_json  TEXT NOT NULL,
  unmapped_json TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (source_id, line_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  source_id   TEXT,
  package_id  TEXT,
  mapping_id  TEXT,
  message     TEXT NOT NULL,
  data_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_at ON events(at DESC);
`;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Small forward-only migrations for databases created by an earlier build.
 * (The demo deletes data/ between runs, but a running install must not break.)
 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(mappings)').all().map((c) => c.name);
  if (!cols.includes('superseded_by')) db.exec('ALTER TABLE mappings ADD COLUMN superseded_by TEXT');
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mappings'").get()?.sql ?? '';
  if (!ddl.includes("'superseded'")) {
    // SQLite cannot alter a CHECK constraint in place: rebuild the table.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE mappings_new (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','approved','superseded','revoked')),
        spec_json TEXT NOT NULL, fingerprint TEXT NOT NULL, notes_json TEXT NOT NULL DEFAULT '{}',
        findings_json TEXT NOT NULL DEFAULT '{}', origin_package_id TEXT, created_at TEXT NOT NULL,
        approved_at TEXT, approved_by TEXT, revoked_at TEXT, revoked_reason TEXT, superseded_by TEXT,
        UNIQUE (source_id, version))`);
      db.exec(`INSERT INTO mappings_new (id,source_id,version,status,spec_json,fingerprint,notes_json,findings_json,origin_package_id,created_at,approved_at,approved_by,revoked_at,revoked_reason)
        SELECT id,source_id,version,status,spec_json,fingerprint,notes_json,findings_json,origin_package_id,created_at,approved_at,approved_by,revoked_at,revoked_reason FROM mappings`);
      db.exec('DROP TABLE mappings');
      db.exec('ALTER TABLE mappings_new RENAME TO mappings');
      db.exec('CREATE INDEX IF NOT EXISTS mappings_source ON mappings(source_id, version)');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

export class Store {
  constructor(file) {
    this.file = file;
    this.db = openDb(file);
  }

  close() {
    this.db.close();
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  event(kind, { sourceId = null, packageId = null, mappingId = null, message, data = {} } = {}) {
    this.db
      .prepare(`INSERT INTO events (at, kind, source_id, package_id, mapping_id, message, data_json) VALUES (?,?,?,?,?,?,?)`)
      .run(nowIso(), kind, sourceId, packageId, mappingId, message ?? kind, JSON.stringify(data));
  }

  // ---------------------------------------------------------------- sources
  upsertSource({ id, label, kind, base_url, contact }) {
    const existing = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (existing) {
      this.db
        .prepare('UPDATE sources SET label=?, kind=?, base_url=?, contact=? WHERE id=?')
        .run(label ?? existing.label, kind ?? existing.kind, base_url ?? existing.base_url, contact ?? existing.contact, id);
      return this.getSource(id);
    }
    this.db
      .prepare('INSERT INTO sources (id,label,kind,base_url,contact,policy,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(id, label, kind ?? 'json', base_url, contact ?? null, 'per_field', nowIso());
    this.event('source.registered', { sourceId: id, message: `Source ${id} registered`, data: { base_url } });
    return this.getSource(id);
  }

  getSource(id) {
    return this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) ?? null;
  }

  listSources() {
    return this.db.prepare('SELECT * FROM sources ORDER BY id').all();
  }

  setPolicy(id, policy) {
    if (!['whole_source', 'per_field'].includes(policy)) throw new Error('invalid policy');
    this.db.prepare('UPDATE sources SET policy=? WHERE id=?').run(policy, id);
    this.event('source.policy', { sourceId: id, message: `Policy for ${id} set to ${policy}`, data: { policy } });
    return this.getSource(id);
  }

  touchPoll(id, note) {
    this.db.prepare('UPDATE sources SET last_poll_at=?, last_poll_note=? WHERE id=?').run(nowIso(), note ?? null, id);
  }

  // --------------------------------------------------------------- packages
  hasPackageContent(sourceId, batchName, digest) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM packages WHERE source_id=? AND batch_name=? AND sha256=? AND received_at > datetime('now','-1 day')")
        .get(sourceId, batchName, digest),
    );
  }

  createPackage({ sourceId, batchName, revision, rawPath, sha256, bytes, headers }) {
    const id = newId('pkg');
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO packages (id,source_id,batch_name,revision,received_at,raw_path,sha256,bytes,http_headers,status,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, sourceId, batchName, revision, at, rawPath, sha256, bytes, JSON.stringify(headers ?? {}), 'received', at);
    this.event('package.collected', {
      sourceId,
      packageId: id,
      message: `Collected ${sourceId}/${batchName} (${bytes} bytes)`,
      data: { sha256, revision },
    });
    return this.getPackage(id);
  }

  getPackage(id) {
    return this.db.prepare('SELECT * FROM packages WHERE id = ?').get(id) ?? null;
  }

  listPackages({ sourceId, limit = 100 } = {}) {
    if (sourceId) return this.db.prepare('SELECT * FROM packages WHERE source_id=? ORDER BY received_at DESC LIMIT ?').all(sourceId, limit);
    return this.db.prepare('SELECT * FROM packages ORDER BY received_at DESC LIMIT ?').all(limit);
  }

  packageByName(sourceId, batchName) {
    return this.db.prepare('SELECT * FROM packages WHERE source_id=? AND batch_name=? ORDER BY revision DESC LIMIT 1').get(sourceId, batchName) ?? null;
  }

  nextRevision(sourceId, batchName) {
    const row = this.db.prepare('SELECT MAX(revision) AS r FROM packages WHERE source_id=? AND batch_name=?').get(sourceId, batchName);
    return (row?.r ?? 0) + 1;
  }

  /**
   * Transition a package only if it is still in a pre-ingest state. Detection
   * finishing must not overwrite 'applied'/'partial': ingestion and detection
   * run concurrently and the ingested state is the more important one.
   */
  setPackageStatusIfPending(id, status, extra = {}) {
    const pkg = this.getPackage(id);
    if (!pkg) throw new Error('package not found');
    // 'incompatible' is a pre-ingest state: the package was refused by the
    // current mapping and is exactly the kind detection should be able to
    // reclassify as 'detected' or 'needs_mapping'. Applied/partial/quarantined
    // are ingest outcomes and are never overwritten by detection.
    const pending = ['received', 'queued_detection', 'detecting', 'needs_attention', 'needs_mapping', 'mapping_drafted', 'awaiting_mapping', 'detected', 'incompatible'];
    return pending.includes(pkg.status) ? this.setPackageStatus(id, status, extra) : pkg;
  }

  detectionSummaries(sourceId) {
    const rows = sourceId
      ? this.db.prepare('SELECT * FROM detection_jobs WHERE source_id=? ORDER BY queued_at DESC LIMIT 40').all(sourceId)
      : this.db.prepare('SELECT * FROM detection_jobs ORDER BY queued_at DESC LIMIT 40').all(sourceId);
    return rows.map((j) => {
      let result = null;
      try { result = j.result_json ? JSON.parse(j.result_json) : null; } catch { result = null; }
      return { ...j, result_json: undefined, result };
    });
  }

  setPackageStatus(id, status, { mappingId, runId, jobId, note } = {}) {
    const pkg = this.getPackage(id);
    if (!pkg) throw new Error('package not found');
    const next = {
      mapping_id: mappingId === undefined ? pkg.mapping_id : mappingId,
      current_run_id: runId === undefined ? pkg.current_run_id : runId,
      detection_job_id: jobId === undefined ? pkg.detection_job_id : jobId,
      note: note === undefined ? pkg.note : note,
    };
    this.db
      .prepare('UPDATE packages SET status=?, mapping_id=?, current_run_id=?, detection_job_id=?, note=?, updated_at=? WHERE id=?')
      .run(status, next.mapping_id, next.current_run_id, next.detection_job_id, next.note, nowIso(), id);
    this.event('package.status', { sourceId: pkg.source_id, packageId: id, message: `${pkg.batch_name}: ${pkg.status} → ${status}${note ? ` (${note})` : ''}`, data: { from: pkg.status, to: status } });
    return this.getPackage(id);
  }

  // --------------------------------------------------------------- mappings
  nextVersion(sourceId) {
    const row = this.db.prepare('SELECT MAX(version) AS v FROM mappings WHERE source_id=?').get(sourceId);
    return (row?.v ?? 0) + 1;
  }

  createMapping({ sourceId, spec, fingerprint, findings, originPackageId }) {
    const version = this.nextVersion(sourceId);
    const id = `${sourceId}@v${version}`;
    this.db
      .prepare(
        `INSERT INTO mappings (id,source_id,version,status,spec_json,fingerprint,notes_json,findings_json,origin_package_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, sourceId, version, 'draft', JSON.stringify(spec), fingerprint, JSON.stringify(spec.notes ?? {}), JSON.stringify(findings ?? {}), originPackageId ?? null, nowIso());
    this.event('mapping.drafted', {
      sourceId,
      packageId: originPackageId ?? null,
      mappingId: id,
      message: `Drafted mapping ${id}`,
      data: { fingerprint, findings },
    });
    return this.getMapping(id);
  }

  getMapping(id) {
    return this.db.prepare('SELECT * FROM mappings WHERE id = ?').get(id) ?? null;
  }

  listMappings(sourceId) {
    if (sourceId) return this.db.prepare('SELECT * FROM mappings WHERE source_id=? ORDER BY version').all(sourceId);
    return this.db.prepare('SELECT * FROM mappings ORDER BY source_id, version').all();
  }

  currentApproved(sourceId) {
    return this.db.prepare("SELECT * FROM mappings WHERE source_id=? AND status='approved' ORDER BY version DESC LIMIT 1").get(sourceId) ?? null;
  }

  approveMapping(id, by = 'operator') {
    const m = this.getMapping(id);
    if (!m) throw new Error('mapping not found');
    if (m.status === 'revoked') throw new Error('revoked mappings cannot be approved again; draft a new version');
    if (m.status === 'approved') return m;
    // A source has exactly one active mapping. Approving a new version retires
    // the previous one in the same transaction, so there is never a window in
    // which the source is unmapped. The old document is kept for audit and
    // replay; it is no longer used to read new packages.
    const previous = this.currentApproved(m.source_id);
    this.tx(() => {
      const at = nowIso();
      if (previous) {
        this.db.prepare("UPDATE mappings SET status='superseded', superseded_by=? WHERE id=? AND status='approved'").run(id, previous.id);
        this.event('mapping.superseded', {
          sourceId: m.source_id,
          mappingId: previous.id,
          message: `Superseded ${previous.id} with ${id}`,
          data: { replacement: id },
        });
      }
      this.db.prepare("UPDATE mappings SET status='approved', approved_at=?, approved_by=?, revoked_at=NULL, revoked_reason=NULL, superseded_by=NULL WHERE id=? AND status='draft'").run(at, by, id);
      this.event('mapping.approved', { sourceId: m.source_id, mappingId: id, message: `Approved ${id}${previous ? ` (supersedes ${previous.id})` : ''}`, data: { by, supersedes: previous?.id ?? null } });
    });
    return this.getMapping(id);
  }

  revokeMapping(id, reason) {
    const m = this.getMapping(id);
    if (!m) throw new Error('mapping not found');
    if (m.status !== 'approved') throw new Error(`only approved mappings can be revoked (status is ${m.status})`);
    this.db.prepare("UPDATE mappings SET status='revoked', revoked_at=?, revoked_reason=? WHERE id=?").run(nowIso(), reason ?? null, id);
    // Withdrawal is immediate and total: nothing else takes over. Packages
    // already ingested keep their lines; new collections for this source stop
    // at 'awaiting_mapping' until a replacement is approved.
    this.event('mapping.revoked', {
      sourceId: m.source_id,
      mappingId: id,
      message: `${id} revoked${reason ? `: ${reason}` : ''}; the source now has no active mapping`,
      data: { reason, replacement: this.currentApproved(m.source_id)?.id ?? null },
    });
    return this.getMapping(id);
  }

  // -------------------------------------------------------- detection jobs
  createDetectionJob(packageId, sourceId, options = {}) {
    const id = newId('job');
    this.db
      .prepare('INSERT INTO detection_jobs (id,package_id,source_id,status,attempts,options_json,queued_at) VALUES (?,?,?,?,0,?,?)')
      .run(id, packageId, sourceId, 'queued', JSON.stringify(options), nowIso());
    return this.getDetectionJob(id);
  }

  latestJobs(limit = 40) {
    return this.db
      .prepare(`SELECT j.*, p.batch_name, p.status AS package_status FROM detection_jobs j JOIN packages p ON p.id=j.package_id ORDER BY j.queued_at DESC LIMIT ?`)
      .all(limit);
  }

  getDetectionJob(id) {
    return this.db.prepare('SELECT * FROM detection_jobs WHERE id = ?').get(id) ?? null;
  }

  latestJobForPackage(packageId) {
    return this.db.prepare('SELECT * FROM detection_jobs WHERE package_id=? ORDER BY queued_at DESC LIMIT 1').get(packageId) ?? null;
  }

  runningJobs() {
    return this.db.prepare("SELECT * FROM detection_jobs WHERE status='running'").all();
  }

  queuedJobs() {
    return this.db.prepare("SELECT * FROM detection_jobs WHERE status='queued' ORDER BY queued_at").all();
  }

  markJobRunning(id, pid) {
    this.db.prepare("UPDATE detection_jobs SET status='running', started_at=? WHERE id=?").run(nowIso(), id);
  }

  finishJob(id, status, { result, error } = {}) {
    this.db
      .prepare('UPDATE detection_jobs SET status=?, ended_at=?, result_json=?, error=? WHERE id=?')
      .run(status, nowIso(), result ? JSON.stringify(result) : null, error ?? null, id);
  }

  requeueJob(id) {
    this.db.prepare("UPDATE detection_jobs SET status='queued', pid=NULL, error=NULL WHERE id=?").run(id);
  }

  // ----------------------------------------------------------- ingest runs
  createRun({ packageId, sourceId, mappingId, policy, trigger }) {
    const id = newId('run');
    this.db
      .prepare('INSERT INTO ingest_runs (id,package_id,source_id,mapping_id,policy,trigger,status,started_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, packageId, sourceId, mappingId, policy, trigger, 'running', nowIso());
    return this.db.prepare('SELECT * FROM ingest_runs WHERE id=?').get(id);
  }

  finishRun(id, status, stats) {
    this.db.prepare('UPDATE ingest_runs SET status=?, ended_at=?, stats_json=? WHERE id=?').run(status, nowIso(), JSON.stringify(stats ?? {}), id);
  }

  listRuns(packageId) {
    return this.db.prepare('SELECT * FROM ingest_runs WHERE package_id=? ORDER BY started_at').all(packageId);
  }

  getRun(id) {
    return this.db.prepare('SELECT * FROM ingest_runs WHERE id=?').get(id) ?? null;
  }

  addLine(row) {
    this.db
      .prepare(
        `INSERT INTO lines (id,run_id,package_id,source_id,mapping_id,seq,line_id,sku,description,quantity,unit_price,currency,amount,unit,status,applied,raw_pointer,fields_json,losses_json,unmapped_json,changes_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.run_id, row.package_id, row.source_id, row.mapping_id, row.seq,
        row.line_id ?? null, row.sku ?? null, row.description ?? null, row.quantity ?? null,
        row.unit_price ?? null, row.currency ?? null, row.amount ?? null, row.unit ?? null,
        row.status, row.applied ? 1 : 0, row.raw_pointer, JSON.stringify(row.fields), JSON.stringify(row.losses), JSON.stringify(row.unmapped), JSON.stringify(row.changes ?? []), nowIso(),
      );
  }

  upsertCurrent(row) {
    this.db
      .prepare(
        `INSERT INTO line_current (source_id,line_id,run_id,package_id,mapping_id,status,sku,description,quantity,unit_price,currency,amount,unit,fields_json,losses_json,unmapped_json,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source_id,line_id) DO UPDATE SET
           run_id=excluded.run_id, package_id=excluded.package_id, mapping_id=excluded.mapping_id,
           status=excluded.status, sku=excluded.sku, description=excluded.description,
           quantity=excluded.quantity, unit_price=excluded.unit_price, currency=excluded.currency,
           amount=excluded.amount, unit=excluded.unit, fields_json=excluded.fields_json,
           losses_json=excluded.losses_json, unmapped_json=excluded.unmapped_json, updated_at=excluded.updated_at`,
      )
      .run(
        row.source_id, row.line_id, row.run_id, row.package_id, row.mapping_id, row.status,
        row.sku ?? null, row.description ?? null, row.quantity ?? null, row.unit_price ?? null,
        row.currency ?? null, row.amount ?? null, row.unit ?? null,
        JSON.stringify(row.fields), JSON.stringify(row.losses), JSON.stringify(row.unmapped), nowIso(),
      );
  }

  linesForRun(runId) {
    return this.db.prepare('SELECT * FROM lines WHERE run_id=? ORDER BY seq').all(runId);
  }

  currentLines(sourceId) {
    return this.db.prepare('SELECT * FROM line_current WHERE source_id=? ORDER BY line_id').all(sourceId);
  }

  runLines(runId) {
    return this.linesForRun(runId);
  }

  currentLine(sourceId, lineId) {
    return this.db.prepare('SELECT * FROM line_current WHERE source_id=? AND line_id=?').get(sourceId, lineId) ?? null;
  }

  counts() {
    const pkg = this.db.prepare('SELECT status, COUNT(*) AS n FROM packages GROUP BY status').all();
    const src = this.db.prepare('SELECT COUNT(*) AS n FROM sources').get();
    return { packages: Object.fromEntries(pkg.map((r) => [r.status, r.n])), sources: src.n };
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }

  recentEvents(limit = 60) {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
  }

  sourceEvents(sourceId, limit = 100) {
    return this.db.prepare('SELECT * FROM events WHERE source_id=? ORDER BY id DESC LIMIT ?').all(sourceId, limit);
  }

  packagesAwaitingMapping(sourceId) {
    return this.db.prepare("SELECT * FROM packages WHERE source_id=? AND status='awaiting_mapping' ORDER BY received_at").all(sourceId);
  }

  /**
   * Packages a newly approved mapping should try to land: everything that has
   * not been cleanly applied — including 'partial', because a mapping that can
   * now read the previously lost fields is exactly what should repair it. A
   * package that is cleanly 'applied' is left alone; changing it is an explicit
   * replay decision, not a side effect of approval.
   */
  packagesPendingMapping(sourceId) {
    return this.db
      .prepare(
        `SELECT * FROM packages
         WHERE source_id=? AND status IN ('received','mapping_drafted','incompatible','awaiting_mapping','partial')
            OR (source_id=? AND status IN ('detected','needs_mapping','needs_attention','quarantined'))
         ORDER BY received_at`,
      )
      .all(sourceId, sourceId);
  }

  packagesForMapping(mappingId) {
    return this.db.prepare('SELECT * FROM packages WHERE mapping_id=? ORDER BY received_at').all(mappingId);
  }

  allPackages() {
    return this.db.prepare('SELECT * FROM packages ORDER BY received_at').all();
  }

  packagesByStatus(status, sourceId) {
    if (sourceId) return this.db.prepare('SELECT * FROM packages WHERE status=? AND source_id=? ORDER BY received_at').all(status, sourceId);
    return this.db.prepare('SELECT * FROM packages WHERE status=? ORDER BY received_at').all(status);
  }

  databaseFile() {
    return this.file;
  }
}

export function defaultDbPath(root) {
  return join(root, 'data', 'contract-gate.sqlite3');
}
