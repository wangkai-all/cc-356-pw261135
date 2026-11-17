/* Contract Gate operator console.
   Plain ES modules, no build step. All contract semantics live on the server;
   this page renders server decisions and never re-derives a mapping. */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  view: 'sources', // sources | source | package | run | mappings | mapping | events
  data: null, // /api/state
  sourceId: null,
  packageId: null,
  packageDetail: null,
  runId: null,
  runDetail: null,
  mappingId: null,
  mappingDetail: null,
  batches: null,
  message: null,
  busy: new Set(),
};

const STATUS_TONE = {
  received: 'neutral',
  queued_detection: 'busy',
  detecting: 'busy',
  detected: 'ready',
  needs_mapping: 'warn',
  needs_attention: 'bad',
  awaiting_mapping: 'warn',
  mapping_drafted: 'ready',
  stalled: 'bad',
  applied: 'good',
  partial: 'warn',
  quarantined: 'bad',
  incompatible: 'bad',
  queued: 'busy',
  running: 'busy',
  done: 'good',
  crashed: 'bad',
  failed: 'bad',
  draft: 'neutral',
  approved: 'good',
  superseded: 'neutral',
  revoked: 'bad',
  ok: 'good',
  rejected: 'bad',
  absent: 'warn',
  mapped: 'good',
  retained: 'warn',
  coercion: 'warn',
  transform: 'neutral',
  normalize: 'neutral',
  type_mismatch: 'bad',
  missing: 'warn',
};

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const badge = (s) => `<span class="tag ${STATUS_TONE[s] ?? 'neutral'}">${esc(String(s ?? '').replaceAll('_', ' '))}</span>`;

const time = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { hour12: false }) : '—');

