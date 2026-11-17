// Package-level ingestion and the isolation policy.
//
// Policy is per source, chosen by the operator:
//
//   per_field    A line that fails one optional field is stored with that field
//                marked 'absent'/'rejected' and the rest of the line intact. Other
//                lines in the same package are unaffected. A line missing line_id
//                or sku is not applied to current state but is still recorded.
//
//   whole_source Nothing from a package is applied unless every line passes the
//                read plan and every line's required fields resolve. The package
//                is quarantined as a unit; nothing partially lands.
//
// Both modes keep the raw package untouched, record the run, and never apply a
// line whose mapping is not approved. Replay runs against the stored raw bytes,
// not a re-fetch, so the outcome is reproducible.
import { readFileSync } from 'node:fs';
import { buildReadPlan } from './spec.js';
import { evaluateLine, computeChanges, makeRunId, LINE_FIELD_ORDER } from './line-eval.js';
import { newId, nowIso, sha256 } from './util.js';

export class IngestError extends Error {
  constructor(message, { code = 'E_INGEST', details, status = 409 } = {}) {
    super(message);
    this.code = code;
    this.details = details;
    // Every IngestError is a refused precondition (bytes changed, mapping not
    // approved, wrong source), not a server fault.
    this.status = status;
  }
}

/**
 * Read and verify stored raw bytes. Any mismatch aborts: ingestion never works
 * from a re-fetched or edited copy.
 */
export function readVerifiedPackage(store, pkg) {
  let text;
  try {
    text = readFileSync(pkg.raw_path, 'utf8');
  } catch (e) {
    throw new IngestError(`raw package file is unreadable: ${e.message}`, { code: 'E_RAW_MISSING' });
  }
  const digest = 'sha256:' + sha256(text);
  if (digest !== pkg.sha256) {
    throw new IngestError(`raw package bytes changed since collection (expected ${pkg.sha256}, found ${digest})`, { code: 'E_RAW_CHANGED' });
  }
  try {
    return { bundle: JSON.parse(text), text, digest };
  } catch (e) {
    throw new IngestError(`raw package is not valid JSON: ${e.message}`, { code: 'E_RAW_JSON' });
  }
}

/**
 * Run one package through one approved mapping.
 * Returns a summary; never throws for per-line problems, only for preconditions.
 */
