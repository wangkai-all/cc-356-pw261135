// Detection supervisor. Runs detection workers as real child processes, so a
// crash is observable and recoverable:
//
//   * a worker that exits non-zero is marked 'crashed'; the package keeps its
//     prior state and stays visible as needing attention
//   * a worker whose PID disappears (server restarted, machine rebooted) is
//     marked 'crashed' by the sweeper, never silently stuck in 'running'
//   * a crashed job can be retried; retries are counted and bounded
//
// The supervisor never mutates a package's mapping: it only fills the job result.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const MAX_ATTEMPTS = 3;

export class DetectionSupervisor {
  constructor({ store, root, dbFile, workerPath = null, log = () => {} }) {
    this.store = store;
    this.root = root;
    this.dbFile = dbFile;
    this.explicitWorkerPath = workerPath;
    this.log = log;
    this.children = new Map();
    this.killChildren = [];
    this.closed = false;
  }

  workerPath() {
    return this.explicitWorkerPath ?? join(this.root, 'src', 'detect-worker.js');
  }

  /** Queue and immediately try to start a job for a package. */
  requestDetection(pkg, options = {}) {
    const job = this.store.createDetectionJob(pkg.id, pkg.source_id, options);
    this.store.setPackageStatusIfPending(pkg.id, 'queued_detection', { jobId: job.id });
    this.store.event('detection.queued', {
      sourceId: pkg.source_id,
      packageId: pkg.id,
      message: `Detection queued for ${pkg.batch_name}`,
      data: { job_id: job.id, options },
    });
    this.start(job.id);
    return this.store.getDetectionJob(job.id);
  }

