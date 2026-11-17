// Candidate mapping derivation. This is the "structure identification" step:
// look at a captured package, find plausible line collections, and propose
// selectors for each contract field. It proposes; it never decides, and it never
// mutates the package. Every candidate is a complete cg.map/1 document that must
// pass validateMapping() and buildReadPlan() before it can be offered.
//
// Derivation is structural. Candidate collections are arrays of objects, maps of
// objects, arrays of positional arrays, and the same shapes one level inside an
// array of orders. Values are sniffed (number vs text, money-shaped text,
// currency codes, single-element arrays, nested price objects) to pick the
// normalization steps. When something cannot be inferred, the candidate is
// either not offered or offered with an explicit finding — data is never
// dropped silently and required fields are never invented.
import { isPlainObject } from './util.js';
import { getPath, parseHumanAmount, SPEC_VERSION, valueKind } from './spec.js';

const MONEY_TEXT = /^[\s$€£¥₹+-]*\(?\s*\d{1,3}(,\d{3})*(\.\d+)?\s*\)?\s*(USD|EUR|GBP|JPY|CNY|CAD|AUD|CHF|SEK|NOK|INR)?\s*$/i;
const CURRENCY_TEXT = /^[A-Za-z]{3}$/;
const CLEAN_NUMBER = /^-?\d+(\.\d+)?$/;

const HINTS = {
  sku: [/^sku$/i, /sku/i, /item_?code/i, /article/i, /product_?code/i, /^code$/i],
  description: [/desc/i, /^name$/i, /title/i, /label/i],
  quantity: [/qty/i, /quantity/i, /^count$/i, /units?$/i, /pieces?/i],
  unit_price: [/unit_?price/i, /^price$/i, /price/i, /each/i, /^rate$/i],
  amount: [/total/i, /amount/i, /extended/i, /^sum$/i],
  currency: [/currency/i, /^ccy$/i, /curr/i],
  unit: [/uom/i, /^unit$/i, /measure/i, /^pack$/i],
  line_id: [/(^|_)id$/i, /^id$/i, /line_?no/i, /line_?ref/i, /^ref(erence)?$/i],
};

function hintScore(key, role) {
  const patterns = HINTS[role] ?? [];
  for (let i = 0; i < patterns.length; i++) if (patterns[i].test(key)) return patterns.length - i;
  return 0;
}

/**
 * Batch-level declarations live on the document, not on lines. Including them in
 * the per-line key hunt produces selectors like "currency" that read nothing.
 */
const BATCH_SCOPED_ROLES = new Set(['currency']);
function lineKeys(keys) {
  return keys.filter((k) => !BATCH_SCOPED_ROLES.has(k) || false);
}

function bestKey(keys, role, exclude = new Set()) {
  let best = null;
  for (const key of keys) {
    if (exclude.has(key)) continue;
    const score = hintScore(key, role);
    if (score > 0 && (!best || score > best.score)) best = { key, score };
  }
  return best?.key ?? null;
}

/** Flatten an object to leaf {path, key, value, kind} entries (depth-limited). */
function leaves(obj, prefix = '', depth = 0, out = []) {
  if (!isPlainObject(obj) || depth > 3) return out;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && depth < 2) leaves(value, path, depth + 1, out);
    else out.push({ path, key, value, kind: valueKind(value) });
  }
  return out;
}

