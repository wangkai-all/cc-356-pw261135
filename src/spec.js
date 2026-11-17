// The agreement between structure detection and the ingestion end.
//
// A versioned mapping (DMAP-1) is a JSON document. It is executable only when it
// satisfies this spec; the server refuses to approve anything else. Two layers:
//
//   validateMapping(mapping)        document shape, field names, selectors,
//                                   documented aliasing, required fields.
//   buildReadPlan(mapping, bundle)  resolves every selector against a captured
//                                   package and lists exactly which locations are
//                                   read, with observed kinds. Refuses absent paths
//                                   and conversions that would silently change data.
//
// Selector paths are relative to a line object. A path prefixed with "root."
// reads a batch-level value (e.g. a shared invoice currency). Nothing here writes
// state or auto-drops data: unmapped source fields are reported separately so the
// UI can show what was intentionally not ingested.
//
// Validation errors are structured {code, field, detail} so the UI can show them
// and tests can assert without matching prose.

import { isPlainObject, sha256, stableStringify } from './util.js';

export const SPEC_VERSION = 'cg.map/1';

export const CONTRACT_FIELDS = [
  { name: 'line_id', type: 'string', required: true, note: 'Stable per-line identity for upsert/dedupe.' },
  { name: 'sku', type: 'string', required: true, note: 'Catalog key after SKU cleanup.' },
  { name: 'description', type: 'string', required: false, note: 'Human-readable line text.' },
  { name: 'quantity', type: 'integer', required: false, note: 'Integer count; fractional input is rejected, never rounded.' },
  { name: 'unit_price', type: 'decimal', required: false, note: 'Money in the source currency, canonical 2dp text.' },
  { name: 'currency', type: 'string', required: false, note: 'ISO-4217-style code, uppercase.' },
  { name: 'amount', type: 'decimal', required: false, note: 'Line total in the source currency, canonical 2dp text.' },
  { name: 'unit', type: 'string', required: false, note: 'Unit of measure ("case", "each", ...).' },
];

export const FIELD_NAMES = new Set(CONTRACT_FIELDS.map((f) => f.name));
export const REQUIRED_FIELDS = CONTRACT_FIELDS.filter((f) => f.required).map((f) => f.name);
const FIELD_SPEC = Object.fromEntries(CONTRACT_FIELDS.map((f) => [f.name, f]));

const TARGET_TYPES = {
  string: ['string', 'currency'],
  integer: ['integer'],
  decimal: ['decimal'],
};

const SOURCE_ID_RE = /^[a-z][a-z0-9_]{0,40}$/;
const NUMERIC_STEPS = new Set(['number', 'human_amount']);

/**
 * Problem severities:
 *   fatal  the mapping cannot be executed against this package at all
 *   line   individual lines/fields may fail; policy decides whether that is
 *          acceptable (per_field degrades, whole_source quarantines)
 */
const FATAL = 'fatal';
const LINE = 'line';

function err(code, field, detail) {
  return { code, field: field ?? null, detail };
}

// ------------------------------------------------------------ selectors

export function normalizeSelector(sel) {
  if (typeof sel === 'string') return { path: sel };
  return sel;
}

/** Path grammar: dotted keys / array positions. */
export function parsePath(path) {
  if (typeof path !== 'string') throw Object.assign(new Error('path must be a string'), { code: 'E_PATH' });
  if (path === '') return [];
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(path)) {
    throw Object.assign(new Error(`unparseable path ${JSON.stringify(path)}`), { code: 'E_PATH' });
  }
  return path.split('.');
}

/**
 * Line collection path grammar: `orders.*.lines`. At most one `*`, which stands
 * for one array element and makes that object available to selectors as
 * "parent.<path>". The final token names the per-line collection inside it.
 * A path without `*` reads a collection from the document root.
 */
export function parseLinesPath(path) {
  if (typeof path !== 'string' || path === '') throw Object.assign(new Error('lines.path must be a non-empty path'), { code: 'E_LINES_PATH' });
  const parts = path.split('.');
  if (parts.filter((p) => p === '*').length > 1) throw Object.assign(new Error('lines.path may contain at most one wildcard'), { code: 'E_LINES_PATH' });
  const star = parts.indexOf('*');
  if (star === 0) throw Object.assign(new Error('lines.path cannot start with a wildcard'), { code: 'E_LINES_PATH' });
  if (star === parts.length - 1) throw Object.assign(new Error('lines.path must end with the line collection name, not a wildcard'), { code: 'E_LINES_PATH' });
  for (const p of parts) {
    if (p === '*') continue;
    if (!/^[A-Za-z0-9_-]+$/.test(p)) throw Object.assign(new Error(`unparseable path token ${JSON.stringify(p)}`), { code: 'E_LINES_PATH' });
  }
  return parts;
}

export function arrayItemSteps(selector) {
  const sel = normalizeSelector(selector);
  const out = [];
  if (!isPlainObject(sel) || !Array.isArray(sel.steps)) return out;
  sel.steps.forEach((s, i) => {
    if (isPlainObject(s) && Object.keys(s).length === 1 && Number.isInteger(s.array_item)) out.push({ step: i, item: s.array_item });
  });
  return out;
}

/** Paths a selector may read, resolved relative to the line (or bundle for root.). */
export function selectorPaths(selector) {
  const sel = normalizeSelector(selector);
  const out = [];
  if (!isPlainObject(sel)) return out;
  if (typeof sel.path === 'string') out.push(sel.path);
  for (const step of sel.steps ?? []) {
    if (isPlainObject(step) && Array.isArray(step.coalesce)) out.push(...step.coalesce.filter((p) => typeof p === 'string'));
  }
  return out;
}

