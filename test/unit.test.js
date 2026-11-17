// Unit tests for the contract layer: path grammar, money parsing, coercion,
// mapping validation, read plans, and candidate derivation over the fixtures.
// Nothing here touches the database or spawns processes; the end-to-end tests
// cover those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePath,
  parseLinesPath,
  selectorScope,
  canonicalDecimal,
  parseHumanAmount,
  coerce,
  extractLines,
  validateMapping,
  buildReadPlan,
  unmappedFields,
  SPEC_VERSION,
} from '../src/spec.js';
import { evaluateLine } from '../src/line-eval.js';
import { deriveCandidates } from '../src/detect.js';
import { sha256, stableStringify, jaccard } from '../src/util.js';
import { loadFixtures } from '../src/source-server.js';

const fixtures = loadFixtures();
const batch = (source, name) => fixtures.by_source[source].find((b) => b.name === name).body;

// ------------------------------------------------------------------- paths

test('parsePath accepts dotted keys and array positions, rejects junk', () => {
  assert.deepEqual(parsePath('a.b.0'), ['a', 'b', '0']);
  assert.deepEqual(parsePath(''), []);
  assert.throws(() => parsePath('a..b'), { code: 'E_PATH' });
  assert.throws(() => parsePath('a b'), { code: 'E_PATH' });
  assert.throws(() => parsePath('a.*'), { code: 'E_PATH' });
});

test('parseLinesPath allows exactly one non-terminal wildcard', () => {
  assert.deepEqual(parseLinesPath('orders.*.lines'), ['orders', '*', 'lines']);
  assert.deepEqual(parseLinesPath('rows'), ['rows']);
  assert.throws(() => parseLinesPath('*.orders.lines'), { code: 'E_LINES_PATH' });
  assert.throws(() => parseLinesPath('a.*.b.*.c'), { code: 'E_LINES_PATH' });
  assert.throws(() => parseLinesPath('orders.*'), { code: 'E_LINES_PATH' });
  assert.throws(() => parseLinesPath(''), { code: 'E_LINES_PATH' });
});

test('selectorScope separates line, parent and batch scopes', () => {
  assert.deepEqual(selectorScope({ path: 'sku' }), { scope: 'line', path: 'sku' });
  assert.deepEqual(selectorScope({ path: 'parent.currency' }), { scope: 'parent', path: 'currency' });
  assert.deepEqual(selectorScope({ path: 'root.currency' }), { scope: 'root', path: 'currency' });
  assert.deepEqual(selectorScope({ path: '' }), { scope: 'line', path: '' });
  assert.deepEqual(selectorScope('parent.currency'), { scope: 'parent', path: 'currency' });
});

// ------------------------------------------------------------------- money

test('canonicalDecimal pins two decimal places without floating point drift', () => {
  assert.equal(canonicalDecimal(50), '50.00');
  assert.equal(canonicalDecimal(0.1 + 0.2), '0.30');
  assert.equal(canonicalDecimal('3.1'), '3.10');
  assert.equal(canonicalDecimal('-7.005'), '-7.00');
});

test('parseHumanAmount reads formatted text and refuses guesses', () => {
  const cases = [
    ['1,234.50 USD', { amount: '1234.50', currency: 'USD' }],
    ['$12.50', { amount: '12.50', currency: 'USD' }],
    [' € 9,99', null],
    ['(12.00)', { amount: '-12.00', currency: null }],
    ['-4.5', { amount: '-4.50', currency: null }],
    ['12.5 EUR', { amount: '12.50', currency: 'EUR' }],
    ['1,23.4', null],
    ['1.234.56', null],
    ['twelve', null],
    ['', null],
    [12.5, { amount: '12.50', currency: null }],
  ];
  for (const [input, expected] of cases) {
    const got = parseHumanAmount(input);
    if (expected === null) assert.equal(got, null, `expected null for ${JSON.stringify(input)}`);
    else {
      assert.equal(got.amount, expected.amount, `amount for ${JSON.stringify(input)}`);
      assert.equal(got.currency, expected.currency, `currency for ${JSON.stringify(input)}`);
    }
  }
});