/** Find all plausible line collections in a package. */
function findCollections(bundle) {
  const found = [];
  const push = (c) => found.push({ suffix: null, pretty: 1, ...c });

  const visitArray = (arr, path, parentPath) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    const objects = arr.filter(isPlainObject);
    const arraysOfArrays = arr.filter((x) => Array.isArray(x) && x.length > 0);
    const scalars = arr.filter((x) => x === null || typeof x !== 'object');

    if (objects.length > 0) {
      const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))];
      // Wrapper arrays like price: [{amount, currency}] are values, not lines.
      const wrappers = objects.length <= 2 && keys.length <= 3 && keys.every((k) => /^(amount|value|price|total|currency|qty|quantity|unit)$/i.test(k)) && !keys.some((k) => /sku|code|desc|name/i.test(k));
      if (wrappers && parentPath !== null) return;
      const hits = ['sku', 'quantity', 'unit_price', 'amount', 'description'].filter((role) => bestKey(keys, role));
      const looksLikeLines = hits.length >= 2 || keys.length >= 4;
      push({
        kind: 'array',
        path,
        parentPath,
        records: objects.length,
        keys,
        pretty: looksLikeLines ? 2 : 1,
        score: objects.length * 2 + hits.length * 12 + (looksLikeLines ? 20 : 0),
        wildcard: parentPath !== null,
        samples: objects.slice(0, 100),
      });
      // Nested collections one level down (orders.*.lines). Samples from every
      // parent are merged so one mapping has to cover all orders in the package;
      // per-parent shapes are deliberately not allowed to split into two mappings.
      const nested = new Map();
      for (const obj of objects.slice(0, 20)) {
        for (const [key, child] of Object.entries(obj)) {
          if (Array.isArray(child) && child.some(isPlainObject)) {
            if (!nested.has(key)) nested.set(key, []);
            nested.get(key).push(...child);
          }
        }
      }
      const parentKeys = [...new Set(objects.flatMap((o) => Object.keys(o)))];
      for (const [key, merged] of nested) {
        visitArray(merged, `${path}.*.${key}`, path);
        const added = found.filter((f) => f.path === `${path}.*.${key}`);
        for (const f of added) {
          f.parentKeys = parentKeys;
          f.parentSamples = objects.slice(0, 20);
        }
      }
    }

    // A short list of mixed scalars (e.g. lines as packed strings) is not a
    // positional-row collection; it may still be worth showing as a candidate
    // with no usable selector, so the operator sees why it cannot be read.
    if (arraysOfArrays.length >= 2 && arraysOfArrays.length >= arr.length * 0.8) {
      const widths = arraysOfArrays.map((r) => r.length);
      push({
        kind: 'array_of_arrays',
        path,
        parentPath,
        records: arraysOfArrays.length,
        keys: [],
        widths,
        pretty: 2,
        score: arraysOfArrays.length * 3 + 20,
        wildcard: false,
        samples: arraysOfArrays.slice(0, 100),
      });
    }

    if (scalars.length === arr.length && arr.length >= 2 && parentPath === null) {
      // A flat list of scalars may be one line split across fields. Only offer it
      // when the parent object has a sibling array of the same length; otherwise
      // it is almost certainly not a line collection.
      push({
        kind: 'split_array',
        path,
        parentPath,
        records: arr.length,
        keys: [],
        pretty: 0,
        score: 2,
        wildcard: false,
        samples: [arr],
      });
    }
  };

  const visitObject = (node, path, depth) => {
    if (depth > 4) return;
    for (const key of Object.keys(node)) {
      const child = node[key];
      const childPath = path ? `${path}.${key}` : key;
      if (Array.isArray(child)) visitArray(child, childPath, null);
      else if (isPlainObject(child)) {
        const vals = Object.values(child);
        if (vals.length > 0 && vals.every(isPlainObject)) {
          const names = [...new Set(vals.flatMap((o) => Object.keys(o)))];
          const hits = ['sku', 'quantity', 'unit_price', 'amount'].filter((role) => bestKey(names, role));
          if (hits.length >= 1 || names.length >= 3) {
            push({
              kind: 'object_map',
              path: childPath,
              parentPath: null,
              records: vals.length,
              keys: names,
              pretty: 1,
              score: vals.length * 2 + hits.length * 10,
              wildcard: false,
              samples: vals.slice(0, 100),
            });
          }
        }
        visitObject(child, childPath, depth + 1);
      }
    }
  };

  visitObject(bundle, '', 0);
  // The first collection visited is the document root's own array. Crash before
  // any work if requested, so the injected crash is deterministic and early.
  return found.sort((a, b) => b.score - a.score || b.records - a.records);
}