/**
 * Split "root.currency" / "parent.currency" / "sku" into {scope, path}.
 *  - line:   relative to the line item
 *  - parent: the object at the lines.path wildcard (e.g. the order)
 *  - root:   the whole captured package
 */
export function selectorScope(selector) {
  const sel = normalizeSelector(selector);
  const path = sel && typeof sel.path === 'string' ? sel.path : '';
  if (path === 'root' || path.startsWith('root.')) return { scope: 'root', path: path === 'root' ? '' : path.slice(5) };
  if (path === 'parent' || path.startsWith('parent.')) return { scope: 'parent', path: path === 'parent' ? '' : path.slice(7) };
  return { scope: 'line', path };
}

// ------------------------------------------------------------- evaluation

export function getPath(node, path) {
  if (path === '') return { found: true, value: node };
  let cur = node;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return { found: false };
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part) || Number(part) >= cur.length) return { found: false };
      cur = cur[Number(part)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, part)) return { found: false };
      cur = cur[part];
    }
  }
  return { found: true, value: cur };
}

const SYMBOL_CODES = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };
const KNOWN_CODES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'CHF', 'SEK', 'NOK', 'INR', 'BRL', 'MXN']);

export function canonicalDecimal(n) {
  const s = String(n);
  if (/^-?\d+\.\d+$/.test(s)) {
    const [i, f = ''] = s.split('.');
    return `${BigInt(i).toString()}.${(f + '00').slice(0, 2)}`;
  }
  if (/^-?\d+\.?$/.test(s)) return `${BigInt(s.replace(/\.$/, '')).toString()}.00`;
  return s;
}

/**
 * Parse formatted money: "1,234.50 USD", "$1,234.50", "(12.00)", "1234.5".
 * Returns {amount, currency, negative} or null. Ambiguous strings return null;
 * they are never guessed, so a new format surfaces as a loss instead of a wrong value.
 */
export function parseHumanAmount(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return { amount: canonicalDecimal(input), currency: null, negative: input < 0 };
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s === '') return null;
  let currency = null;
  const code = s.match(/\b([A-Za-z]{3})\b/);
  if (code && KNOWN_CODES.has(code[1].toUpperCase())) {
    currency = code[1].toUpperCase();
    s = s.replace(code[0], ' ').trim();
  }
  const sym = s.match(/[$€£¥₹]/);
  if (sym) {
    currency = currency || SYMBOL_CODES[sym[0]] || null;
    s = s.replace(sym[0], ' ').trim();
  }
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).trim();
  }
  s = s.trim();
  if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) && !/^\d+(\.\d+)?$/.test(s)) return null;
  const plain = s.replaceAll(',', '');
  const [intPart, frac = ''] = plain.split('.');
  const amount = `${BigInt(intPart).toString()}.${(frac + '00').slice(0, 2)}`;
  return { amount: negative ? `-${amount}` : amount, currency, negative };
}

const valueKind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

function resolveScopePath(p, root, parent, line) {
  if (p === 'root' || p.startsWith('root.')) return { node: root, path: p === 'root' ? '' : p.slice(5) };
  if (p === 'parent' || p.startsWith('parent.')) return { node: parent, path: p === 'parent' ? '' : p.slice(7) };
  return { node: line, path: p };
}

const STEP_NAMES = new Set(['array_item', 'unwrap', 'match', 'number', 'human_amount', 'currency', 'trim', 'case', 'replace', 'split', 'coalesce', 'default', 'derived_line_id', 'identity']);

/**
 * Evaluate a selector against a line (or bundle root). Returns
 *   {state: ok|missing|type_mismatch|error, value, currency, notes[], raw}
 * raw is the selector's original selected value as it appeared on the wire.
 */