export function ingestPackage(store, { pkg, mapping, policy, trigger = 'collect' }) {
  if (mapping.status !== 'approved') {
    throw new IngestError(`mapping ${mapping.id} is ${mapping.status}, not approved`, { code: 'E_MAPPING_NOT_APPROVED' });
  }
  if (mapping.source_id !== pkg.source_id) {
    throw new IngestError(`mapping ${mapping.id} belongs to ${mapping.source_id}, not ${pkg.source_id}`, { code: 'E_MAPPING_SOURCE' });
  }
  const spec = JSON.parse(mapping.spec_json);
  const { bundle } = readVerifiedPackage(store, pkg);
  const plan = buildReadPlan(spec, bundle);

  const runId = makeRunId();
  const startedAt = nowIso();
  const run = store.createRun({ packageId: pkg.id, sourceId: pkg.source_id, mappingId: mapping.id, policy, trigger });
  const stats = {
    mapping_id: mapping.id,
    mapping_fingerprint: mapping.fingerprint,
    policy,
    trigger,
    plan: {
      ok: plan.ok,
      problems: plan.problems,
      locations: plan.locations,
      notes: plan.notes,
      lines: plan.lines?.items.length ?? 0,
    },
    lines_total: 0,
    applied: 0,
    partial: 0,
    rejected: 0,
    quarantined: 0,
    by_field: {},
    package_status: null,
    reason: null,
  };

  const finish = (status, extra = {}) => {
    Object.assign(stats, extra);
    store.finishRun(run.id, status, stats);
    store.event('ingest.run', {
      sourceId: pkg.source_id,
      packageId: pkg.id,
      mappingId: mapping.id,
      message: `Ingest ${trigger} of ${pkg.batch_name} with ${mapping.id}: ${status} (${stats.applied} applied, ${stats.partial} partial, ${stats.rejected} rejected)`,
      data: { run_id: run.id, status, stats: { applied: stats.applied, partial: stats.partial, rejected: stats.rejected, policy } },
    });
    return { runId: run.id, status, stats };
  };

  const fatal = plan.fatal === true || plan.problems.some((p) => p.severity === 'fatal');
  // A plan with 'line' problems can still be executed only when the policy can
  // degrade per field. Under whole_source, any refusal quarantines the package.
  const lineProblems = plan.problems.filter((p) => p.severity === 'line');
  const refusedByPolicy = !fatal && lineProblems.length > 0 && policy === 'whole_source';
  if (fatal || refusedByPolicy) {
    // The plan is the contract. It refused this package with this mapping: never
    // guess, never drop the offending fields to force the rest through. The
    // package keeps its raw bytes and waits for a mapping that can read it.
    const status = fatal && policy === 'whole_source' ? 'quarantined' : fatal ? 'failed' : 'quarantined';
    const pkgStatus = fatal ? 'incompatible' : 'quarantined';
    const reason = refusedByPolicy
      ? `whole_source policy: ${lineProblems[0].field} cannot be read by this mapping; the package was quarantined as a unit and nothing was applied`
      : plan.problems[0]?.detail ?? 'read plan refused this package';
    store.setPackageStatus(pkg.id, pkgStatus, {
      mappingId: mapping.id,
      runId: run.id,
      note: `read plan refused this package: ${reason}`,
    });
    stats.package_status = pkgStatus;
    stats.reason = reason;
    stats.lines_total = plan.lines?.items.length ?? 0;
    if (!fatal) stats.quarantined = plan.lines?.items.length ?? 0;
    return finish(status, { package_status: pkgStatus });
  }

  const items = plan.lines.items;
  stats.lines_total = items.length;
  const results = [];
  for (const item of items) {
    const ev = evaluateLine(item, spec, { bundle, seq: item.seq });
    results.push({ item, ev });
  }

  const lineRows = [];
  const priorLines = new Map();
  for (const { item, ev } of results) {
    // Replay and re-ingest compare against live state and against earlier lines
    // in the same run, so a second run of one package is a no-op rather than a
    // self-diff.
    const prev = ev.line_id ? (store.currentLine(pkg.source_id, ev.line_id) ?? priorLines.get(ev.line_id) ?? null) : null;
    const current = { ...ev };
    // Per-field degradation keeps the last good value in current state rather
    // than nulling it. The run row still records the fresh (unreadable) value and
    // the retention, so nothing is hidden.
    if (prev && policy === 'per_field') {
      for (const field of LINE_FIELD_ORDER) {
        if (field === 'line_id') continue;
        const status = ev.fields[field]?.status;
        if (status && status !== 'mapped' && prev[field] !== null && prev[field] !== undefined) {
          current[field] = prev[field];
          ev.losses.push({
            field,
            kind: 'retained',
            detail: `this package could not supply ${field}; previous value ${JSON.stringify(prev[field])} retained`,
            raw: ev.fields[field]?.raw ?? null,
          });
        }
      }
    }
    if (ev.line_id) priorLines.set(ev.line_id, { ...current });
    const changes = computeChanges(prev, current);
    // per_field: every non-rejected line lands with its own losses marked.
    // whole_source: decided below; rows are stored for inspection, applied only
    // if every line is clean.
    const applied = policy === 'per_field' ? ev.status !== 'rejected' : ev.status === 'ok';
    const row = {
      id: newId('line'),
      run_id: run.id,
      package_id: pkg.id,
      source_id: pkg.source_id,
      mapping_id: mapping.id,
      seq: item.seq,
      line_id: current.line_id,
      sku: current.sku,
      description: current.description,
      quantity: current.quantity,
      unit_price: current.unit_price,
      currency: current.currency,
      amount: current.amount,
      unit: current.unit,
      status: ev.status,
      applied,
      raw_pointer: `pkg:${pkg.id}#lines[${item.seq}]${item.parentPath ? `@${item.parentPath}` : ''}`,
      fields: ev.fields,
      losses: ev.losses,
      unmapped: ev.unmapped,
      changes,
    };
    lineRows.push(row);
    stats[ev.status === 'ok' ? 'applied' : ev.status === 'partial' ? 'partial' : 'rejected']++;
    if (changes.length) stats.changed = (stats.changed ?? 0) + 1;
    for (const loss of ev.losses) {
      // Normalization is provenance, not damage: keep it per-line but out of the
      // loss summary so "what was lost" stays answerable at a glance.
      if (loss.kind === 'normalize') continue;
      stats.by_field[loss.field] = stats.by_field[loss.field] ?? {};
      stats.by_field[loss.field][loss.kind] = (stats.by_field[loss.field][loss.kind] ?? 0) + 1;
    }
  }

  const wholeBlocked = policy === 'whole_source' && results.some((r) => r.ev.status !== 'ok');
  if (wholeBlocked) {
    // Quarantine as a unit: keep rows for inspection, apply nothing.
    for (const row of lineRows) {
      row.applied = false;
      store.addLine(row);
    }
    stats.quarantined = lineRows.length;
    store.setPackageStatus(pkg.id, 'quarantined', { mappingId: mapping.id, runId: run.id, note: 'whole_source policy: at least one line failed; nothing applied' });
    stats.package_status = 'quarantined';
    stats.reason = 'whole_source policy: at least one line failed; nothing applied';
    return finish('quarantined');
  }

  store.tx(() => {
    for (const row of lineRows) {
      store.addLine(row);
      if (row.applied) store.upsertCurrent(row);
    }
  });

  const status = stats.rejected === 0 && stats.partial === 0 ? 'ok' : 'partial';
  store.setPackageStatus(pkg.id, status === 'ok' ? 'applied' : 'partial', {
    mappingId: mapping.id,
    runId: run.id,
    note: status === 'ok' ? null : `${stats.partial} partial, ${stats.rejected} rejected`,
  });
  stats.package_status = status === 'ok' ? 'applied' : 'partial';
  return finish(status);
}