test('coerce never rounds a fractional quantity', () => {
  assert.deepEqual(coerce('quantity', 4), { ok: true, value: 4 });
  assert.deepEqual(coerce('quantity', '1,200'), { ok: false, reason: '"1,200" is not an integer' });
  assert.equal(coerce('quantity', 2.5).ok, false);
  assert.equal(coerce('quantity', '2.5').ok, false);
  // Canonical decimal text that is integral is accepted, with a provenance note.
  assert.deepEqual(coerce('quantity', '1200.00'), { ok: true, value: 1200, note: 'trailing zeros dropped for integer storage' });
  assert.deepEqual(coerce('unit_price', 12.5), { ok: true, value: '12.50', note: 'number normalized to canonical decimal text' });
  assert.equal(coerce('unit_price', 'cheap').ok, false);
  assert.equal(coerce('currency', 'USD').value, 'USD');
});

// ---------------------------------------------------------------- extraction

test('extractLines iterates nested arrays and exposes the parent object', () => {
  const bundle = batch('globex', 'gx-orders-551');
  const out = extractLines(bundle, { path: 'orders.*.lines', mode: 'array' });
  assert.equal(out.ok, true);
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].parent.order_no, 'GX-551-A');
  assert.equal(out.items[0].parentPath, 'orders.0');
});

test('extractLines iterates object maps by key', () => {
  const bundle = batch('northwind', 'nw-2026-11-d');
  const out = extractLines(bundle, { path: 'lines', mode: 'object_of_objects' });
  assert.equal(out.ok, true);
  assert.equal(out.items.length, 3);
  assert.deepEqual(out.items.map((i) => i.key), ['NW-1', 'NW-2', 'NW-6']);
  assert.equal(out.items[0].value, 'nw-1001|4|12.50');
});

test('extractLines refuses a mode mismatch and reports absent paths', () => {
  const bundle = batch('northwind', 'nw-2026-11-a');
  const wrongMode = extractLines(bundle, { path: 'lines', mode: 'object_of_objects' });
  assert.equal(wrongMode.ok, false);
  assert.equal(wrongMode.problems[0].code, 'E_LINES_MODE');
  const absent = extractLines(bundle, { path: 'invoices', mode: 'array' });
  assert.equal(absent.ok, false);
  assert.equal(absent.problems[0].code, 'E_LINES_PATH');
});

// ---------------------------------------------------------------- validation

function minimal(selectors) {
  return {
    spec: SPEC_VERSION,
    source_id: 'test',
    version: 1,
    lines: { path: 'lines', mode: 'array' },
    selectors,
  };
}

test('validateMapping demands required fields and contract field names', () => {
  const missing = validateMapping(minimal({ sku: { path: 'sku', target: 'string' } }));
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.code === 'E_REQUIRED_FIELD'));

  const unknown = validateMapping(
    minimal({
      line_id: { path: 'id', target: 'string' },
      sku: { path: 'sku', target: 'string' },
      discount: { path: 'discount', target: 'decimal' },
    }),
  );
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => e.code === 'E_UNKNOWN_FIELD'));
});

test('validateMapping refuses a type that contradicts the contract', () => {
  const check = validateMapping(minimal({ line_id: { path: 'id', target: 'string' }, sku: { path: 'sku', target: 'integer' } }));
  assert.ok(check.errors.some((e) => e.code === 'E_TARGET_TYPE'));
});

test('validateMapping requires a note when two fields read one location', () => {
  const shared = {
    line_id: { path: 'id', target: 'string' },
    sku: { path: 'id', target: 'string' },
  };
  const undocumented = validateMapping(minimal(shared));
  assert.equal(undocumented.ok, false);
  assert.ok(undocumented.errors.some((e) => e.code === 'E_ALIAS_UNDOCUMENTED'));

  const documented = validateMapping({ ...minimal(shared), notes: { line_id: 'same identifier as sku in this feed', sku: 'shared identifier' } });
  assert.equal(documented.ok, true);
  assert.equal(Object.values(documented.aliases).length, 1);
});