export function evaluateSelector(line, root, rawSelector, fieldName, context = {}) {
  const sel = normalizeSelector(rawSelector);
  const notes = [];
  if (!isPlainObject(sel)) return { field: fieldName, state: 'error', reason: 'selector is not an object', notes };
  if (!Array.isArray(sel.steps ?? [])) return { field: fieldName, state: 'error', reason: 'steps must be an array', notes };
  const scope = selectorScope(sel);
  const parent = context.parent ?? null;
  const seq = Number.isInteger(context.seq) ? context.seq : null;
  const node = scope.scope === 'root' ? root : scope.scope === 'parent' ? parent : line;
  if (node === null || node === undefined) return { field: fieldName, state: 'missing', notes: ['the package has no batch/order object for this line'] };
  let state = 'ok';
  let value;
  let currency = null;
  let raw;

  const got = getPath(node, scope.path); // '' returns the line itself (positional lines)
  if (!got.found) {
    state = 'missing';
    notes.push(`${scope.scope === 'root' ? 'batch' : 'line'} path ${JSON.stringify(scope.path)} not present`);
  } else if (got.value === null || got.value === undefined) {
    state = 'missing';
    notes.push(`path ${JSON.stringify(scope.path)} is ${got.value === null ? 'null' : 'undefined'}`);
  } else {
    value = got.value;
    raw = got.value;
    notes.push(`read ${scope.scope === 'root' ? 'batch-level' : 'line'} value at ${JSON.stringify(scope.path)}`);
  }

  for (const step of sel.steps ?? []) {
    if (!isPlainObject(step) || Object.keys(step).length !== 1) return { field: fieldName, state: 'error', reason: 'malformed step', notes };
    const k = Object.keys(step)[0];
    const arg = step[k];
    switch (k) {
      case 'array_item': {
        if (state === 'missing') { notes.push(`array_item(${arg}) skipped: path missing`); break; }
        if (!Array.isArray(value)) { state = 'type_mismatch'; notes.push(`array_item(${arg}) needs an array, got ${valueKind(value)}`); break; }
        if (arg >= value.length) { state = 'missing'; notes.push(`array has ${value.length} item(s); position ${arg} empty`); break; }
        value = value[arg];
        notes.push(`array_item(${arg}): selected position ${arg}`);
        break;
      }
      case 'unwrap': {
        if (state === 'missing') break;
        if (Array.isArray(value)) {
          if (value.length !== 1) {
            state = 'type_mismatch';
            notes.push(`unwrap: expected exactly 1 element, found ${value.length}; ambiguous without an explicit position`);
            break;
          }
          value = value[0];
          notes.push('unwrap: single-element array unwrapped');
        }
        if (typeof arg === 'string') {
          if (!isPlainObject(value)) {
            // Scalars pass through: a source that changed one field from "12.50" to
            // {value: 12.5, currency: ...} stays readable by the same selector.
            notes.push(`unwrap: value is already scalar (${valueKind(value)}), used as-is`);
            break;
          }
          const nested = getPath(value, arg);
          if (!nested.found || nested.value === null || nested.value === undefined) {
            state = 'missing';
            notes.push(`unwrap: nested path ${JSON.stringify(arg)} not present`);
          } else {
            value = nested.value;
            raw = value;
            notes.push(`unwrap: read ${JSON.stringify(arg)} from the element`);
          }
        }
        break;
      }
      case 'match': {
        if (state === 'missing') break;
        if (typeof value !== 'string') { state = 'type_mismatch'; notes.push(`match(${JSON.stringify(arg)}) needs a string, got ${valueKind(value)}`); break; }
        if (value !== arg) { state = 'missing'; notes.push(`match(${JSON.stringify(arg)}): found ${JSON.stringify(value)}`); }
        break;
      }
      case 'number': {
        if (state === 'missing') break;
        if (typeof value === 'number') {
          notes.push(`number: ${value} already numeric`);
        } else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
          value = Number(value.trim());
          notes.push(`number: ${JSON.stringify(value)}`);
        } else {
          state = 'type_mismatch';
          notes.push(`number: ${JSON.stringify(value)} is not a clean numeric value`);
        }
        break;
      }
      case 'human_amount': {
        if (state === 'missing') break;
        const parsed = parseHumanAmount(value);
        if (!parsed) { state = 'type_mismatch'; notes.push(`human_amount: ${JSON.stringify(value)} is not a parseable amount`); break; }
        if (parsed.currency) {
          if (currency && currency !== parsed.currency) notes.push(`human_amount: currency ${parsed.currency} conflicts with previously read ${currency}`);
          currency = parsed.currency;
        }
        value = parsed.amount;
        notes.push(`human_amount: ${JSON.stringify(parsed.amount)}${parsed.currency ? ` ${parsed.currency}` : ''}`);
        break;
      }
      case 'currency': {
        if (state === 'missing') break;
        // If an earlier step (human_amount) already captured the code from the
        // same text, use it: the field itself holds an amount, not a code.
        if (currency) {
          value = currency;
          notes.push(`currency: ${currency} (captured from the same value)`);
          break;
        }
        if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) { state = 'type_mismatch'; notes.push(`currency: ${JSON.stringify(value)} is not a 3-letter code`); break; }
        currency = value.trim().toUpperCase();
        value = currency;
        notes.push(`currency: ${currency}`);
        break;
      }
      case 'trim': {
        if (state === 'missing') break;
        if (typeof value !== 'string') { state = 'type_mismatch'; notes.push('trim needs a string'); break; }
        value = value.trim();
        break;
      }
      case 'case': {
        if (state === 'missing') break;
        if (typeof value !== 'string') { state = 'type_mismatch'; notes.push('case needs a string'); break; }
        value = arg === 'upper' ? value.toUpperCase() : value.toLowerCase();
        break;
      }
      case 'replace': {
        if (state === 'missing') break;
        if (typeof value !== 'string') { state = 'type_mismatch'; notes.push('replace needs a string'); break; }
        value = value.split(arg.from).join(arg.to);
        notes.push(`replace: ${JSON.stringify(arg.from)} → ${JSON.stringify(arg.to)}`);
        break;
      }
      case 'split': {
        if (state === 'missing') break;
        if (typeof value !== 'string') { state = 'type_mismatch'; notes.push('split needs a string'); break; }
        value = value.split(arg);
        notes.push(`split: ${value.length} part(s) on ${JSON.stringify(arg)}`);
        break;
      }
      case 'coalesce': {
        if (state !== 'missing') { notes.push('coalesce: primary path present, fallbacks skipped'); break; }
        let used = null;
        for (const p of arg) {
          const scopeP = resolveScopePath(p, root, parent, line);
          const hit = getPath(scopeP.node, scopeP.path);
          if (hit.found && hit.value !== null && hit.value !== undefined && hit.value !== '') { used = { p, value: hit.value }; break; }
        }
        if (used) {
          value = used.value;
          if (raw === undefined) raw = used.value;
          state = 'ok';
          notes.push(`coalesce: used fallback ${JSON.stringify(used.p)}`);
        }
        break;
      }
      case 'derived_line_id': {
        const parts = [];
        let missingParts = 0;
        for (const p of arg.parts) {
          if (p === '$seq' || p === '$key') {
            const builtin = p === '$seq' ? (seq === null ? null : String(seq)) : (context.key ?? null);
            if (builtin === null || builtin === undefined) { missingParts++; parts.push(''); }
            else parts.push(String(builtin));
            continue;
          }
          const scopeP = resolveScopePath(p, root, parent, line);
          const hit = getPath(scopeP.node, scopeP.path);
          if (!hit.found || hit.value === null || hit.value === undefined || hit.value === '') { missingParts++; parts.push(''); }
          else parts.push(String(hit.value));
        }
        const sep = typeof arg.separator === 'string' ? arg.separator : '|';
        value = parts.map((p) => p.trim().replaceAll(sep, '_').replace(/\s+/g, '-')).join(sep);
        state = 'ok';
        notes.push(`derived_line_id: composed ${arg.parts.length} part(s)${missingParts ? `, ${missingParts} missing` : ''}`);
        break;
      }
      case 'default': {
        if (state === 'missing' || value === null || value === undefined || value === '') {
          value = arg;
          state = 'ok';
          notes.push(`default: filled ${JSON.stringify(arg)}`);
        }
        break;
      }
      case 'identity':
        break;
      default:
        return { field: fieldName, state: 'error', reason: `unknown step ${JSON.stringify(k)}`, notes };
    }
    if (state === 'error') break;
  }

  if (state === 'ok' && (value === undefined || value === null || (typeof value === 'string' && value === ''))) {
    state = 'missing';
    notes.push('selected value is empty');
  }
  return { field: fieldName, state, value, currency, raw, notes };
}