const many = (vals, pred) => vals.length > 0 && vals.every(pred);
const someMoneyText = (vals) =>
  many(vals, (v) => typeof v === 'string' && MONEY_TEXT.test(v) && parseHumanAmount(v) !== null) &&
  vals.some((v) => /[,$€£¥₹]|\b(USD|EUR|GBP|JPY|CNY|CAD|AUD|CHF)\b/i.test(v));

/**
 * Numeric normalization steps for a field observed with these samples.
 *
 * Sources evolve in ways that do not change the value, only its envelope: a
 * scalar becomes [x], or {amount: x, currency}. unwrap passes scalars through
 * unchanged and unwraps single-element arrays / objects, so one selector covers
 * both the old and the new type. If a value is genuinely ambiguous (an array of
 * more than one element) unwrap refuses at runtime and the line is marked.
 */
function numberSteps(samples, { integer = false } = {}) {
  if (samples.length === 0) return [];
  let values = samples.map((s) => s.value);
  const steps = [];

  // Envelopes are unwrapped outside-in: array first, then object. unwrap passes
  // scalars through unchanged, so a selector covering [3], {amount: 3} and 3
  // reads all three without a per-line loss.
  if (values.some(Array.isArray)) {
    steps.push({ unwrap: true });
    values = values.map((v) => (Array.isArray(v) && v.length === 1 ? v[0] : v));
    if (values.some((v) => Array.isArray(v))) return null; // genuinely multi-valued
  }
  if (values.some(isPlainObject)) {
    const objects = values.filter(isPlainObject);
    const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))];
    const key = ['amount', 'value', 'price', 'total', 'qty', 'quantity'].find((k) => keys.includes(k)) ?? keys.find((k) => objects.every((o) => typeof o[k] === 'number' || (typeof o[k] === 'string' && CLEAN_NUMBER.test(o[k]))));
    if (!key) return null;
    steps.push({ unwrap: key });
    values = values.map((v) => (isPlainObject(v) ? v[key] : v));
    if (values.some((v) => Array.isArray(v) || isPlainObject(v))) return null;
  }

  if (many(values, (v) => typeof v === 'number')) return [...steps, { number: true }];
  if (many(values, (v) => typeof v === 'string' && CLEAN_NUMBER.test(v.trim()))) return [...steps, { number: true }];
  // Mixed numbers and formatted money text still share one parser: human_amount
  // accepts both a JSON number and a formatted string.
  const readableMoney = values.every(
    (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && parseHumanAmount(v) !== null),
  );
  if (readableMoney && values.some((v) => typeof v === 'string')) return [...steps, { human_amount: true }];
  if (many(values, (v) => typeof v === 'string')) return [...steps, { human_amount: true }];
  return null;
}

/**
 * Price-like samples across a whole catalog: one line may send a scalar and the
 * next {amount, currency}. Choose steps that read both, so a mixed package does
 * not force per-line losses.
 */
function mergeSamples(samples) {
  const flat = samples.flatMap((s) => (Array.isArray(s.value) ? s.value.map((v) => ({ ...s, value: v })) : [s]));
  return flat;
}

/**
 * If every sample is an array with the same length > 1, the field is genuinely
 * multi-valued. Reading it as one value would be a silent guess, so return one
 * variant per position: the operator picks, and the finding records what stays
 * raw-only. If lengths differ, no variant is safe.
 */
function positionalVariants(samples) {
  if (samples.length === 0) return null;
  const lengths = new Set(samples.map((s) => (Array.isArray(s.value) ? s.value.length : -1)));
  if (lengths.size !== 1) return null;
  const [len] = [...lengths];
  if (len <= 1) return null;
  const out = [];
  for (let i = 0; i < len; i++) {
    const projected = samples.map((s) => ({ value: s.value[i] }));
    const steps = numberSteps(projected);
    if (!steps) continue;
    out.push({ position: i, steps: [{ array_item: i }] });
  }
  return out.length ? out : null;
}

