// Structure detection. Runs as a separate process so that a crash is a real
// process death, not a handled throw: the parent sees a non-zero exit and the
// package keeps its previous state until an operator retries.
//
// Usage: node src/detect-worker.js <jobId> <dbFile>
//
// The worker never writes packages or lines. It reads the raw package, proposes
// candidate mappings, scores them against the captured package and stores the
// result on the job. Approval and ingestion remain operator/server actions.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Store } from './db.js';
import { deriveCandidates } from './detect.js';
import { buildReadPlan, validateMapping } from './spec.js';
import { sha256 } from './util.js';

const [jobId, dbFile] = process.argv.slice(2);
if (!jobId || !dbFile) {
  console.error('usage: detect-worker <jobId> <dbFile>');
  process.exit(2);
}

const store = new Store(dbFile);
const job = store.getDetectionJob(jobId);
if (!job) {
  console.error(`job ${jobId} not found`);
  process.exit(2);
}
if (job.status !== 'queued') {
  console.error(`job ${jobId} is ${job.status}, not queued`);
  process.exit(3);
}

store.markJobRunning(jobId, process.pid);
const pkg = store.getPackage(job.package_id);
if (!pkg) {
  store.finishJob(jobId, 'failed', { error: 'package row missing' });
  process.exit(4);
}

let bundle;
try {
  const text = readFileSync(pkg.raw_path, 'utf8');
  const digest = 'sha256:' + createHash('sha256').update(text).digest('hex');
  if (digest !== pkg.sha256) {
    store.finishJob(jobId, 'failed', { error: `raw package digest mismatch: expected ${pkg.sha256}, read ${digest}` });
    store.event('detection.digest_mismatch', { sourceId: job.source_id, packageId: pkg.id, message: `Detection refused ${pkg.batch_name}: raw bytes changed since collection`, data: { expected: pkg.sha256, actual: digest } });
    process.exit(5);
  }
  bundle = JSON.parse(text);
} catch (e) {
  store.finishJob(jobId, 'failed', { error: `unreadable package: ${e.message}` });
  store.setPackageStatusIfPending(pkg.id, 'stalled', { jobId, note: 'package unreadable' });
  process.exit(6);
}

// Optional crash injection for the demo and tests: crash after this many lines of
// analysis, leaving no result behind.
const crashAfter = Number(process.env.DETECT_CRASH_AFTER ?? '0');

const existing = store.currentApproved(job.source_id);
const candidates = deriveCandidates(bundle, {
  sourceId: job.source_id,
  baseVersion: existing ? existing.version : 0,
  crashAfter: Number.isFinite(crashAfter) && crashAfter > 0 ? crashAfter : 0,
});

const scored = candidates.map((candidate) => {
  const validation = validateMapping(candidate.spec);
  const plan = validation.ok ? buildReadPlan(candidate.spec, bundle) : null;
  return {
    spec: candidate.spec,
    label: candidate.label,
    family: candidate.family,
    confidence: candidate.confidence,
    notes: candidate.notes ?? [],
    validation: { ok: validation.ok, errors: validation.errors },
    coverage: plan
      ? {
          ok: plan.ok,
          problems: plan.problems,
          locations: plan.locations,
          observations: plan.observations,
          line_count: plan.lines?.items.length ?? 0,
        }
      : null,
  };
});

const best = [...scored].filter((s) => s.validation.ok && s.coverage?.ok).sort((a, b) => b.confidence - a.confidence)[0] ?? null;
// If a mapping is already approved for this source, its read plan against this
// package is the decisive answer: a compatible new package needs no new mapping.
let existingCheck = null;
if (existing) {
  const existingSpec = JSON.parse(existing.spec_json);
  const plan = buildReadPlan(existingSpec, bundle);
  existingCheck = { mapping: existing.id, ok: plan.ok, problems: plan.problems, notes: plan.notes };
}

const result = {
  detected_at: new Date().toISOString(),
  pid: process.pid,
  existing_mapping: existing ? { id: existing.id, version: existing.version, fingerprint: existing.fingerprint } : null,
  existing_check: existingCheck,
  candidates: scored,
  best: best ? scored.indexOf(best) : null,
};

store.finishJob(jobId, 'done', { result });
if (best && existingCheck && !existingCheck.ok) {
  // The active mapping refuses this package, but a newer proposal can read it.
  // Nothing lands until that proposal is approved, so the package is explicitly
  // waiting rather than looking usable.
  store.setPackageStatusIfPending(pkg.id, 'awaiting_mapping', {
    jobId,
    note: `active mapping ${existingCheck.mapping} cannot read this package; candidate "${best.label}" ready for approval`,
  });
} else if (best && !existing) {
  store.setPackageStatusIfPending(pkg.id, 'awaiting_mapping', {
    jobId,
    note: `candidate "${best.label}" ready — approve a mapping to land this package`,
  });
} else if (best) {
  store.setPackageStatusIfPending(pkg.id, 'detected', { jobId, note: null });
} else {
  // Detection ran fine but nothing it could propose is executable. The package
  // waits for a hand-written mapping; it does not block its source or others.
  store.setPackageStatusIfPending(pkg.id, 'needs_mapping', { jobId, note: 'no proposed mapping can read this package; a hand-written mapping is required' });
}
store.event('detection.done', {
  sourceId: job.source_id,
  packageId: pkg.id,
  message: `Detected ${scored.length} candidate mapping(s) for ${pkg.batch_name}; ${best ? `best ${best.label}` : 'none usable — package waits for a mapping'}`,
  data: { job_id: jobId, candidates: scored.map((s) => ({ label: s.label, ok: s.validation.ok && s.coverage?.ok, confidence: s.confidence })) },
});
store.close();