test('validateMapping rejects unknown steps and malformed arguments', () => {
  const check = validateMapping(
    minimal({
      line_id: { path: 'id', target: 'string', steps: [{ magic: true }] },
      sku: { path: 'sku', target: 'string', steps: [{ array_item: -1 }] },
    }),
  );
  const codes = check.errors.map((e) => e.code);
  assert.ok(codes.includes('E_STEP_UNKNOWN'));
  assert.ok(codes.includes('E_STEP_ARRAY_ITEM'));
});

test('validateMapping accepts a packed-string mapping using split and $key', () => {
  const check = validateMapping({
    spec: SPEC_VERSION,
    source_id: 'northwind',
    version: 1,
    lines: { path: 'lines', mode: 'object_of_objects' },
    selectors: {
      line_id: { path: '', target: 'string', steps: [{ derived_line_id: { parts: ['$key'] } }] },
      sku: { path: '', target: 'string', steps: [{ split: '|' }, { array_item: 0 }] },
      quantity: { path: '', target: 'integer', steps: [{ split: '|' }, { array_item: 1 }, { number: true }] },
    },
  });
  assert.equal(check.ok, true, JSON.stringify(check.errors));
});

test('an empty selector path without a positional or key step is refused', () => {
  const check = validateMapping(minimal({ line_id: { path: '', target: 'string' }, sku: { path: 'sku', target: 'string' } }));
  assert.ok(check.errors.some((e) => e.code === 'E_PATH'));
});

// ---------------------------------------------------------------- read plans

test('buildReadPlan is fatal when the mapping targets a path the package lacks', () => {
  const plan = buildReadPlan(
    {
      spec: SPEC_VERSION,
      source_id: 'northwind',
      version: 1,
      lines: { path: 'lines', mode: 'array' },
      selectors: {
        line_id: { path: 'line_id', target: 'string' },
        sku: { path: 'never_here', target: 'string' },
      },
    },
    batch('northwind', 'nw-2026-11-a'),
  );
  assert.equal(plan.ok, false);
  assert.equal(plan.fatal, true);
  assert.ok(plan.problems.some((p) => p.code === 'E_PATH_UNKNOWN' && p.severity === 'fatal'));
});

test('text read as a decimal without a parsing step is a per-line problem, never fatal', () => {
  const bundle = batch('northwind', 'nw-2026-11-b');
  const spec = {
    spec: SPEC_VERSION,
    source_id: 'northwind',
    version: 1,
    lines: { path: 'lines', mode: 'array' },
    selectors: {
      line_id: { path: 'line_id', target: 'string' },
      sku: { path: 'sku', target: 'string' },
      amount: { path: 'amount', target: 'decimal' },
    },
  };
  const plan = buildReadPlan(spec, bundle);
  // A plan cannot know whether a given line's text is numeric, so it stays
  // executable and warns; the policy decides what to do when a line fails.
  assert.equal(plan.ok, true);
  assert.equal(plan.problems.length, 0);
  assert.ok(plan.notes.some((n) => n.code === 'N_TEXT_NO_STEP' && n.field === 'amount'));
  const { items } = extractLines(bundle, spec.lines);
  const ev = evaluateLine(items[0], spec, { bundle, seq: 0 });
  assert.equal(ev.status, 'partial');
  assert.equal(ev.fields.amount.status, 'rejected');
  assert.equal(ev.fields.amount.raw, '50.00 USD');
});

test('buildReadPlan accepts formatted money only because the step declares it', () => {
  const plan = buildReadPlan(
    {
      spec: SPEC_VERSION,
      source_id: 'northwind',
      version: 1,
      lines: { path: 'lines', mode: 'array' },
      selectors: {
        line_id: { path: 'line_id', target: 'string' },
        sku: { path: 'sku', target: 'string' },
        amount: { path: 'amount', target: 'decimal', steps: [{ human_amount: true }] },
      },
    },
    batch('northwind', 'nw-2026-11-b'),
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.problems.length, 0);
});