function stringSteps(samples) {
  const values = samples.map((s) => s.value);
  const steps = [];
  if (many(values, (v) => typeof v === 'string')) {
    if (values.some((v) => v !== v.trim())) steps.push({ trim: true });
  }
  return steps;
}

function currencyFromSamples(samples) {
  const codes = samples.map((s) => (typeof s.value === 'string' ? parseHumanAmount(s.value)?.currency ?? null : null));
  if (codes.length === 0 || codes.some((c) => c === null)) return null;
  const unique = new Set(codes);
  return unique.size === 1 ? [...unique][0] : null;
}

/**
 * Currency for a money field that may not carry it per line. A currency is
 * only proposed when it is unambiguous across the whole package: a line field
 * that is a code on every line, an enclosing order's code, or a batch-level
 * declaration. If two different codes appear, nothing is proposed and the
 * finding says so — a shared code would otherwise be a guess.
 */
function resolveCurrency({ keys, samples, parentSamples = [], allowParent, parentKeys, bundle, used }) {
  const key = bestKey(keys, 'currency', used);
  const lineValues = key ? samples.map((s) => getPath(s, key).value) : [];
  const lineCodes = new Set(
    lineValues.filter((v) => typeof v === 'string' && /^[A-Za-z]{3}$/.test(v)).map((v) => v.toUpperCase()),
  );
  if (key && lineValues.length && lineValues.every((v) => typeof v === 'string' && /^[A-Za-z]{3}$/.test(v))) {
    if (lineCodes.size === 1) return { path: key, scope: 'line', code: [...lineCodes][0], detail: `currency field ${JSON.stringify(key)} is a constant code` };
    return { path: key, scope: 'line', code: null, detail: `currency field ${JSON.stringify(key)} varies per line and is read per line` };
  }
  const parentKey = allowParent ? parentKeys.find((k) => HINTS.currency.some((r) => r.test(k))) : null;
  if (parentKey) {
    const codes = new Set(
      parentSamples
        .map((p) => getPath(p, parentKey).value)
        .filter((v) => typeof v === 'string' && /^[A-Za-z]{3}$/.test(v))
        .map((v) => v.toUpperCase()),
    );
    if (codes.size === 1) return { path: `parent.${parentKey}`, scope: 'parent', code: [...codes][0], detail: `currency is declared once per enclosing order at ${JSON.stringify(parentKey)}` };
    if (codes.size > 1) return { path: null, scope: null, code: null, detail: 'enclosing orders declare different currencies; no shared currency was mapped' };
  }
  const path = batchCurrency(bundle);
  if (path) {
    const hit = getPath(bundle, path);
    const code = typeof hit.value === 'string' ? hit.value.toUpperCase() : null;
    return { path: `root.${path}`, scope: 'root', code, detail: `currency is declared once for the batch at ${path}` };
  }
  return { path: null, scope: null, code: null, detail: null };
}