/** Apply contract coercion. Never rounds, never invents a value. */
export function coerce(field, raw) {
  const spec = FIELD_SPEC[field];
  if (!spec) return { ok: false, reason: `unknown field ${field}` };
  if (raw === undefined || raw === null || raw === '') return { ok: false, reason: 'empty value' };
  switch (spec.type) {
    case 'string':
      if (typeof raw === 'string') return { ok: true, value: raw };
      if (typeof raw === 'number' || typeof raw === 'boolean') return { ok: true, value: String(raw), note: `${typeof raw} stored as text` };
      return { ok: false, reason: `cannot store ${valueKind(raw)} as text` };
    case 'integer': {
      if (typeof raw === 'number') {
        if (!Number.isInteger(raw)) return { ok: false, reason: `${raw} is not an integer` };
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return { ok: true, value: Number(raw.trim()) };
      // Canonical decimal text from human_amount/number steps: 1200.00 is an integer,
      // 12.50 is not and is rejected rather than rounded.
      if (typeof raw === 'string' && /^-?\d+\.0{1,2}$/.test(raw.trim())) {
        return { ok: true, value: Number(raw.trim().split('.')[0]), note: 'trailing zeros dropped for integer storage' };
      }
      return { ok: false, reason: `${JSON.stringify(raw)} is not an integer` };
    }
    case 'decimal': {
      if (typeof raw === 'number') return { ok: true, value: canonicalDecimal(raw), note: 'number normalized to canonical decimal text' };
      if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) return { ok: true, value: canonicalDecimal(raw.trim()) };
      return { ok: false, reason: `${JSON.stringify(raw)} is not a decimal` };
    }
    default:
      return { ok: false, reason: 'unknown contract type' };
  }
}

// ------------------------------------------------------------- shapes

const MAX_DEPTH = 12;
const MAX_NODES = 8000;

/**
 * Record every location in a JSON value with its observed kinds and a few samples.
 * Map<path, {kinds:Set, samples:[]}> plus Map<path,{length}> for arrays.
 */
export function extractShape(root, { prefix = '' } = {}) {
  const paths = new Map();
  const arrays = new Map();
  let nodes = 0;
  let truncated = false;

  const add = (p, v) => {
    if (nodes++ > MAX_NODES) { truncated = true; return; }
    const kind = valueKind(v);
    const sample = kind === 'string' ? v.slice(0, 80) : kind === 'number' || kind === 'boolean' ? v : undefined;
    const prev = paths.get(p);
    if (!prev) paths.set(p, { kind, kinds: new Set([kind]), samples: sample === undefined ? [] : [sample] });
    else {
      prev.kinds.add(kind);
      prev.kind = prev.kinds.size === 1 ? [...prev.kinds][0] : 'mixed';
      if (sample !== undefined && prev.samples.length < 3) prev.samples.push(sample);
    }
  };

  const walk = (v, p, depth) => {
    if (depth > MAX_DEPTH) { truncated = true; return; }
    add(p, v);
    if (Array.isArray(v)) {
      arrays.set(p, { length: v.length });
      v.forEach((item, i) => walk(item, p ? `${p}.${i}` : String(i), depth + 1));
    } else if (isPlainObject(v)) {
      for (const k of Object.keys(v)) walk(v[k], p ? `${p}.${k}` : k, depth + 1);
    }
  };
  walk(root, prefix, 0);
  return { paths, arrays, truncated };
}

/** Merge shapes of many values (lines) as if they were one observation. */
export function mergeShapes(shapes) {
  const paths = new Map();
  const arrays = new Map();
  for (const shape of shapes) {
    for (const [p, info] of shape.paths) {
      const prev = paths.get(p);
      if (!prev) paths.set(p, { kind: info.kind, kinds: new Set(info.kinds), samples: [...info.samples] });
      else {
        for (const k of info.kinds) prev.kinds.add(k);
        prev.kind = prev.kinds.size === 1 ? [...prev.kinds][0] : 'mixed';
        for (const s of info.samples) if (prev.samples.length < 4) prev.samples.push(s);
      }
    }
    for (const [p, info] of shape.arrays) {
      const prev = arrays.get(p);
      arrays.set(p, prev ? { length: Math.max(prev.length, info.length), min: Math.min(prev.length ?? info.length, info.length) } : { ...info });
    }
  }
  return { paths, arrays, truncated: shapes.some((s) => s.truncated) };
}

/**
 * Resolve a mapping.lines spec against a bundle. Returns the line items plus,
 * for wildcard paths, the parent object each line belongs to (an order, an
 * envelope, ...) so selectors can read shared batch values like a currency.
 */
