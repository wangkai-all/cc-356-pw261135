// Ingestion end. This module receives exactly one thing from the mapping layer:
// an approved, versioned mapping. It does not read the package JSON directly; it
// goes through buildReadPlan() first, which is the closed set of locations the
// mapping is allowed to touch. Anything the plan refuses stops the whole package
// for that mapping (see ingest.js for policy), so a new type can never silently
// be dropped here.
import { evaluateSelector, coerce, unmappedFields, selectorScope } from './spec.js';
import { newId } from './util.js';

function itemSeq(line) {
  return Number.isInteger(line.seq) ? line.seq : null;
}

export const LINE_FIELD_ORDER = ['line_id', 'sku', 'description', 'quantity', 'unit_price', 'currency', 'amount', 'unit'];

/**
 * Evaluate one line against a (validated, approved) mapping.
 *
 * Returns:
 *   status   ok | partial | rejected
 *   fields   per-field {status: mapped|absent|rejected, value, raw, origin, note}
 *   losses   information about anything that would otherwise be dropped silently
 *
 * A line is `rejected` when a required contract field has no value after coercion.
 * It is `partial` when any optional field failed. Missing values are recorded as
 * `absent`, never filled unless the mapping contains an explicit default step.
 */
export function evaluateLine(line, mapping, { bundle, seq }) {
  line = { ...line, seq };
  const fields = {};
  const losses = [];
  let rejected = false;
  let partial = false;
  for (const [field, rawSelector] of Object.entries(mapping.selectors)) {
    const result = evaluateSelector(line.value, bundle, rawSelector, field, { parent: line.parent ?? null, seq: itemSeq(line), key: line.key ?? null });
    const scope = selectorScope(rawSelector);
    const origin = {
      scope: scope.scope,
      path: scope.path,
      selector: rawSelector,
      sequence: seq,
      key: line.key,
    };
    if (result.state !== 'ok') {
      const missing = result.state === 'missing';
      fields[field] = {
        status: missing ? 'absent' : 'rejected',
        value: null,
        raw: result.raw ?? null,
        reason: result.reason ?? (missing ? 'not present' : 'could not read'),
        notes: result.notes,
        origin,
      };
      losses.push({
        field,
        kind: missing ? 'absent' : result.state,
        detail: result.notes.at(-1) ?? (missing ? 'value absent from source' : 'value unreadable'),
        raw: result.raw ?? null,
      });
      if (field === 'line_id' || field === 'sku') rejected = true;
      else partial = true;
      continue;
    }
    const c = coerce(field, result.value);
    if (!c.ok) {
      fields[field] = {
        status: 'rejected',
        value: null,
        raw: result.raw ?? null,
        reason: c.reason,
        notes: result.notes,
        origin,
      };
      losses.push({ field, kind: 'coercion', detail: `${c.reason}; raw value kept`, raw: result.raw ?? null });
      if (field === 'line_id' || field === 'sku') rejected = true;
      else partial = true;
      continue;
    }
    // A coercion note describes a representation change that preserves the
    // value (trailing zeros). It is recorded for provenance, not as a loss.
    if (c.note) losses.push({ field, kind: 'normalize', detail: c.note, raw: result.raw ?? null });
    // Normalization steps are provenance too: the value was reshaped by a
    // declared step, not damaged. Real losses are only absent/rejected/retained
    // and runtime type mismatches, which are recorded above.
    for (const n of result.notes) {
      if (/^(human_amount|unwrap|array_item|coalesce|default|derived_line_id|split|replace|number)\b/.test(n)) {
        losses.push({ field, kind: 'normalize', detail: n, raw: result.raw ?? null });
      }
    }
    // Currency discovered by the selector while reading this field overrides the
    // mapped currency field only when the field itself is not the currency field.
    fields[field] = { status: 'mapped', value: c.value, raw: result.raw ?? null, currency_hint: result.currency ?? null, notes: result.notes, origin };
  }

  const out = {};
  for (const f of LINE_FIELD_ORDER) out[f] = fields[f]?.value ?? null;

  return {
    status: rejected ? 'rejected' : partial ? 'partial' : 'ok',
    line_id: out.line_id,
    sku: out.sku,
    description: out.description,
    quantity: out.quantity,
    unit_price: out.unit_price,
    currency: out.currency,
    amount: out.amount,
    unit: out.unit,
    fields,
    losses,
    unmapped: unmappedFields(line.value, mapping),
  };
}

/** Compare the resulting line to what is currently stored, for the UI diff. */
export function computeChanges(prev, next) {
  if (!prev) return [{ field: '*', from: null, to: 'new line' }];
  const changes = [];
  for (const f of LINE_FIELD_ORDER) {
    const before = prev[f] ?? null;
    const after = next[f] ?? null;
    if (String(before) !== String(after)) changes.push({ field: f, from: before, to: after });
  }
  if (String(prev.status) !== String(next.status)) changes.push({ field: 'status', from: prev.status, to: next.status });
  return changes;
}

export function makeRunId() {
  return newId('run');
}