/** Search the batch object for a single currency declaration. */
function batchCurrency(bundle, depth = 0, path = '') {
  if (depth > 4 || !isPlainObject(bundle)) return null;
  for (const key of Object.keys(bundle)) {
    if (HINTS.currency.some((r) => r.test(key)) && typeof bundle[key] === 'string' && /^[A-Za-z]{3}$/.test(bundle[key])) {
      return path ? `${path}.${key}` : key;
    }
  }
  for (const key of Object.keys(bundle)) {
    if (isPlainObject(bundle[key])) {
      const hit = batchCurrency(bundle[key], depth + 1, path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
  }
  return null;
}

function batchCurrencyCode(bundle, depth = 0) {
  if (depth > 4 || !isPlainObject(bundle)) return null;
  for (const key of Object.keys(bundle)) {
    if (HINTS.currency.some((r) => r.test(key)) && typeof bundle[key] === 'string' && /^[A-Za-z]{3}$/.test(bundle[key])) return bundle[key].toUpperCase();
  }
  for (const key of Object.keys(bundle)) {
    if (isPlainObject(bundle[key])) {
      const hit = batchCurrencyCode(bundle[key], depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Build selectors for a collection of line objects. `parentScope` is true when
 * the collection lives inside orders, making "parent." available.
 */
function objectLineSelectors({ samples, keys, allowParent, parentKeys = [], parentSamples = [] }, bundle) {
  const selectors = {};
  const findings = [];
  const used = new Set();
  const add = (field, path, target, steps = []) => {
    if (selectors[field]) return false;
    const sel = { path, target };
    if (steps.length) sel.steps = steps;
    selectors[field] = sel;
    used.add(path);
    return true;
  };
  const pick = (field, role, target, extra = {}) => {
    const key = bestKey(keys, role, used);
    if (!key) return null;
    const samplesFor = samples.map((s) => ({ path: key, value: getPath(s, key).value ?? null, kind: valueKind(getPath(s, key).value) })).filter((s) => s.value !== undefined);
    let steps;
    if (target === 'integer') steps = numberSteps(samplesFor, { integer: true });
    else if (target === 'decimal') steps = numberSteps(samplesFor);
    else steps = stringSteps(samplesFor);
    if (steps === null) {
      findings.push({ code: 'N_UNREADABLE_FIELD', field, detail: `${field}: values at ${JSON.stringify(key)} have a shape no declared step can read; field left unmapped` });
      return null;
    }
    if (add(field, key, target, steps)) return { key, steps, samples: samplesFor };
    return null;
  };

  const idKey = bestKey(keys, 'line_id', new Set());
  if (idKey) {
    const samplesFor = samples.map((s) => ({ value: getPath(s, idKey).value ?? null, kind: valueKind(getPath(s, idKey).value) }));
    add('line_id', idKey, 'string', stringSteps(samplesFor));
  }
  const skuPick = pick('sku', 'sku', 'string');
  const descPick = pick('description', 'description', 'string');
  const qtyPick = pick('quantity', 'quantity', 'integer');
  const unitPick = pick('unit', 'unit', 'string');

  // Price / amount: prefer distinct fields; fall back to amount-only.
  let priceKey = bestKey(keys, 'unit_price', used);
  let amountKey = bestKey(keys, 'amount', used);
  if (priceKey && amountKey && priceKey === amountKey) priceKey = null;
  let pricePick = null;
  let amountPick = null;
  const variants = [];
  for (const [field, key] of [['unit_price', priceKey], ['amount', amountKey]]) {
    if (!key) continue;
    const samplesFor = samples.map((s) => ({ value: getPath(s, key).value ?? null }));
    const posVariants = positionalVariants(samplesFor);
    if (posVariants) {
      // Do not pick a position for the operator: emit one candidate per reading.
      variants.push({
        field,
        key,
        samples: samplesFor,
        variants: posVariants,
        finding: {
          code: 'N_AMBIGUOUS_ARRAY',
          field,
          detail: `${field} at ${JSON.stringify(key)} is a ${posVariants.length}-element array on every line; its meaning is ambiguous. Each candidate reads a different position and leaves the others raw-only.`,
        },
      });
      continue;
    }
    const steps = numberSteps(samplesFor);
    if (steps === null) findings.push({ code: 'N_UNREADABLE_FIELD', field, detail: `${field} values at ${JSON.stringify(key)} are unreadable by any declared step; field left unmapped and flagged for review` });
    else if (add(field, key, 'decimal', steps)) {
      if (field === 'unit_price') pricePick = { key, steps, samples: samplesFor };
      else amountPick = { key, steps, samples: samplesFor };
    }
  }

  // Currency: explicit line field, then the enclosing order, then the batch.
  // A shared code is only proposed when the whole package agrees on it; when
  // money text itself carries the code, reading it from there is exact.
  const moneyPicks = [pricePick, amountPick].filter(Boolean);
  const embedded = moneyPicks.map((p) => currencyFromSamples(p.samples ?? [])).find(Boolean);
  if (embedded) {
    const pick = moneyPicks.find((p) => currencyFromSamples(p.samples ?? []) === embedded);
    add('currency', pick.key, 'string', [{ human_amount: true }, { currency: true }, { case: 'upper' }]);
    findings.push({ code: 'N_CURRENCY_FROM_MONEY', detail: `currency is embedded in every value of ${JSON.stringify(pick.key)} and read from it` });
  } else {
    const resolved = resolveCurrency({ keys, samples, parentSamples, allowParent, parentKeys, bundle, used });
    if (resolved.path) {
      const steps = resolved.scope === 'root' || resolved.scope === 'parent' ? [{ currency: true }, { case: 'upper' }] : [{ currency: true }, { case: 'upper' }];
      add('currency', resolved.path, 'string', steps);
      findings.push({ code: 'N_CURRENCY_SCOPE', detail: resolved.detail });
    } else if (resolved.detail) {
      findings.push({ code: 'N_CURRENCY_AMBIGUOUS', detail: resolved.detail });
    }
  }

  // line_id fallback: derive from SKU + position.
  if (!selectors.line_id) {
    const skuPath = skuPick?.key;
    // line_id reads the SKU path; the derived value comes from parts, so a
    // collection whose SKU is already unique keeps a stable id.
    add('line_id', skuPath ?? keys[0] ?? '', 'string', [{ derived_line_id: { parts: ['sku', '$seq'] } }]);
    findings.push({ code: 'N_DERIVED_LINE_ID', detail: `no identifier field; line_id derived from ${skuPath ? 'SKU and ' : ''}array position, which is only stable while order is preserved` });
  }
  return { selectors, findings, variants };
}

/** Build selectors for positional arrays: ["SKU", "desc", qty, price, total]. */
function positionalSelectors(rows, bundle) {
  const width = Math.max(...rows.map((r) => r.length));
  const columns = [];
  for (let i = 0; i < width; i++) {
    const values = rows.map((r) => r[i]).filter((v) => v !== undefined);
    const nums = values.filter((v) => typeof v === 'number');
    const money = values.filter((v) => typeof v === 'string' && MONEY_TEXT.test(v) && parseHumanAmount(v) !== null && /[,$€£¥₹]|\bUSD\b/.test(v));
    columns.push({
      i,
      values,
      numeric: nums.length === values.length && nums.every((v) => Number.isFinite(v)),
      integer: nums.length === values.length && nums.every((v) => Number.isInteger(v)),
      money: money.length === values.length && money.length > 0,
      text: values.every((v) => typeof v === 'string'),
      currency: values.every((v) => typeof v === 'string' && CURRENCY_TEXT.test(v) && /^[A-Z]{3}$/.test(v)),
      missing: values.length < rows.length,
    });
  }
  const take = (pred) => {
    const col = columns.find((c) => !c.taken && pred(c) && !c.missing);
    if (col) col.taken = true;
    return col;
  };
  const selectors = {};
  const findings = [];
  // The selector path is empty: it targets the line itself, which is the
  // positional array. array_item then picks the column.
  const assign = (field, col, target, steps = []) => {
    if (!col) return;
    selectors[field] = { path: '', target, steps: [{ array_item: col.i }, ...steps] };
  };
  assign('line_id', take((c) => c.text && /^[A-Za-z0-9][A-Za-z0-9._/-]{1,}$/.test(c.values[0] ?? '') && !c.money && !c.currency), 'string');
  assign('sku', take((c) => c.text && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(c.values[0] ?? '') && !c.money && !c.currency), 'string', [{ case: 'upper' }]);
  assign('description', take((c) => c.text && !c.money && !c.currency && /\s/.test(c.values[0] ?? '')), 'string');
  assign('quantity', take((c) => c.numeric && c.integer), 'integer', []);
  // Money columns: the last money/numeric column is the line total, earlier ones
  // are unit prices. With a single money column it is the unit price.
  const moneyCols = columns.filter((c) => !c.taken && (c.money || c.numeric));
  if (moneyCols.length >= 2) {
    const total = moneyCols.at(-1);
    const price = moneyCols.at(-2);
    price.taken = true;
    total.taken = true;
    assign('unit_price', price, 'decimal', price.money ? [{ human_amount: true }] : []);
    assign('amount', total, 'decimal', total.money ? [{ human_amount: true }] : []);
  } else if (moneyCols.length === 1) {
    const only = moneyCols[0];
    only.taken = true;
    assign('unit_price', only, 'decimal', only.money ? [{ human_amount: true }] : []);
  }
  assign('currency', take((c) => c.currency), 'string', [{ currency: true }, { case: 'upper' }]);
  assign('unit', take((c) => c.text && !c.money), 'string');
  if (!selectors.currency) {
    const path = batchCurrency(bundle);
    if (path) {
      selectors.currency = { path: `root.${path}`, target: 'string', steps: [{ currency: true }, { case: 'upper' }] };
      findings.push({ code: 'N_BATCH_CURRENCY', detail: `currency is declared once for the batch at ${path}` });
    }
  }
  const unmapped = columns.filter((c) => !c.taken).map((c) => c.i);
  if (unmapped.length) findings.push({ code: 'N_UNASSIGNED_POSITION', detail: `array position(s) ${unmapped.join(', ')} are not mapped and stay raw-only` });
  if (!selectors.line_id && selectors.sku) {
    selectors.line_id = { path: '', target: 'string', steps: [{ array_item: Number(selectors.sku.steps[0].array_item) }, { derived_line_id: { parts: ['$seq'] } }] };
  }
  for (const [field, sel] of Object.entries(selectors)) {
    const pos = sel.steps[0]?.array_item;
    const col = columns[pos];
    if (col?.missing) findings.push({ code: 'N_RAGGED_ROWS', field, detail: `${field}: position ${pos} is absent in some rows; those lines will be marked partial, not filled` });
  }
  return { selectors, findings, unmapped };
}

/** Derive all candidate mappings for one package. */
export function deriveCandidates(bundle, { sourceId, baseVersion = 0, crashAfter = 0 } = {}) {
  const all = findCollections(bundle);
  const collections = all.filter((c) => c.score >= 15);
  if (collections.length === 0) collections.push(...all.slice(0, 1));
  const seen = new Set();
  const out = [];
  let worked = 0;
  for (const c of collections.slice(0, 8)) {
    // Demo/test hook: die abruptly after `crashAfter` collections, leaving no
    // result. The parent records a crash; nothing is half-written.
    if (crashAfter > 0 && ++worked >= crashAfter) process.kill(process.pid, 'SIGKILL');

    if (c.kind === 'split_array') continue;

    if (c.kind === 'array_of_arrays') {
      const { selectors, findings } = positionalSelectors(c.samples, bundle);
      if (!selectors.sku || !selectors.line_id) continue;
      const spec = baseSpec(sourceId, baseVersion, {
        label: `positional rows ${c.path}`,
        lines: { path: c.path, mode: 'array' },
        detected: { path: c.path, kind: c.kind, records: c.records, widths: c.widths },
        selectors,
        findings: [...findings, { code: 'N_POSITIONAL', detail: 'each line is a positional array; fields are read by index, so a newly inserted column shifts later positions' }],
      });
      out.push(scored(spec, 0.6, findings, 'positional'));
      continue;
    }

    const allowParent = c.wildcard && c.parentPath !== null;
    const built = objectLineSelectors(
      {
        samples: c.samples.map((s) => s),
        keys: c.keys,
        parentKeys: c.parentKeys ?? [],
        parentSamples: c.parentSamples ?? [],
        allowParent,
      },
      bundle,
    );
    const { selectors, findings, variants } = built;
    const notes = [];
    if (allowParent) notes.push({ code: 'N_PARENT_SCOPE', detail: `lines are nested under ${JSON.stringify(c.parentPath)}; batch values may be read as "parent.<field>"` });
    if (!selectors.sku || !selectors.line_id) {
      out.push(scored(baseSpec(sourceId, baseVersion, { label: `unusable ${c.path}`, lines: { path: c.path, mode: c.kind === 'object_map' ? 'object_of_objects' : 'array' }, detected: { path: c.path, kind: c.kind, records: c.records }, selectors, findings: [...findings, { code: 'E_NO_IDENTITY', detail: 'no SKU or identifier could be inferred; this collection cannot be ingested without a hand-written mapping' }] }), 0.1, findings, 'unusable'));
      continue;
    }
    const dedupeKey = `${c.kind}|${c.path}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // One candidate per variant of an ambiguous field; otherwise one candidate.
    const expansions = [];
    const ambiguous = variants.filter((v) => v.variants.length > 1);
    if (ambiguous.length) {
      // Cross-product is intentionally avoided; only the first ambiguous field is
      // expanded, and other variants are reported so they are not forgotten.
      const primary = ambiguous[0];
      for (const variant of primary.variants) {
        expansions.push({ primary, variant, rest: ambiguous.slice(1) });
      }
      for (const extra of ambiguous.slice(1)) {
        notes.push({ code: 'N_AMBIGUOUS_OTHER', field: extra.field, detail: `${extra.field} at ${JSON.stringify(extra.key)} is also multi-valued; this candidate leaves it unmapped` });
      }
    } else {
      expansions.push({ primary: null, variant: null, rest: [] });
    }

    for (const { primary, variant } of expansions) {
      const sel = { ...selectors };
      const ev = [...findings, ...notes];
      if (primary && variant) {
        sel[primary.field] = { path: primary.key, target: 'decimal', steps: variant.steps };
        ev.push(primary.finding);
        ev.push({
          code: 'N_VARIANT_CHOICE',
          field: primary.field,
          detail: `${primary.field}: candidate reads element ${variant.position} of ${JSON.stringify(primary.key)}; the other ${primary.variants.length - 1} element(s) stay raw-only`,
        });
        for (const extra of ambiguous.slice(1)) ev.push({ code: 'N_AMBIGUOUS_OTHER', field: extra.field, detail: `${extra.field} at ${JSON.stringify(extra.key)} is also multi-valued and stays unmapped in this candidate` });
      }
      const label = primary && variant
        ? `${c.wildcard ? 'per-order lines' : c.kind === 'object_map' ? 'line map' : 'line array'} ${c.path} — ${primary.field}[${variant.position}]`
        : `${c.wildcard ? 'per-order lines' : c.kind === 'object_map' ? 'line map' : 'line array'} ${c.path}`;
      const spec = baseSpec(sourceId, baseVersion, {
        label,
        lines: { path: c.path, mode: c.kind === 'object_map' ? 'object_of_objects' : 'array' },
        detected: { path: c.path, kind: c.kind, records: c.records, keys: c.keys },
        selectors: sel,
        findings: ev,
      });
      const mapped = Object.keys(sel).filter((k) => ['line_id', 'sku', 'description', 'quantity', 'unit_price', 'amount', 'currency', 'unit'].includes(k));
      const confident = 0.4 + mapped.length * 0.06 + Math.min(c.records, 10) * 0.015 + (c.pretty ?? 1) * 0.03 + (c.wildcard ? 0.02 : 0);
      out.push(scored(spec, Math.min(0.98, confident) - (primary ? 0.08 : 0), ev, c.kind));
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

function baseSpec(sourceId, baseVersion, { label, lines, detected, selectors, findings }) {
  return {
    spec: SPEC_VERSION,
    source_id: sourceId,
    version: baseVersion + 1,
    label,
    detected_from: detected,
    lines,
    selectors,
    notes: {},
    findings,
  };
}

function scored(spec, confidence, findings, family) {
  return { spec, label: spec.label, family, confidence: Number(confidence.toFixed(3)), notes: findings };
}