export function extractLines(bundle, linesSpec) {
  if (!isPlainObject(linesSpec) || typeof linesSpec.path !== 'string' || linesSpec.path === '') {
    return { ok: false, problems: [err('E_LINES', null, 'lines.path must be a non-empty path')], items: [] };
  }
  if (!['array', 'object_of_objects'].includes(linesSpec.mode)) {
    return { ok: false, problems: [err('E_LINES', null, 'lines.mode must be "array" or "object_of_objects"')], items: [] };
  }
  let parts;
  try { parts = parseLinesPath(linesSpec.path); } catch (e) { return { ok: false, problems: [err('E_LINES_PATH', null, e.message)], items: [] }; }
  const star = parts.indexOf('*');
  const collections = []; // { value, parent, parentKey }
  if (star < 0) {
    const got = getPath(bundle, linesSpec.path);
    if (!got.found) return { ok: false, problems: [err('E_LINES_PATH', null, `lines.path ${JSON.stringify(linesSpec.path)} not present in the package`)], items: [] };
    collections.push({ value: got.value, parent: null, parentKey: null });
  } else {
    const prefix = parts.slice(0, star).join('.');
    const rest = parts.slice(star + 1).join('.');
    const got = getPath(bundle, prefix);
    if (!got.found) return { ok: false, problems: [err('E_LINES_PATH', null, `lines.path prefix ${JSON.stringify(prefix)} not present in the package`)], items: [] };
    if (!Array.isArray(got.value)) return { ok: false, problems: [err('E_LINES_PATH', null, `lines.path ${JSON.stringify(prefix)} is ${valueKind(got.value)}, expected an array to iterate`)], items: [] };
    got.value.forEach((parent, i) => {
      const hit = getPath(parent, rest);
      collections.push({ value: hit.found ? hit.value : undefined, parent, parentKey: String(i), parentPath: `${prefix}.${i}` });
    });
  }

  const problems = [];
  const items = [];
  for (const col of collections) {
    if (col.value === undefined) {
      problems.push(err('E_LINES_PATH', null, `line collection ${JSON.stringify(linesSpec.path)} is absent under ${col.parentPath ?? 'the document root'}`));
      continue;
    }
    if (linesSpec.mode === 'array') {
      if (!Array.isArray(col.value)) {
        problems.push(err('E_LINES_MODE', null, `${JSON.stringify(linesSpec.path)} is ${valueKind(col.value)}${col.parentPath ? ` at ${col.parentPath}` : ''}, not an array`));
        continue;
      }
      col.value.forEach((v, i) => items.push({ seq: items.length, key: String(i), value: v, parent: col.parent, parentPath: col.parentPath ?? null, parentKey: col.parentKey }));
    } else {
      if (!isPlainObject(col.value)) {
        problems.push(err('E_LINES_MODE', null, `${JSON.stringify(linesSpec.path)} is ${valueKind(col.value)}${col.parentPath ? ` at ${col.parentPath}` : ''}, not an object map`));
        continue;
      }
      for (const [k, v] of Object.entries(col.value)) {
        items.push({ seq: items.length, key: k, value: v, parent: col.parent, parentPath: col.parentPath ?? null, parentKey: col.parentKey });
      }
    }
  }
  if (collections.length === 0) problems.push(err('E_LINES_EMPTY', null, 'the package contains no lines'));
  if (items.length === 0 && problems.length === 0) problems.push(err('E_LINES_EMPTY', null, 'the package contains no lines'));
  for (const item of items) {
    // Objects and positional arrays are the normal line shapes. A string line is
    // also allowed: packed formats ("sku|qty|price") are readable with an
    // explicit split step, and refusing them here would make hand-written
    // mappings impossible for exactly those packages that need one.
    if (!isPlainObject(item.value) && !Array.isArray(item.value) && typeof item.value !== 'string') {
      item.problem = `line ${JSON.stringify(item.key)} is ${valueKind(item.value)}, expected an object, positional array or packed string`;
      problems.push(err('E_LINES_ITEM', null, item.problem));
    }
  }
  return { ok: problems.length === 0, problems, items, collections: collections.length };
}

function kindAcceptable(kind, target, steps = []) {
  const envelopes = ['object', 'array'];
  if (envelopes.includes(kind)) return steps.some((st) => isPlainObject(st) && 'unwrap' in st);
  if (['boolean', 'null', 'undefined', 'mixed'].includes(kind)) return false;
  if (kind !== 'string' && kind !== 'number') return false;
  if (kind === 'number' && target === 'string') return true;
  return true;
}

// ------------------------------------------------------------ validation