/**
 * After collection, land the package with the source's approved mapping if there
 * is one. This is what makes normal operation independent of detection: an
 * approved mapping keeps ingesting new packages even while a new mapping is
 * being drafted. Refusals stay per package and never touch other sources.
 */
export function ingestIfMapped(store, pkg) {
  const mapping = store.currentApproved(pkg.source_id);
  if (!mapping) {
    store.setPackageStatus(pkg.id, 'awaiting_mapping', { note: 'no approved mapping for this source yet' });
    return { status: 'awaiting_mapping', reason: 'no approved mapping' };
  }
  const policy = store.getSource(pkg.source_id)?.policy ?? 'per_field';
  try {
    return ingestPackage(store, { pkg, mapping, policy, trigger: 'collect' });
  } catch (e) {
    store.setPackageStatus(pkg.id, 'incompatible', { mappingId: mapping.id, note: e.message });
    store.event('ingest.error', { sourceId: pkg.source_id, packageId: pkg.id, mappingId: mapping.id, message: `Could not ingest ${pkg.batch_name}: ${e.message}`, data: { code: e.code } });
    return { status: 'failed', reason: e.message, code: e.code };
  }
}

/**
 * Replay: re-ingest the stored raw package with a mapping. The mapping may be a
 * different version than the original run; that is the point of replay. It
 * appends a new run so old vs. new is auditable and nothing is destroyed.
 */
export function replayPackage(store, { pkg, mapping, policy, reason }) {
  const out = ingestPackage(store, { pkg, mapping, policy, trigger: 'replay' });
  store.event('ingest.replay', {
    sourceId: pkg.source_id,
    packageId: pkg.id,
    mappingId: mapping.id,
    message: `Replayed ${pkg.batch_name} with ${mapping.id} (${out.status})${reason ? `: ${reason}` : ''}`,
    data: { run_id: out.runId, reason, status: out.status },
  });
  return out;
}

/**
 * Reapply everything a mapping was originally responsible for, after approval.
 * Only packages that were collected but never successfully applied with this
 * exact mapping are touched; successfully applied packages are not re-applied
 * unless the caller explicitly asks for a replay.
 */
export function applyApprovedMapping(store, mapping) {
  const spec = JSON.parse(mapping.spec_json);
  const policy = store.getSource(mapping.source_id)?.policy ?? 'per_field';
  const candidates = store.packagesPendingMapping(mapping.source_id);
  const out = [];
  for (const pkg of candidates) {
    const plan = (() => {
      try {
        const { bundle } = readVerifiedPackage(store, pkg);
        return buildReadPlan(spec, bundle);
      } catch (e) {
        return { ok: false, problems: [{ code: e.code ?? 'E_RAW', detail: e.message }] };
      }
    })();
    if (!plan.ok) {
      // Leave it queued for a future mapping, but say why so it is not invisible.
      store.setPackageStatus(pkg.id, 'awaiting_mapping', {
        note: `mapping ${mapping.id} cannot read this package: ${plan.problems[0]?.detail ?? 'unknown'}`,
      });
      out.push({ packageId: pkg.id, batch: pkg.batch_name, status: 'still_awaiting', reason: plan.problems[0]?.detail });
      continue;
    }
    const res = ingestPackage(store, { pkg, mapping, policy, trigger: 'approval' });
    out.push({ packageId: pkg.id, batch: pkg.batch_name, status: res.status, runId: res.runId });
  }
  return out;
}