const bytes = (n) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`);

const shortSha = (s) => (s ? `${String(s).replace(/^sha256:/, '').slice(0, 16)}…` : '—');

const rawText = (v) => {
  if (v === undefined) return null;
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const CONTRACT_FIELDS = ['line_id', 'sku', 'description', 'quantity', 'unit_price', 'currency', 'amount', 'unit'];

// ------------------------------------------------------------------- transport

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message ?? `HTTP ${res.status}`);
    err.code = data.error;
    err.details = data.details;
    throw err;
  }
  return data;
}

function flash(text, tone = 'info', code = null) {
  state.message = { text, tone, code };
  render();
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => {
    state.message = null;
    render();
  }, tone === 'bad' ? 10000 : 6000);
}

async function run(key, fn) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  render();
  try {
    const out = await fn();
    await refresh();
    if (state.view === 'package') await loadPackage(state.packageId, { silent: true });
    return out;
  } catch (e) {
    flash(e.message, 'bad', e.code);
    return null;
  } finally {
    state.busy.delete(key);
    render();
  }
}

async function refresh() {
  state.data = await api('/api/state');
  render();
}

// ------------------------------------------------------------------ navigation

async function go(view, id = null) {
  state.view = view;
  if (view === 'source') state.sourceId = id;
  if (view === 'package') state.packageId = id;
  if (view === 'run') state.runId = id;
  if (view === 'mapping') state.mappingId = id;
  render();
  if (view === 'package') await loadPackage(id);
  if (view === 'run') await loadRun(id);
  if (view === 'mapping') await loadMapping(id);
  if (view === 'source' && !state.batches) await loadBatches();
}

async function loadPackage(id, { silent = false } = {}) {
  if (!silent) {
    state.packageDetail = null;
    render();
  }
  try {
    state.packageDetail = await api(`/api/packages/${id}`);
  } catch (e) {
    if (!silent) flash(e.message, 'bad', e.code);
    state.packageDetail = null;
  }
  render();
}

async function loadRun(id) {
  state.runDetail = null;
  render();
  try {
    state.runDetail = await api(`/api/runs/${id}`);
  } catch (e) {
    flash(e.message, 'bad', e.code);
  }
  render();
}

async function loadMapping(id) {
  state.mappingDetail = null;
  render();
  try {
    state.mappingDetail = await api(`/api/mappings/${id}`);
  } catch (e) {
    flash(e.message, 'bad', e.code);
  }
  render();
}

async function loadBatches() {
  try {
    const list = await api('/api/batches');
    state.batches = Object.fromEntries(list.map((x) => [x.source_id, x.batches]));
  } catch {
    state.batches = {};
  }
  render();
}

// ---------------------------------------------------------------------- render

function render() {
  document.body.classList.toggle('busy', state.busy.size > 0);
  $$('#tabs a').forEach((a) => {
    const active =
      a.dataset.view === state.view ||
      (state.view === 'source' && a.dataset.view === 'sources') ||
      (state.view === 'package' && a.dataset.view === 'sources') ||
      (state.view === 'run' && a.dataset.view === 'sources') ||
      (state.view === 'mapping' && a.dataset.view === 'mappings');
    a.classList.toggle('active', active);
  });
  renderMessage();
  if (!state.data) {
    $('#view').innerHTML = '<div class="empty big">Connecting…</div>';
    return;
  }
  renderAttention();
  const views = {
    sources: viewSources,
    source: viewSource,
    package: viewPackage,
    run: viewRun,
    mappings: viewMappings,
    mapping: viewMapping,
    events: viewEvents,
  };
  $('#view').innerHTML = (views[state.view] ?? viewSources)();
  bindActions();
}

function renderAttention() {
  const counts = state.data.counts?.packages ?? {};
  const n = Object.entries(counts)
    .filter(([k]) => !['applied', 'partial'].includes(k))
    .reduce((a, [, c]) => a + c, 0);
  const el = $('#attention-count');
  el.textContent = n ? `${n} needing attention` : '';
  el.className = n ? 'pill warn' : 'pill hidden';
}

function renderMessage() {
  const el = $('#message');
  if (!state.message) {
    el.className = 'message hidden';
    el.textContent = '';
    return;
  }
  el.className = `message ${state.message.tone}`;
  el.innerHTML = state.message.code
    ? `<strong class="mono">${esc(state.message.code)}</strong> ${esc(state.message.text)}`
    : esc(state.message.text);
}

// --------------------------------------------------------------------- sources

function viewSources() {
  const d = state.data;
  const rows = d.sources
    .map((s) => {
      const chips = {};
      for (const p of s.packages) chips[p.status] = (chips[p.status] ?? 0) + 1;
      return `<tr>
        <td><a href="#source" data-go="source" data-id="${esc(s.id)}"><strong>${esc(s.label)}</strong></a>
            <div class="mono dim small">${esc(s.id)}</div></td>
        <td>${s.current_mapping ? `<span class="mono good">${esc(s.current_mapping)}</span>` : '<span class="warn">none approved</span>'}</td>
        <td>${s.policy === 'whole_source' ? 'whole source' : 'per field'}</td>
        <td class="num">${s.packages.length}</td>
        <td>${Object.entries(chips).map(([k, n]) => badge(`${n} ${k}`)).join(' ')}</td>
        <td class="mono dim small">${time(s.last_poll_at)}</td>
      </tr>`;
    })
    .join('');
  const counts = d.counts?.packages ?? {};
  return `
  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>Sources</h2>
        <p class="hint">Every source has its own approved mapping and its own isolation policy. A package one mapping cannot read stops at that package — it never blocks the other sources.</p>
      </div>
      <div class="chipbar">${Object.entries(counts)
        .map(([k, n]) => badge(`${n} ${k}`))
        .join(' ') || '<span class="dim">no packages yet</span>'}</div>
    </div>
    <table class="grid">
      <thead><tr><th>Source</th><th>Approved mapping</th><th>Isolation</th><th class="num">Packages</th><th>Package states</th><th>Last poll</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="empty">No sources registered.</td></tr>'}</tbody>
    </table>
  </section>`;
}

function viewSource() {
  const d = state.data;
  const s = d.sources.find((x) => x.id === state.sourceId);
  if (!s) return '<div class="empty big">Source not found.</div>';
  const pkgs = [...s.packages].sort((a, b) => b.received_at.localeCompare(a.received_at));
  const mappings = d.mappings.filter((m) => m.source_id === s.id);
  const approved = mappings.filter((m) => m.status === 'approved');
  const drafts = mappings.filter((m) => m.status === 'draft');
  const retired = mappings.filter((m) => ['revoked', 'superseded'].includes(m.status));
  const batches = state.batches?.[s.id] ?? [];
  const events = d.events.filter((e) => e.source_id === s.id).slice(0, 15);

  return `
  <div class="crumb"><a href="#sources" data-go="sources">Sources</a> <span>/</span> ${esc(s.label)}</div>
  <section class="panel split">
    <div>
      <h2>${esc(s.label)}</h2>
      <p class="mono dim small">${esc(s.base_url)}</p>
      <div class="label">Isolation policy</div>
      <div class="segmented">
        <button data-policy="per_field" class="${s.policy === 'per_field' ? 'on' : ''}" ${state.busy.has('policy') ? 'disabled' : ''}>Per field</button>
        <button data-policy="whole_source" class="${s.policy === 'whole_source' ? 'on' : ''}" ${state.busy.has('policy') ? 'disabled' : ''}>Whole source</button>
      </div>
      <p class="hint">${
        s.policy === 'whole_source'
          ? 'Nothing from a package is applied unless every line passes the mapping. One bad line quarantines the package; it is kept and retried, never partially landed.'
          : 'Each line lands on its own. A field the mapping cannot read is marked as a loss (and the previous stored value is retained), instead of blocking the package.'
      }</p>
    </div>
    <div class="side">
      <div class="label">Active mapping</div>
      ${approved.length ? approved.map((m) => `<a class="mono good block" href="#mapping" data-go="mapping" data-id="${esc(m.id)}">${esc(m.id)}</a>`).join('') : '<div class="warn">none — new packages wait for approval</div>'}
      <div class="label">Drafts</div>
      ${drafts.length ? drafts.map((m) => `<a class="mono block" href="#mapping" data-go="mapping" data-id="${esc(m.id)}">${esc(m.id)}</a>`).join('') : '<span class="dim">none</span>'}
      <div class="label">Retired</div>
      ${retired.length ? retired.map((m) => `<span class="mono ${m.status === 'revoked' ? 'bad' : 'dim'} block">${esc(m.id)} · ${esc(m.status)}${m.superseded_by ? ` → ${esc(m.superseded_by)}` : ''}</span>`).join('') : '<span class="dim">none</span>'}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>Packages</h2>
        <p class="hint">Collection stores the exact response bytes and their digest, then queues detection. Raw bytes are never rewritten.</p>
      </div>
      <div class="actions">
        <select id="batch-picker" aria-label="Batch to collect">
          <option value="">choose a batch…</option>
          ${batches.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}
        </select>
        <button class="primary" data-collect-source="${esc(s.id)}" ${state.busy.has('collect') ? 'disabled' : ''}>Collect</button>
      </div>
    </div>
    <table class="grid">
      <thead><tr><th>Batch</th><th>State</th><th>Raw digest</th><th>Size</th><th>Received</th><th>Detection</th></tr></thead>
      <tbody>${
        pkgs
          .map((p) => {
            const job = p.detection_job_id ? state.data.jobs.find((j) => j.id === p.detection_job_id) : null;
            return `<tr>
            <td><a class="mono" href="#package" data-go="package" data-id="${esc(p.id)}">${esc(p.batch_name)}</a> <span class="dim mono small">r${p.revision}</span></td>
            <td>${badge(p.status)}${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}</td>
            <td class="mono dim small" title="${esc(p.sha256)}">${shortSha(p.sha256)}</td>
            <td class="mono dim small">${bytes(p.bytes)}</td>
            <td class="mono dim small">${time(p.received_at)}</td>
            <td>${job ? badge(job.status) : '<span class="dim">—</span>'}</td>
          </tr>`;
          })
          .join('') || '<tr><td colspan="6" class="empty">No packages yet. Pick a batch and collect it.</td></tr>'
      }</tbody>
    </table>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Recent events</h2><a class="small" href="#events" data-go="events">all events</a></div>
    <ul class="events">${events.map(eventItem).join('') || '<li class="dim">None.</li>'}</ul>
  </section>`;
}

// --------------------------------------------------------------------- package

function viewPackage() {
  const d = state.packageDetail;
  if (!d) return '<div class="empty big">Loading package…</div>';
  const p = d.package;
  const job = d.job;
  const candidates = d.candidates ?? [];
  const runs = d.runs ?? [];
  const best = d.best;
  const source = state.data.sources.find((s) => s.id === p.source_id);
  const approved = state.data.mappings.find((m) => m.source_id === p.source_id && m.status === 'approved');

  return `
  <div class="crumb"><a href="#sources" data-go="sources">Sources</a> <span>/</span>
    <a href="#source" data-go="source" data-id="${esc(p.source_id)}">${esc(source?.label ?? p.source_id)}</a> <span>/</span>
    <span class="mono">${esc(p.batch_name)} r${p.revision}</span></div>

  <section class="panel">
    <div class="panel-head">
      <div class="statusline">
        <h2 class="mono">${esc(p.batch_name)}</h2>
        ${badge(p.status)}
        ${p.note ? `<span class="note">${esc(p.note)}</span>` : ''}
      </div>
      <div class="actions">
        <button data-redetect="${esc(p.id)}" ${state.busy.has('detect') ? 'disabled' : ''}>Re-run detection</button>
        <button class="ghost" data-crash-detect="${esc(p.id)}" title="Runs detection with an injected process crash after the first collection">Crash detection (demo)</button>
        ${job && ['crashed', 'failed'].includes(job.status) ? `<button class="primary" data-retry="${esc(job.id)}" ${state.busy.has('retry') ? 'disabled' : ''}>Retry detection</button>` : ''}
      </div>
    </div>
    <dl class="kv">
      <dt>Raw package</dt><dd class="mono small">${esc(p.raw_path)} <span class="dim">${bytes(p.bytes)}</span></dd>
      <dt>Digest</dt><dd class="mono dim small">${esc(p.sha256)}</dd>
      <dt>Received</dt><dd class="small">${time(p.received_at)}</dd>
      <dt>Detection</dt><dd>${
        job
          ? `${badge(job.status)} <span class="dim small">pid ${job.pid ?? '—'} · attempts ${job.attempts}${job.options?.crash_after ? ` · injected crash after ${job.options.crash_after}` : ''}</span>${job.error ? `<div class="note bad mono">${esc(job.error)}</div>` : ''}`
          : '<span class="dim">not run</span>'
      }</dd>
      ${
        job?.existing_check
          ? `<dt>Approved mapping vs this package</dt><dd>${
              job.existing_check.ok
                ? `<span class="tag good">compatible</span> <span class="mono small">${esc(job.existing_check.mapping)}</span>`
                : `<span class="tag warn">would refuse</span> <span class="mono small">${esc(job.existing_check.mapping)}</span>`
            }${(job.existing_check.problems ?? [])
              .slice(0, 4)
              .map((x) => `<div class="note mono small ${x.severity === 'fatal' ? 'bad' : ''}">${esc(x.code)} ${esc(x.detail)}</div>`)
              .join('')}</dd>`
          : ''
      }
      <dt>Inspect</dt><dd>
        <button class="ghost" data-show-raw="${esc(p.id)}">Original bytes</button>
        <button class="ghost" data-show-plan="${esc(p.id)}">Read plan</button>
        ${
          approved
            ? `<button class="ghost" data-replay="${esc(p.id)}" ${state.busy.has('replay') ? 'disabled' : ''}>Replay with ${esc(approved.id)}</button>`
            : ''
        }
      </dd>
    </dl>
    <pre id="inspect" class="inspect hidden"></pre>
  </section>

  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>Proposed mappings</h2>
        <p class="hint">Detection proposes complete mapping documents and scores each against this exact package. A proposal is offered only if its read plan accepts the package. Findings record everything that stays raw-only.</p>
      </div>
    </div>
    <div class="cards">${candidates.map(candidateCard).join('') || '<div class="empty">No proposal was derivable. The package waits for a hand-written mapping below; it does not block the source or the other sources.</div>'}</div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Ingest runs</h2></div>
    ${runs.length ? runTable(runs) : '<div class="empty">No ingest run has been attempted for this package.</div>'}
  </section>

  <section class="panel">
    <details>
      <summary><strong>Write a mapping by hand</strong> <span class="dim small">(needed when no structural proposal exists — e.g. packed-string lines)</span></summary>
      <p class="hint">The document must satisfy <span class="mono">cg.map/1</span>. Drafting stores it as a new version for ${esc(p.source_id)}; approval is a separate step. $key is the object-map key of the line and $seq its position.</p>
      <textarea id="hand-spec" spellcheck="false" rows="22"></textarea>
      <div class="actions">
        <button class="primary" data-hand-draft="${esc(p.id)}" ${state.busy.has('hand') ? 'disabled' : ''}>Draft hand-written mapping</button>
        <span class="dim small">the server validates before storing; approval will refuse an invalid document</span>
      </div>
    </details>
  </section>`;

  function candidateCard(c) {
    const errs = c.validation?.errors ?? [];
    const probs = c.coverage?.problems ?? [];
    const notes = c.notes ?? [];
    const usable = c.ok;
    return `<article class="card ${usable ? '' : 'card-bad'}">
      <header>
        <strong>${esc(c.label)}</strong>
        ${c.index === best ? '<span class="tag info">best</span>' : ''}
        ${usable ? '<span class="tag good">plan ok</span>' : '<span class="tag bad">refused</span>'}
        <span class="dim small">confidence ${Math.round((c.confidence ?? 0) * 100)}%</span>
      </header>
      <div class="small dim">${esc(c.family)} · ${c.coverage?.line_count ?? '—'} line(s) · ${(c.coverage?.locations ?? []).length} read location(s)</div>
      ${
        errs.length || probs.length
          ? `<ul class="findings">${[...errs.map((x) => ({ ...x, severity: 'fatal' })), ...probs]
              .map((x) => `<li><span class="mono ${x.severity === 'fatal' ? 'bad' : 'warn'}">${esc(x.code ?? 'E')}</span> ${esc(x.detail)}</li>`)
              .join('')}</ul>`
          : ''
      }
      ${
        notes.length
          ? `<ul class="findings notes">${notes
              .map((n) => `<li><span class="mono dim">${esc(n.code ?? 'note')}</span> ${esc(n.detail)}</li>`)
              .join('')}</ul>`
          : ''
      }
      <details><summary class="small">selectors</summary><pre class="inspect">${esc(JSON.stringify(c.spec?.selectors ?? {}, null, 2))}</pre></details>
      <footer>
        <button class="primary" data-draft="${esc(p.id)}" data-candidate="${c.index}" ${usable && !state.busy.has('draft') ? '' : 'disabled'} ${usable ? '' : 'title="Refused proposals cannot be drafted"'}>Draft this mapping</button>
      </footer>
    </article>`;
  }
}

function runTable(runs) {
  return `<table class="grid">
    <thead><tr><th>Run</th><th>Mapping</th><th>Trigger</th><th>Result</th><th>Lines</th><th>Started</th></tr></thead>
    <tbody>${runs
      .map((r) => {
        const st = r.stats ?? {};
        return `<tr>
          <td><a class="mono" href="#run" data-go="run" data-id="${esc(r.id)}">${esc(r.id)}</a></td>
          <td class="mono small">${esc(r.mapping_id)}</td>
          <td class="small">${esc(r.trigger)}</td>
          <td>${badge(r.status)}</td>
          <td class="small mono dim">${st.lines_total ?? 0} lines · ${st.applied ?? 0} ok · ${st.partial ?? 0} partial · ${st.rejected ?? 0} rejected · ${st.quarantined ?? 0} quarantined</td>
          <td class="small mono dim">${time(r.started_at)}</td>
        </tr>`;
      })
      .join('')}</tbody>
  </table>`;
}

// ------------------------------------------------------------------------- run

function viewRun() {
  const d = state.runDetail;
  if (!d) return '<div class="empty big">Loading run…</div>';
  const run = d.run;
  const stats = d.stats ?? {};
  const total = stats.lines_total ?? d.lines.length;
  const counts = { ok: 0, partial: 0, rejected: 0 };
  for (const l of d.lines) counts[l.status] = (counts[l.status] ?? 0) + 1;
  const byField = stats.by_field ?? {};
  const lossEntries = Object.entries(byField);
  return `
  <div class="crumb"><a href="#sources" data-go="sources">Sources</a> <span>/</span>
    <a href="#package" data-go="package" data-id="${esc(run.package_id)}">package</a> <span>/</span>
    run <span class="mono">${esc(run.id)}</span></div>

  <section class="panel">
    <div class="panel-head">
      <div class="statusline"><h2>Run ${esc(run.id)}</h2>${badge(run.status)}</div>
      <div class="small dim">${time(run.started_at)} → ${time(run.ended_at)}</div>
    </div>
    <dl class="kv">
      <dt>Mapping</dt><dd><a class="mono" href="#mapping" data-go="mapping" data-id="${esc(run.mapping_id)}">${esc(run.mapping_id)}</a> <span class="mono dim small">${esc(stats.mapping_fingerprint ?? '')}</span></dd>
      <dt>Policy / trigger</dt><dd>${esc(run.policy)} · ${esc(run.trigger)}</dd>
      <dt>Result</dt><dd>${badge(run.status)} ${stats.reason ? `<span class="note">${esc(stats.reason)}</span>` : ''}</dd>
      <dt>Usable records</dt><dd>
        <strong>${counts.ok + counts.partial}</strong> of ${total} line(s) applied
        <span class="dim small">— ${counts.ok} complete, ${counts.partial} with losses${counts.rejected ? `, ${counts.rejected} rejected` : ''}${stats.quarantined ? `, ${stats.quarantined} held by whole-source policy` : ''}</span>
      </dd>
      ${
        lossEntries.length
          ? `<dt>Losses by field</dt><dd class="small">${lossEntries
              .map(([field, kinds]) => `<span class="mono">${esc(field)}</span> ${Object.entries(kinds).map(([k, n]) => badge(`${n} ${k}`)).join(' ')}`)
              .join('<br>')}</dd>`
          : ''
      }
      <dt>Read plan</dt><dd class="small">${
        stats.plan ? `${stats.plan.ok ? '<span class="tag good">accepted</span>' : '<span class="tag bad">refused</span>'} <span class="dim">${(stats.plan.problems ?? []).length} problem(s)</span>` : '<span class="dim">not recorded</span>'
      }</dd>
    </dl>
  </section>

  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>Lines: original value → ingested value</h2>
        <p class="hint">Each contract cell shows the value stored now (top) and the exact value read from the source package (bottom). A cell marked <span class="tag warn">absent</span> was missing, <span class="tag bad">rejected</span> could not be read, or <span class="tag good">mapped</span> was read. Nothing is filled or rounded silently.</p>
      </div>
    </div>
    ${linesTable(d.lines)}
  </section>`;
}

const fieldReason = (field) => {
  if (!field) return '';
  if (field.reason) return field.reason;
  if (field.status === 'absent') return 'not present';
  return '';
};

function linesTable(lines) {
  if (!lines.length) return '<div class="empty">No line rows were stored for this run.</div>';
  return `<div class="scroll"><table class="grid lines">
    <thead><tr><th>#</th><th>State</th>${CONTRACT_FIELDS.map((f) => `<th>${esc(f)}</th>`).join('')}<th>Losses · unmapped source fields</th></tr></thead>
    <tbody>${lines
      .map((l) => {
        const cells = CONTRACT_FIELDS.map((f) => {
          const field = l.fields?.[f];
          const status = field?.status ?? (l[f] == null ? 'absent' : 'mapped');
          const raw = field?.raw;
          return `<td class="cell">
            <div class="stored ${status}">${l[f] == null ? '<span class="dim">—</span>' : esc(l[f])}</div>
            <div class="rawval" title="value as it appeared in the source">${raw === undefined || raw === null ? '<span class="dim">not in source</span>' : esc(rawText(raw))}</div>
            <div class="cellfoot">${badge(status)}${
              status !== 'mapped' && fieldReason(field) ? ` <span class="why">${esc(fieldReason(field))}</span>` : ''
            }</div>
          </td>`;
        });
        const losses = l.losses ?? [];
        const unmapped = l.unmapped ?? [];
        return `<tr>
          <td class="mono dim">${l.seq}</td>
          <td>${badge(l.status)}${l.applied ? '' : '<div class="note small">not applied</div>'}</td>
          ${cells.join('')}
          <td class="cell losses">
            ${losses.length ? `<ul>${losses
              .map((x) => `<li>${badge(x.kind)} <span class="mono small">${esc(x.field)}</span> ${esc(x.detail)}${x.raw !== undefined && x.raw !== null ? ` <span class="mono dim small">raw ${esc(rawText(x.raw))}</span>` : ''}</li>`)
              .join('')}</ul>` : '<span class="dim small">none</span>'}
            ${unmapped.length ? `<details><summary class="small">${unmapped.length} source field(s) not mapped</summary><ul>${unmapped
                .slice(0, 40)
                .map((u) => `<li class="mono dim small">${esc(u.path)} <span class="dim">(${esc(u.kind)})</span></li>`)
                .join('')}</ul></details>` : ''}
            ${l.changes?.length ? `<details><summary class="small">${l.changes.length} change(s) vs stored</summary><ul>${l.changes
                .map((c) => `<li class="mono small">${esc(c.field)}: ${esc(rawText(c.from))} → ${esc(rawText(c.to))}</li>`)
                .join('')}</ul></details>` : ''}
          </td>
        </tr>`;
      })
      .join('')}</tbody>
  </table></div>`;
}

// -------------------------------------------------------------------- mappings

function viewMappings() {
  const d = state.data;
  const rows = d.mappings
    .map(
      (m) => `<tr>
      <td><a class="mono" href="#mapping" data-go="mapping" data-id="${esc(m.id)}">${esc(m.id)}</a></td>
      <td>${esc(m.source_id)}</td>
      <td>${badge(m.status)}</td>
      <td class="mono dim small" title="${esc(m.fingerprint ?? '')}">${shortSha(m.fingerprint)}</td>
      <td class="small">${m.approved_at ? `${time(m.approved_at)}<div class="dim">by ${esc(m.approved_by ?? '—')}</div>` : time(m.created_at)}</td>
      <td>${m.revoked_reason ? `<span class="note">${esc(m.revoked_reason)}</span>` : ''}</td>
      <td class="right">${
        m.status === 'draft'
          ? `<button class="primary" data-approve="${esc(m.id)}" ${state.busy.has('approve:' + m.id) ? 'disabled' : ''}>Approve &amp; apply</button>
             <button class="ghost" data-delete="${esc(m.id)}">Discard</button>`
          : m.status === 'approved'
            ? `<button class="danger" data-revoke="${esc(m.id)}" ${state.busy.has('revoke:' + m.id) ? 'disabled' : ''}>Revoke</button>`
            : ''
      }</td>
    </tr>`,
    )
    .join('');
  return `
  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>Mappings</h2>
        <p class="hint">A mapping is a versioned document, not code. Approval activates it for its source and lands every pending package it can read. Revocation is immediate: from then on, new packages wait instead of being read with a withdrawn contract.</p>
      </div>
    </div>
    <table class="grid">
      <thead><tr><th>Mapping</th><th>Source</th><th>State</th><th>Fingerprint</th><th>Created / approved</th><th>Revocation</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="empty">No mappings yet. Collect a package, then draft a proposal.</td></tr>'}</tbody>
    </table>
  </section>`;
}

function viewMapping() {
  const d = state.mappingDetail;
  if (!d) return '<div class="empty big">Loading mapping…</div>';
  const m = d.mapping;
  const spec = d.spec;
  const related = state.data.sources.find((s) => s.id === m.source_id)?.packages ?? [];
  const affected = related.filter((p) => p.mapping_id === m.id);
  return `
  <div class="crumb"><a href="#mappings" data-go="mappings">Mappings</a> <span>/</span> <span class="mono">${esc(m.id)}</span></div>
  <section class="panel">
    <div class="panel-head">
      <div class="statusline"><h2 class="mono">${esc(m.id)}</h2>${badge(m.status)}</div>
      <div class="actions">
        ${
          m.status === 'draft'
            ? `<button class="primary" data-approve="${esc(m.id)}" ${state.busy.has('approve:' + m.id) ? 'disabled' : ''}>Approve &amp; apply pending packages</button>
               <button class="ghost" data-delete="${esc(m.id)}">Discard</button>`
            : m.status === 'approved'
              ? `<button class="danger" data-revoke="${esc(m.id)}" ${state.busy.has('revoke:' + m.id) ? 'disabled' : ''}>Revoke</button>`
              : ''
        }
      </div>
    </div>
    <dl class="kv">
      <dt>Source</dt><dd><a href="#source" data-go="source" data-id="${esc(m.source_id)}">${esc(m.source_id)}</a></dd>
      <dt>Spec</dt><dd class="mono small">${esc(spec.spec)} · version ${m.version}</dd>
      <dt>Fingerprint</dt><dd class="mono dim small">${esc(m.fingerprint ?? '')}</dd>
      <dt>Created</dt><dd class="small">${time(m.created_at)}</dd>
      ${m.approved_at ? `<dt>Approved</dt><dd class="small">${time(m.approved_at)} by ${esc(m.approved_by ?? '—')}</dd>` : ''}
      ${m.revoked_at ? `<dt>Revoked</dt><dd class="small">${time(m.revoked_at)}<div class="note">${esc(m.revoked_reason ?? 'no reason recorded')}</div></dd>` : ''}
      ${m.superseded_by ? `<dt>Superseded by</dt><dd><a class="mono" href="#mapping" data-go="mapping" data-id="${esc(m.superseded_by)}">${esc(m.superseded_by)}</a></dd>` : ''}
      ${
        affected.length
          ? `<dt>Packages using it</dt><dd class="small mono">${affected.map((p) => `${esc(p.batch_name)} (${esc(p.status)})`).join(', ')}</dd>`
          : ''
      }
    </dl>
  </section>
  ${
    m.findings?.validation && m.findings.validation.ok === false
      ? `<section class="panel"><h2>Validation problems at draft time</h2><ul class="findings">${m.findings.validation.errors
          .map((x) => `<li><span class="mono bad">${esc(x.code)}</span> ${esc(x.detail)}</li>`)
          .join('')}</ul></section>`
      : ''
  }
  ${
    (m.findings?.findings ?? []).length
      ? `<section class="panel"><h2>Detection findings</h2><ul class="findings">${m.findings.findings
          .map((x) => `<li><span class="mono warn">${esc(x.code)}</span> ${esc(x.detail)}</li>`)
          .join('')}</ul></section>`
      : ''
  }
  <section class="panel">
    <div class="panel-head"><h2>Mapping document</h2><span class="dim small">selectors are the entire set of locations the ingestion end may read</span></div>
    <pre class="inspect visible">${esc(JSON.stringify(spec, null, 2))}</pre>
  </section>`;
}

// ---------------------------------------------------------------------- events

function viewEvents() {
  const d = state.data;
  const kinds = new Map();
  for (const e of d.events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  return `
  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>Event log</h2>
        <p class="hint">Every state change with its reason: collection, detection, worker crashes, approvals, revocations, ingest runs and replays.</p>
      </div>
      <div class="chipbar">${[...kinds.entries()].map(([k, n]) => `<span class="pill">${esc(k)} ${n}</span>`).join(' ')}</div>
    </div>
    <ul class="events long">${d.events.map(eventItem).join('') || '<li class="dim">No events yet.</li>'}</ul>
  </section>`;
}

function eventItem(e) {
  return `<li>
    <span class="mono dim small">${time(e.at)}</span>
    <span class="kind mono">${esc(e.kind)}</span>
    <span>${esc(e.message)}</span>
  </li>`;
}

// --------------------------------------------------------------------- actions

function bindActions() {
  $$('[data-go]').forEach((el) => {
    el.onclick = (ev) => {
      ev.preventDefault();
      go(el.dataset.go, el.dataset.id ?? null);
    };
  });

  $$('[data-policy]').forEach((el) => {
    el.onclick = () =>
      run('policy', async () => {
        const r = await api(`/api/sources/${state.sourceId}/policy`, { method: 'PATCH', body: { policy: el.dataset.policy } });
        flash(`Policy for ${r.source.id} is now ${r.source.policy === 'whole_source' ? 'whole source' : 'per field'}. It applies to the next ingest or replay.`, 'info');
      });
  });

  const collectSource = $('[data-collect-source]');
  if (collectSource) {
    collectSource.onclick = () => {
      const batch = $('#batch-picker')?.value;
      if (!batch) return flash('Choose a batch first.', 'warn', 'E_BATCH');
      run('collect', async () => {
        const r = await api('/api/collect', { body: { source_id: collectSource.dataset.collectSource, batch } });
        flash(
          `${batch} collected. ${
            r.ingest?.status ? `Ingest: ${r.ingest.status}${r.ingest.stats ? ` (${r.ingest.stats.applied} ok, ${r.ingest.stats.partial} partial, ${r.ingest.stats.rejected} rejected)` : ''}.` : 'No approved mapping yet, so it waits.'
          } Detection ${r.job?.status ?? 'queued'}.`,
          'info',
        );
      });
    };
  }

  $$('[data-redetect]').forEach((el) => {
    el.onclick = () =>
      run('detect', async () => {
        await api('/api/detect', { body: { package_id: el.dataset.redetect } });
        flash('Detection queued.', 'info');
      });
  });

  $$('[data-crash-detect]').forEach((el) => {
    el.onclick = () =>
      run('detect', async () => {
        await api('/api/detect', { body: { package_id: el.dataset.crashDetect, crash_after: 1 } });
        flash('Detection queued with an injected crash after the first collection. Watch the job and the package state.', 'warn', 'DEMO');
      });
  });

  $$('[data-retry]').forEach((el) => {
    el.onclick = () =>
      run('retry', async () => {
        await api(`/api/jobs/${el.dataset.retry}/retry`, { body: {} });
        flash('Detection retried. The package was untouched by the crash; no bytes changed.', 'info');
      });
  });

  $$('[data-draft]').forEach((el) => {
    el.onclick = () =>
      run('draft', async () => {
        const r = await api('/api/mappings/draft', { body: { package_id: el.dataset.draft, candidate: Number(el.dataset.candidate) } });
        flash(`Drafted ${r.mapping.id}. It is not active until you approve it.`, 'info');
      });
  });

  $$('[data-approve]').forEach((el) => {
    el.onclick = () =>
      run('approve:' + el.dataset.approve, async () => {
        const r = await api(`/api/mappings/${el.dataset.approve}/approve`, { body: { by: 'operator' } });
        const landed = (r.applied ?? []).filter((a) => a.status === 'ok' || a.status === 'partial').length;
        flash(`Approved ${r.mapping.id}. ${landed ? `Landed ${landed} pending package(s).` : 'No pending package could be landed.'}`, landed ? 'info' : 'warn');
      });
  });

  $$('[data-revoke]').forEach((el) => {
    el.onclick = () => {
      const reason = prompt(`Revoke ${el.dataset.revoke}?\n\nReason (recorded in the audit log):`, 'withdrawn after supplier format review');
      if (reason === null) return;
      run('revoke:' + el.dataset.revoke, async () => {
        const r = await api(`/api/mappings/${el.dataset.revoke}/revoke`, { body: { reason } });
        flash(`${r.mapping.id} revoked. New packages for ${r.mapping.source_id} will wait for a replacement mapping; already-ingested lines stay as they are.`, 'info');
      });
    };
  });

  $$('[data-delete]').forEach((el) => {
    el.onclick = () => {
      if (!confirm(`Discard draft ${el.dataset.delete}? The document is removed; its event stays in the log.`)) return;
      run('delete', async () => {
        await api(`/api/mappings/${el.dataset.delete}/delete`, { body: {} });
        flash('Draft discarded.', 'info');
        state.view = 'mappings';
        state.mappingDetail = null;
      });
    };
  });

  const rawBtn = $('[data-show-raw]');
  if (rawBtn) rawBtn.onclick = () => inspect(`/api/packages/${rawBtn.dataset.showRaw}/raw`, (r) => `sha256 ${r.sha256}\n${r.path}\n\n${r.raw}`);
  const planBtn = $('[data-show-plan]');
  if (planBtn) planBtn.onclick = () => inspect(`/api/packages/${planBtn.dataset.showPlan}/plan`, (r) => JSON.stringify(r.plan, null, 2));

  $$('[data-replay]').forEach((el) => {
    el.onclick = () =>
      run('replay', async () => {
        const r = await api('/api/ingest/replay', { body: { package_id: el.dataset.replay, reason: 'replay from stored raw package' } });
        flash(`Replayed from the stored bytes. New run ${r.runId}: ${r.status} (${r.stats.applied} ok, ${r.stats.partial} partial, ${r.stats.rejected} rejected).`, 'info');
      });
  });

  const hand = $('[data-hand-draft]');
  if (hand) {
    const box = $('#hand-spec');
    box.value = handTemplate();
    hand.onclick = () => {
      let spec;
      try {
        spec = JSON.parse(box.value);
      } catch (e) {
        return flash(`Mapping is not valid JSON: ${e.message}`, 'bad', 'E_JSON');
      }
      run('hand', async () => {
        const r = await api('/api/mappings/draft', { body: { package_id: hand.dataset.handDraft, spec } });
        const errors = r.validation?.errors ?? [];
        if (!r.validation?.ok) {
          flash(`Drafted ${r.mapping.id}, but it is invalid: ${errors.map((x) => `${x.code} ${x.detail}`).join('; ')}. Approval will refuse it.`, 'bad', 'E_MAPPING_INVALID');
        } else {
          flash(`Drafted ${r.mapping.id} from the hand-written document. Review it, then approve.`, 'info');
        }
      });
    };
  }
}

function inspect(path, format) {
  const el = $('#inspect');
  if (!el) return;
  el.classList.remove('hidden');
  el.textContent = 'Loading…';
  api(path)
    .then((r) => {
      el.textContent = format(r);
    })
    .catch((e) => {
      el.textContent = `${e.code ?? 'ERROR'}: ${e.message}`;
    });
}

/** A worked template for a package whose lines are packed strings. */
function handTemplate() {
  const sourceId = state.data.sources.find((s) => s.packages.some((p) => p.id === state.packageId))?.id ?? 'source';
  return JSON.stringify(
    {
      spec: 'cg.map/1',
      source_id: sourceId,
      version: 1,
      label: 'packed string rows, hand-written',
      lines: { path: 'lines', mode: 'object_of_objects' },
      selectors: {
        line_id: { path: '', target: 'string', steps: [{ derived_line_id: { parts: ['$key'] } }] },
        sku: { path: '', target: 'string', steps: [{ split: '|' }, { array_item: 0 }] },
        quantity: { path: '', target: 'integer', steps: [{ split: '|' }, { array_item: 1 }, { number: true }] },
        unit_price: { path: '', target: 'decimal', steps: [{ split: '|' }, { array_item: 2 }, { number: true }] },
        currency: { path: 'root.currency', target: 'string', steps: [{ currency: true }, { case: 'upper' }] },
      },
      notes: {},
    },
    null,
    2,
  );
}

// ------------------------------------------------------------------------ boot

window.addEventListener('hashchange', () => {
  const [view] = location.hash.slice(1).split('/');
  if (['sources', 'mappings', 'events'].includes(view) && state.view !== view) {
    state.view = view;
    render();
  }
});

api('/api/state')
  .then((d) => {
    state.data = d;
    render();
    return loadBatches();
  })
  .catch((e) => {
    $('#view').innerHTML = `<div class="empty big">Could not reach the API: ${esc(e.message)}</div>`;
  });

setInterval(() => {
  if (document.hidden) return;
  refresh().catch(() => {});
  if (state.view === 'package' && state.packageId) loadPackage(state.packageId, { silent: true }).catch(() => {});
}, 4000);