test('unmappedFields names source fields the mapping does not consume', () => {
  const line = batch('northwind', 'nw-2026-11-b').lines[2];
  const mapping = {
    selectors: {
      line_id: { path: 'line_id', target: 'string' },
      sku: { path: 'sku', target: 'string' },
      amount: { path: 'amount', target: 'decimal' },
    },
  };
  const unmapped = unmappedFields(line, mapping).map((u) => u.path);
  // Nested object fields are listed leaf-by-leaf, so the UI can name the exact
  // source location that was not ingested.
  assert.ok(unmapped.includes('unit_price.value'));
  assert.ok(unmapped.includes('unit_price.currency'));
  assert.ok(!unmapped.includes('sku'));
});

// -------------------------------------------------------------- line evaluation

function mappingFrom(spec) {
  const check = validateMapping(spec);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  return spec;
}

test('evaluateLine keeps raw values and reports a rejected currency without dropping the line', () => {
  const spec = mappingFrom({
    spec: SPEC_VERSION,
    source_id: 'northwind',
    version: 1,
    lines: { path: 'lines', mode: 'array' },
    selectors: {
      line_id: { path: 'line_id', target: 'string' },
      sku: { path: 'sku', target: 'string' },
      amount: { path: 'amount', target: 'decimal' },
      currency: { path: 'root.currency', target: 'string', steps: [{ currency: true }] },
    },
  });
  const bundle = batch('northwind', 'nw-2026-11-a');
  const { items } = extractLines(bundle, spec.lines);
  const ev = evaluateLine(items[0], spec, { bundle, seq: 0 });
  assert.equal(ev.status, 'ok');
  assert.equal(ev.amount, '50.00');
  assert.equal(ev.currency, 'USD');
  assert.equal(ev.fields.amount.raw, 50);
  assert.equal(ev.fields.currency.origin.scope, 'root');
});

test('evaluateLine refuses an ambiguous unwrap rather than picking an element', () => {
  const spec = mappingFrom({
    spec: SPEC_VERSION,
    source_id: 'northwind',
    version: 1,
    lines: { path: 'lines', mode: 'array' },
    selectors: {
      line_id: { path: 'line_id', target: 'string' },
      sku: { path: 'sku', target: 'string' },
      amount: { path: 'amount', target: 'decimal', steps: [{ unwrap: true }, { number: true }] },
    },
  });
  const bundle = batch('northwind', 'nw-2026-11-c');
  const { items } = extractLines(bundle, spec.lines);
  const ev = evaluateLine(items[0], spec, { bundle, seq: 0 });
  assert.equal(ev.status, 'partial');
  assert.equal(ev.amount, null);
  assert.equal(ev.fields.amount.status, 'rejected');
  assert.deepEqual(ev.fields.amount.raw, [50, 5]);
  assert.ok(ev.losses.some((l) => l.field === 'amount' && l.kind === 'type_mismatch'));
});

// -------------------------------------------------------------- derivation

function planFor(bundle, candidate) {
  return buildReadPlan(candidate.spec, bundle);
}

test('derivation finds a readable candidate for every baseline fixture', () => {
  for (const [source, name] of [
    ['northwind', 'nw-2026-11-a'],
    ['acme', 'acme-inv-7781'],
    ['globex', 'gx-orders-551'],
  ]) {
    const bundle = batch(source, name);
    const candidates = deriveCandidates(bundle, { sourceId: source });
    const usable = candidates.filter((c) => validateMapping(c.spec).ok && planFor(bundle, c).ok);
    assert.ok(usable.length >= 1, `${source}/${name} produced no usable candidate`);
    const spec = usable[0].spec;
    const { items } = extractLines(bundle, spec.lines);
    assert.ok(items.length > 0);
    const ev = evaluateLine(items[0], spec, { bundle, seq: 0 });
    assert.equal(ev.status, 'ok', `${source}/${name}: ${JSON.stringify(ev.losses)}`);
  }
});