export function validateMapping(mapping) {
  const errors = [];
  const E = (code, field, detail) => errors.push(err(code, field, detail));
  const out = { ok: false, errors, aliases: {} };

  if (!isPlainObject(mapping)) { E('E_MAPPING_SHAPE', null, 'mapping must be an object'); return out; }
  if (mapping.spec !== SPEC_VERSION) E('E_SPEC', null, `mapping.spec must be ${SPEC_VERSION}`);
  if (!SOURCE_ID_RE.test(mapping.source_id ?? '')) E('E_SOURCE', null, 'source_id must be a lowercase slug');
  if (!Number.isInteger(mapping.version) || mapping.version < 1) E('E_VERSION', null, 'version must be a positive integer');

  const lines = mapping.lines;
  if (!isPlainObject(lines)) E('E_LINES', null, 'lines must be an object');
  else {
    if (typeof lines.path !== 'string' || lines.path === '') E('E_LINES', null, 'lines.path must be a non-empty path');
    else {
      try { parseLinesPath(lines.path); } catch (e) { E('E_LINES_PATH', null, e.message); }
    }
    if (!['array', 'object_of_objects'].includes(lines.mode)) E('E_LINES', null, 'lines.mode must be "array" or "object_of_objects"');
  }

  const selectors = mapping.selectors;
  if (!isPlainObject(selectors) || Object.keys(selectors).length === 0) {
    E('E_SELECTORS', null, 'selectors must be a non-empty object');
    return out;
  }

  const seenLocations = new Map();
  for (const [field, raw] of Object.entries(selectors)) {
    if (!FIELD_NAMES.has(field)) { E('E_UNKNOWN_FIELD', field, `${JSON.stringify(field)} is not part of the agreed contract`); continue; }
    const sel = normalizeSelector(raw);
    if (!isPlainObject(sel)) { E('E_SELECTOR_SHAPE', field, 'selector must be an object or a path string'); continue; }
    if (typeof sel.target !== 'string' || !(sel.target in TARGET_TYPES)) { E('E_TARGET', field, `${field} needs target string|integer|decimal`); continue; }
    if (!TARGET_TYPES[sel.target].includes(FIELD_SPEC[field].type)) {
      E('E_TARGET_TYPE', field, `${field} is ${FIELD_SPEC[field].type} in the contract; selector targets ${sel.target}`);
    }
    const scope = selectorScope(sel);
    if (typeof sel.path !== 'string') { E('E_PATH', field, `${field} needs a path`); continue; }
    if (sel.path === '') {
      // An empty path means "the line itself": valid only for a selector that
      // consumes the whole value (positional rows, packed strings) or reads the
      // object-map key, never for a field read that forgot its path.
      const readsWhole = (sel.steps ?? []).some((st) => isPlainObject(st) && (Number.isInteger(st.array_item) || 'split' in st));
      const readsKey = (sel.steps ?? []).some((st) => isPlainObject(st) && isPlainObject(st.derived_line_id) && (st.derived_line_id.parts ?? []).includes('$key'));
      if (!readsWhole && !readsKey) {
        E('E_PATH', field, `${field}: an empty path means "the line itself" and needs an array_item, split or $key-based derived_line_id step`); continue;
      }
    }
    if (scope.scope === 'parent' && isPlainObject(lines) && typeof lines.path === 'string' && !lines.path.includes('*')) {
      E('E_PARENT_SCOPE', field, `${field}: "parent." requires lines.path to iterate an array (e.g. "orders.*.lines")`);
    }
    if (scope.path !== '') {
      try { parsePath(scope.path); } catch (e) { E('E_PATH', field, `${field}: ${e.message}`); continue; }
    }
    if (sel.steps !== undefined && !Array.isArray(sel.steps)) { E('E_STEPS', field, `${field}: steps must be an array`); continue; }

    for (const step of sel.steps ?? []) {
      if (!isPlainObject(step) || Object.keys(step).length !== 1) { E('E_STEP_SHAPE', field, `${field}: each step must be an object with exactly one key`); continue; }
      const k = Object.keys(step)[0];
      const v = step[k];
      switch (k) {
        case 'array_item':
          if (!Number.isInteger(v) || v < 0) E('E_STEP_ARRAY_ITEM', field, `${field}: array_item must be a non-negative integer`);
          break;
        case 'unwrap':
          if (v !== true && !(typeof v === 'string' && v !== '')) E('E_STEP_UNWRAP', field, `${field}: unwrap takes true or a nested path string`);
          else if (typeof v === 'string') { try { parsePath(v); } catch (e) { E('E_STEP_UNWRAP', field, `${field}: ${e.message}`); } }
          break;
        case 'match':
          if (typeof v !== 'string') E('E_STEP_MATCH', field, `${field}: match needs a string`);
          break;
        case 'number':
        case 'human_amount':
          if (v !== undefined && v !== true) E('E_STEP_ARG', field, `${field}: ${k} takes no argument`);
          break;
        case 'currency':
        case 'trim':
        case 'identity':
          if (v !== undefined && v !== true) E('E_STEP_ARG', field, `${field}: ${k} takes no argument`);
          break;
        case 'case':
          if (v !== 'upper' && v !== 'lower') E('E_STEP_CASE', field, `${field}: case must be upper|lower`);
          break;
        case 'replace':
          if (!isPlainObject(v) || typeof v.from !== 'string' || typeof v.to !== 'string' || v.from === '') E('E_STEP_REPLACE', field, `${field}: replace needs {from,to} with a non-empty from`);
          break;
        case 'split':
          if (typeof v !== 'string' || v === '') E('E_STEP_SPLIT', field, `${field}: split needs a non-empty separator string`);
          break;
        case 'coalesce':
          if (!Array.isArray(v) || v.length === 0 || v.some((p) => typeof p !== 'string' || p === '')) E('E_STEP_COALESCE', field, `${field}: coalesce needs a non-empty array of paths`);
          else for (const p of v) { try { parsePath(p.startsWith('root.') ? p.slice(5) : p); } catch (e) { E('E_STEP_COALESCE', field, `${field}: ${e.message}`); } }
          break;
        case 'default':
          if (v === null || v === undefined || typeof v === 'object' || typeof v === 'boolean') E('E_STEP_DEFAULT', field, `${field}: default must be a string or number`);
          break;
        case 'derived_line_id':
          if (!isPlainObject(v) || !Array.isArray(v.parts) || v.parts.length === 0 || v.parts.some((p) => typeof p !== 'string') || (v.separator !== undefined && typeof v.separator !== 'string')) E('E_STEP_DERIVED', field, `${field}: derived_line_id needs {parts:[paths], separator?}`);
          else for (const p of v.parts) { if (p === '$seq' || p === '$key') continue; try { parsePath(p.startsWith('root.') ? p.slice(5) : p.startsWith('parent.') ? p.slice(7) : p); } catch (e) { E('E_STEP_DERIVED', field, `${field}: ${e.message}`); } }
          break;
        default:
          E('E_STEP_UNKNOWN', field, `${field}: unknown step ${JSON.stringify(k)} (allowed: ${[...STEP_NAMES].join(', ')})`);
      }
    }

    const locationKey = stableStringify({ scope: scope.scope, path: scope.path, steps: sel.steps ?? [] });
    if (!seenLocations.has(locationKey)) seenLocations.set(locationKey, []);
    seenLocations.get(locationKey).push(field);
  }

  const notes = mapping.notes ?? {};
  if (!isPlainObject(notes)) E('E_NOTES', null, 'notes must be an object of per-field strings');
  else {
    for (const [key, fields] of seenLocations) {
      if (fields.length < 2) continue;
      const documented = fields.every((f) => typeof notes[f] === 'string' && notes[f].trim() !== '');
      const loc = JSON.parse(key);
      if (documented) out.aliases[key] = { fields, path: loc.path, scope: loc.scope, note: fields.map((f) => `${f}: ${notes[f]}`).join('; ') };
      else E('E_ALIAS_UNDOCUMENTED', fields.join(','), `${fields.join(', ')} read the same location ${JSON.stringify(loc.path)}${loc.scope === 'root' ? ' at batch level' : ''}; add a note for each field if intentional`);
    }
  }

  const missingRequired = REQUIRED_FIELDS.filter((f) => !(f in selectors));
  if (missingRequired.length) E('E_REQUIRED_FIELD', missingRequired.join(','), `required contract field(s) not mapped: ${missingRequired.join(', ')}`);

  out.ok = errors.length === 0;
  return out;
}