  start(jobId) {
    const job = this.store.getDetectionJob(jobId);
    if (!job) return null;
    if (job.status !== 'queued') return job;
    if (job.attempts >= MAX_ATTEMPTS) {
      this.store.finishJob(jobId, 'failed', { error: `gave up after ${job.attempts} attempts` });
      this.store.event('detection.gave_up', {
        sourceId: job.source_id,
        packageId: job.package_id,
        message: `Detection for job ${job.id} gave up after ${job.attempts} attempts`,
      });
      return this.store.getDetectionJob(jobId);
    }
    const options = safeJson(job.options_json);
    const child = spawn(process.execPath, [this.workerPath(), jobId, this.dbFile], {
      env: { ...process.env, DETECT_CRASH_AFTER: String(options.crash_after ?? process.env.DETECT_CRASH_AFTER ?? '') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.set(jobId, child);
    // The worker marks the job running once it has checked the queue state, so a
    // fast crash between spawn and claim is still visible as 'queued'. We only
    // attach the pid and count the attempt here.
    this.store.db.prepare('UPDATE detection_jobs SET pid=?, attempts=attempts+1 WHERE id=?').run(child.pid, jobId);
    this.store.event('detection.started', {
      sourceId: job.source_id,
      packageId: job.package_id,
      message: `Detection worker started for job ${job.id} (pid ${child.pid})`,
      data: { job_id: jobId, pid: child.pid, attempt: job.attempts + 1 },
    });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.stdout.on('data', (d) => this.log(`[detect ${jobId}] ${d.toString().trim()}`));

    child.on('exit', (code, signal) => {
      this.children.delete(jobId);
      // A child may outlive shutdown by a few milliseconds; the store is gone by
      // then and there is nothing left to record.
      if (this.closed) return;
      const fresh = this.store.getDetectionJob(jobId);
      if (!fresh) return;
      if (fresh.status === 'done' || fresh.status === 'failed') {
        // Worker already recorded its own outcome.
      } else if (code === 0) {
        // Exit zero without a result is a bug, not a success.
        this.store.finishJob(jobId, 'failed', { error: 'worker exited 0 without recording a result' });
      } else {
        const reason = signal ? `killed by ${signal}` : `exit code ${code}`;
        this.store.finishJob(jobId, 'crashed', { error: `worker ${reason}${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}` });
        const pkg = this.store.getPackage(fresh.package_id);
        if (pkg && ['queued_detection', 'detecting'].includes(pkg.status)) {
          this.store.setPackageStatusIfPending(pkg.id, 'needs_attention', { jobId, note: `detection crashed (${reason}); package untouched` });
        }
        this.store.event('detection.crashed', {
          sourceId: fresh.source_id,
          packageId: fresh.package_id,
          message: `Detection crashed for job ${jobId} (${reason}); package left untouched`,
          data: { job_id: jobId, code, signal, stderr: stderr.slice(-2000) },
        });
      }
    });
    child.on('error', (e) => {
      this.children.delete(jobId);
      if (this.closed) return;
      this.store.finishJob(jobId, 'failed', { error: `could not spawn worker: ${e.message}` });
    });
    return child;
  }

  /**
   * Startup sweep: running jobs whose PID is gone are crashed, queued jobs are
   * started, and packages stuck in queued_detection get a fresh job. This is what
   * makes a server restart mid-detection recoverable instead of wedged.
   */
  sweep() {
    const recovered = [];
    for (const job of this.store.runningJobs()) {
      if (job.pid && pidAlive(job.pid)) continue;
      this.store.finishJob(job.id, 'crashed', { error: `worker process ${job.pid ?? '(unknown)'} disappeared (server restart or external kill)` });
      const pkg = this.store.getPackage(job.package_id);
      if (pkg) {
        // Same rule as a live crash: detection only owns a package while it is
        // still in a pre-ingest state. A package that ingestion already landed
        // keeps its 'applied'/'partial' status even if a later detection job for
        // it was orphaned.
        this.store.setPackageStatusIfPending(pkg.id, 'needs_attention', { jobId: job.id, note: 'detection worker disappeared; package untouched' });
        this.store.event('detection.recovered', {
          sourceId: job.source_id,
          packageId: pkg.id,
          message: `Detected orphaned detection job ${job.id} for ${pkg.batch_name}; marked crashed`,
          data: { job_id: job.id, pid: job.pid },
        });
        recovered.push({ package: pkg.id, job: job.id });
      }
    }
    for (const job of this.store.queuedJobs()) this.start(job.id);
    return recovered;
  }

  retry(jobId) {
    const job = this.store.getDetectionJob(jobId);
    if (!job) throw Object.assign(new Error('job not found'), { code: 'E_JOB' });
    if (job.status !== 'crashed' && job.status !== 'failed') {
      throw Object.assign(new Error(`only crashed or failed jobs can be retried (job is ${job.status})`), { code: 'E_JOB_STATE' });
    }
    if (job.attempts >= MAX_ATTEMPTS) {
      throw Object.assign(new Error(`job ${jobId} already used ${job.attempts} attempts`), { code: 'E_JOB_ATTEMPTS' });
    }
    // The crash injection is a one-shot demo/test option: a retry is a normal
    // run, so clearing it is what makes "crash, then retry" finish rather than
    // crash forever. Re-request the crash explicitly to test it again.
    const options = { ...safeJson(job.options_json), crash_after: 0 };
    this.store.db
      .prepare("UPDATE detection_jobs SET status='queued', ended_at=NULL, error=NULL, result_json=NULL, options_json=? WHERE id=?")
      .run(JSON.stringify(options), jobId);
    const pkg = this.store.getPackage(job.package_id);
    if (pkg) this.store.setPackageStatus(pkg.id, 'queued_detection', { jobId, note: null });
    this.store.event('detection.retried', { sourceId: job.source_id, packageId: job.package_id, message: `Retrying detection job ${jobId}`, data: { job_id: jobId, attempt: job.attempts + 1 } });
    this.start(jobId);
    return this.store.getDetectionJob(jobId);
  }

  shutdown() {
    this.closed = true;
    for (const [id, child] of this.children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      this.children.delete(id);
    }
  }

  /** Wait for all running children to exit (used by tests). */
  async drain(timeoutMs = 15000) {
    const waits = [...this.children.values()].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once('exit', resolve);
          setTimeout(resolve, timeoutMs).unref?.();
        }),
    );
    await Promise.all(waits);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