test('derivation reads every new type in northwind b with a single mapping', () => {
  const bundle = batch('northwind', 'nw-2026-11-b');
  const candidates = deriveCandidates(bundle, { sourceId: 'northwind' });
  const usable = candidates.filter((c) => validateMapping(c.spec).ok && planFor(bundle, c).ok);
  assert.equal(usable.length, 1);
  const spec = usable[0].spec;
  const { items } = extractLines(bundle, spec.lines);
  const rows = items.map((item) => evaluateLine(item, spec, { bundle, seq: item.seq }));
  assert.deepEqual(
    rows.map((r) => [r.quantity, r.unit_price, r.amount]),
    [
      [4, '12.50', '50.00'],
      [100, '0.35', '35.00'],
      [1200, '3.10', '3720.00'],
    ],
  );
  assert.ok(rows.every((r) => r.status === 'ok'));
  // The unmapped supplier_note is reported, not dropped silently.
  assert.ok(rows[0].unmapped.some((u) => u.path === 'supplier_note'));
});

test('derivation offers one candidate per position for an ambiguous array', () => {
  const bundle = batch('northwind', 'nw-2026-11-c');
  const candidates = deriveCandidates(bundle, { sourceId: 'northwind' });
  const usable = candidates.filter((c) => validateMapping(c.spec).ok && planFor(bundle, c).ok);
  assert.equal(usable.length, 2);
  const positions = usable.map((c) => c.spec.selectors.amount.steps[0].array_item).sort();
  assert.deepEqual(positions, [0, 1]);
  const values = usable
    .sort((a, b) => a.spec.selectors.amount.steps[0].array_item - b.spec.selectors.amount.steps[0].array_item)
    .map((c) => {
      const { items } = extractLines(bundle, c.spec.lines);
      return evaluateLine(items[0], c.spec, { bundle, seq: 0 }).amount;
    });
  assert.deepEqual(values, ['50.00', '5.00']);
  for (const c of usable) {
    assert.ok(c.notes.some((n) => n.code === 'N_AMBIGUOUS_ARRAY'));
    assert.ok(c.notes.some((n) => n.code === 'N_VARIANT_CHOICE'));
  }
});

test('derivation reads the globex mixture of scalar, single-array and nested price', () => {
  const bundle = batch('globex', 'gx-orders-552');
  const candidates = deriveCandidates(bundle, { sourceId: 'globex' });
  const usable = candidates.filter((c) => validateMapping(c.spec).ok && planFor(bundle, c).ok);
  assert.ok(usable.length >= 1);
  const spec = usable[0].spec;
  const { items } = extractLines(bundle, spec.lines);
  const rows = items.map((item) => evaluateLine(item, spec, { bundle, seq: item.seq }));
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.sku, r.quantity, r.unit_price, r.currency]),
    [
      ['gx-9', 3, '9.99', 'EUR'],
      ['gx-10', 2, '14.50', 'EUR'],
      ['gx-11', 1, '7.25', 'EUR'],
    ],
  );
  assert.ok(rows.every((r) => r.status === 'ok'), JSON.stringify(rows.map((r) => r.losses)));
  assert.ok(rows[0].unmapped.some((u) => u.path.startsWith('dims.')));
});

test('derivation does not invent a candidate for packed-string lines', () => {
  const bundle = batch('northwind', 'nw-2026-11-d');
  const candidates = deriveCandidates(bundle, { sourceId: 'northwind' });
  const usable = candidates.filter((c) => validateMapping(c.spec).ok && planFor(bundle, c).ok);
  assert.equal(usable.length, 0);
});

test('derivation never proposes a candidate whose plan would refuse the package', () => {
  for (const [source, list] of Object.entries(fixtures.by_source)) {
    for (const { name, body } of list) {
      const candidates = deriveCandidates(body, { sourceId: source });
      for (const c of candidates) {
        const check = validateMapping(c.spec);
        if (!check.ok) continue; // unusable candidates are shown, marked refused
        const plan = buildReadPlan(c.spec, body);
        // A line-level problem is allowed (the policy can degrade); a fatal one
        // would make the proposal misleading, so it must be advertised as such.
        for (const p of plan.problems) {
          if (p.severity === 'fatal') assert.equal(plan.ok, false, `${source}/${name}: fatal plan with ok=true`);
        }
      }
    }
  }
});

// ------------------------------------------------------------------- util

test('sha256 and stableStringify are deterministic and order-insensitive', () => {
  assert.equal(sha256('abc'), sha256('abc'));
  assert.notEqual(sha256('abc'), sha256('abd'));
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
});