// --------------------------------------------------------------- read plan

/**
 * Resolve the mapping against one captured package. Returns the closed set of
 * locations that will be read, observed kinds, array bounds, and problems. A
 * non-empty error list means ingestion must not proceed with this mapping.
 *
 * Scopes are resolved against real objects: line selectors against merged line
 * shapes, parent selectors against merged parent shapes, root selectors against
 * the whole package. A path that exists in a different scope does not count.
 */
export function buildReadPlan(mapping, bundle) {
  const validation = validateMapping(mapping);
  const problems = [];
  const notes = [];
  if (!validation.ok) return { ok: false, validation, problems: validation.errors.map((e) => ({ ...e, severity: FATAL })), locations: [], observations: {}, notes, lines: null, fatal: true };

  const lines = extractLines(bundle, mapping.lines);
  for (const p of lines.problems ?? []) {
    const fatal = ['E_LINES', 'E_LINES_PATH', 'E_LINES_MODE'].includes(p.code);
    problems.push({ ...p, severity: fatal ? FATAL : LINE });
  }
  const lineShapes = [];
  const stringLines = lines.items.filter((i) => typeof i.value === 'string');
  for (const item of lines.items) {
    if (isPlainObject(item.value)) lineShapes.push(extractShape(item.value));
  }
  if (stringLines.length) {
    // Packed string lines have no object paths; the "line itself" is a string.
    // Report it at path "" so a split-based selector resolves to a real location.
    const paths = new Map([['', { kind: 'string', kinds: new Set(['string']), samples: stringLines.slice(0, 3).map((i) => i.value.slice(0, 80)) }]]);
    lineShapes.push({ paths, arrays: new Map(), truncated: false });
  }
  const parentShapes = lines.items.filter((i) => isPlainObject(i.parent)).map((i) => extractShape(i.parent));
  const shape = mergeShapes(lineShapes);
  const parentShape = mergeShapes(parentShapes);
  const rootShape = extractShape(bundle);
  const observations = {};
  const locations = [];

  for (const [field, raw] of Object.entries(mapping.selectors)) {
    const sel = normalizeSelector(raw);
    const scope = selectorScope(sel);
    const sourceShape = scope.scope === 'root' ? rootShape : scope.scope === 'parent' ? parentShape : shape;
    const hits = sourceShape.paths.get(scope.path);
    if (scope.scope === 'line' && scope.path === '' && !hits) {
      // Positional line collections: the line is the array itself.
      observations[field] = { kinds: ['array'], samples: [] };
      locations.push({ field, scope: 'line', path: '', kinds: ['array'], samples: [] });
      continue;
    }
    const steps = sel.steps ?? [];
    const hasArrayItem = arrayItemSteps(sel).length > 0;
    const numeric = steps.some((s) => isPlainObject(s) && NUMERIC_STEPS.has(Object.keys(s)[0]));
    const human = steps.some((s) => isPlainObject(s) && 'human_amount' in s);
    const hasDefault = steps.some((s) => isPlainObject(s) && 'default' in s);
    const where = scope.scope === 'root' ? 'at batch level' : scope.scope === 'parent' ? 'on the enclosing order' : 'in any line';


    // coalesce fallbacks may live in another scope: check each candidate at plan time.
    const candidates = scope.steps?.length ? selectorPaths(sel) : [sel.path];
    let anyCandidate = hits !== undefined;
    if (!anyCandidate) {
      for (const cand of candidates) {
        const cScope = selectorScope({ path: cand });
        const cShape = cScope.scope === 'root' ? rootShape : cScope.scope === 'parent' ? parentShape : shape;
        if (cShape.paths.has(cScope.path)) { anyCandidate = true; break; }
      }
    }
    if (!hits) {
      problems.push({ ...err('E_PATH_UNKNOWN', field, `${field}: path ${JSON.stringify(sel.path)} matches nothing ${where} of this package`), severity: FATAL });
      observations[field] = { kinds: [], samples: [] };
      continue;
    }
    const kinds = [...hits.kinds];
    observations[field] = { kinds, samples: hits.samples };
    locations.push({ field, scope: scope.scope, path: scope.path, kinds, samples: hits.samples });

    if (kinds.length === 1 && kinds[0] === 'mixed') {
      problems.push({ ...err('E_MIXED_KINDS', field, `${field}: ${JSON.stringify(scope.path)} has inconsistent kinds within this package; lines with the unexpected kind will be marked`), severity: LINE });
      continue;
    }

    const bad = hasArrayItem ? [] : kinds.filter((k) => !kindAcceptable(k, sel.target, steps));
    if (bad.length) {
      const covered = hasDefault && bad.every((k) => k === 'null') && kinds.some((k) => kindAcceptable(k, sel.target, steps));
      const humanText = human && bad.every((k) => k === 'string') && sel.target !== 'integer';
      if (!covered && !humanText) {
        problems.push({ ...err('E_TYPE_MISMATCH', field, `${field}: observed ${kinds.join('/')} at ${JSON.stringify(sel.path)} cannot be read as ${sel.target} with the declared steps`), severity: scope.scope === 'line' ? LINE : FATAL });
      }
    }

    if (!numeric && (sel.target === 'integer' || sel.target === 'decimal') && kinds.includes('string')) {
      notes.push({ code: 'N_TEXT_NO_STEP', field, detail: `${field}: observed as text with no number/human_amount step; text values will be rejected per line rather than parsed` });
    }
    if (numeric) {
      const stringSamples = hits.samples.filter((s) => typeof s === 'string');
      if (stringSamples.length) {
        const parse = human ? parseHumanAmount : (x) => (/^-?\d+(\.\d+)?$/.test(String(x).trim()) ? { amount: String(x).trim() } : null);
        const unreadable = stringSamples.filter((x) => parse(x) === null);
        if (unreadable.length) {
          notes.push({ code: 'N_SAMPLE_UNREADABLE', field, detail: `${field}: observed sample(s) ${unreadable.map((x) => JSON.stringify(x)).join(', ')} do not parse; those lines will be marked, not guessed` });
        }
      }
    }

    if (sel.target === 'integer' && !hasArrayItem) {
      const textSamples = hits.samples.filter((x) => typeof x === 'string');
      const fractional = textSamples.filter((x) => {
        const parsed = human ? parseHumanAmount(x) : null;
        return parsed && !parsed.amount.endsWith('.00');
      });
      if (fractional.length) notes.push({ code: 'N_INTEGER_REJECT', field, detail: `${field}: fractional sample(s) ${fractional.map((x) => JSON.stringify(x)).join(', ')} will be rejected as integers, never rounded` });
    }

    for (const { item } of arrayItemSteps(sel)) {
      if (hits.kinds.has('array') || kinds.length === 0) {
        const arrInfo = sourceShape.arrays.get(scope.path) ?? sourceShape.arrays.get('');
        const len = arrInfo?.length ?? null;
        if (len !== null && item >= len) problems.push({ ...err('E_ARRAY_ITEM', field, `${field}: array_item(${item}) exceeds observed length ${len} at ${JSON.stringify(scope.path)}`), severity: LINE });
        else notes.push({ code: 'N_ARRAY_POSITION', field, detail: `${field}: reads position ${item} of ${JSON.stringify(scope.path)}; other elements stay raw-only` });
      }
    }
  }

  for (const alias of Object.values(validation.aliases)) {
    notes.push({ code: 'N_ALIAS', fields: alias.fields, detail: `documented shared read at ${JSON.stringify(alias.path)} (${alias.scope}): ${alias.note}` });
  }
  if (shape.truncated || rootShape.truncated || parentShape.truncated) notes.push({ code: 'N_SHAPE_TRUNCATED', detail: 'shape walk hit its depth/node cap; some locations were not checked' });

  const fatal = problems.some((p) => p.severity === FATAL);
  return { ok: !fatal, fatal, validation, problems, locations, observations, notes, lines, shape, rootShape, parentShape };
}

/** Unconsumed fields of a line, relative paths, for "what did we not ingest". */
export function unmappedFields(line, mapping) {
  if (!isPlainObject(line)) return [];
  const consumed = new Set();
  for (const sel of Object.values(mapping.selectors ?? {})) {
    const scope = selectorScope(sel);
    if (scope.scope !== 'line') continue;
    consumed.add(scope.path);
  }
  const out = [];
  const walk = (v, p, depth) => {
    if (depth > 4 || out.length > 60) return;
    if (isPlainObject(v)) {
      for (const k of Object.keys(v)) walk(v[k], p ? `${p}.${k}` : k, depth + 1);
    } else if (Array.isArray(v)) {
      out.push({ path: p, kind: 'array' });
    } else {
      out.push({ path: p, kind: valueKind(v) });
    }
  };
  for (const k of Object.keys(line)) walk(line[k], k, 0);
  return out.filter((entry) => {
    for (const c of consumed) {
      if (entry.path === c || entry.path.startsWith(c + '.') || c.startsWith(entry.path + '.')) return false;
    }
    return true;
  });
}

/** Compact shape description for the analysis page (kinds and short samples only). */
export function describeShape(shape, limit = 250) {
  const out = [];
  for (const [path, info] of shape.paths) {
    if (out.length >= limit) break;
    out.push({ path, kinds: [...info.kinds], samples: info.samples.map((s) => (typeof s === 'string' ? s.slice(0, 60) : s)) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export { valueKind, err, kindAcceptable };
