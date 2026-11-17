# Mapping reference (`cg.map/1`)

A mapping is an immutable, versioned JSON document. Structure detection proposes
them; an operator drafts, edits, approves or revokes them. Only an approved
mapping can move data, and every package is read through exactly one approved
mapping at a time.

## Document

```jsonc
{
  "spec": "cg.map/1",          // required, exact
  "source_id": "northwind",    // required, must match the package
  "version": 3,                // assigned by the server on draft
  "label": "packed strings",   // shown in the console
  "lines": { "path": "lines", "mode": "array" },
  "selectors": { "<contract field>": <selector>, ... },
  "notes": { "<field>": "why two fields share a location" }
}
```

* `lines.path` — dotted keys, at most one `*`. The wildcard iterates one array
  element and makes that element available as `parent.<path>`. Examples:
  `lines`, `rows`, `orders.*.lines`, `envelope.items.*.details`.
* `lines.mode` — `array` (each item is an object, positional array or packed
  string) or `object_of_objects` (a map: each key is the line, each value the
  line body; `$key` is the map key).
* `selectors` — must contain `line_id` and `sku`, and only fields from the
  agreed contract. Unknown fields are validation errors (`E_UNKNOWN_FIELD`), so
  the ingestion end cannot be widened by accident.

### Selector

```jsonc
{ "path": "unit_price", "target": "decimal", "steps": [ { "unwrap": "value" }, { "human_amount": true } ] }
```

`path` is relative to the line. `root.x` reads the package envelope; `parent.x`
reads the wildcard element. `""` is the line itself (positional rows, packed
strings) and must include an `array_item`, `split` or `$key` derivation step.

`target` must be compatible with the contract field: `string` (string/currency),
`integer` (integer), `decimal` (decimal). The read plan checks each selector
against the real package: a path that matches nothing is `fatal`; an observed
kind the steps cannot read is a `line` problem (degradable under `per_field`,
quarantining under `whole_source`).

### Steps

| Step | Meaning |
| --- | --- |
| `array_item: n` | select position `n`; a missing position or non-array is a line problem, never a guess. |
| `unwrap: true` | unwrap a single-element array. More than one element is `type_mismatch` (ambiguous). |
| `unwrap: "key"` | unwrap one element (if array), then read `key` from the object; scalars pass through unchanged. |
| `number: true` | parse a clean numeric string (no currency, no separators) to a number. |
| `human_amount: true` | parse `"$1,234.50"`, `"1234.5"`, `"(12.00)"`, `"3,720.00 USD"`; captures an embedded currency. Formats that are ambiguous between decimal conventions (e.g. `"1.234,50"`, `"1,23.4"`) return `type_mismatch` rather than a guess. |
| `currency: true` | validate/normalize a 3-letter code; reuses a code captured by `human_amount`. |
| `trim: true` / `case: "upper" \| "lower"` / `replace: {from,to}` | text cleanup. |
| `split: "|"` | split a packed string into parts; follow with `array_item`. |
| `coalesce: ["a","b"]` | first present, non-empty path (may use `root.`/`parent.`). |
| `default: v` | explicit operator-chosen fallback. Never implicit. |
| `derived_line_id: {parts:["$key"], separator?}` | compose an id; `$seq` and `$key` are built-ins. |
| `match: v` | keep the value only when it equals `v` (used to filter paired arrays). |
| `identity: true` | no-op, for readability. |

## Losses

Per line, each contract field carries `{status, value, raw, reason, notes, origin}`.
`raw` is the value exactly as selected from the package, kept even when coercion
fails. Losses are recorded as:

| kind | meaning |
| --- | --- |
| `absent` | the source does not contain the value |
| `type_mismatch` | the source contains a value the declared steps cannot read |
| `coercion` | the value was read but cannot be stored under the contract (e.g. fractional quantity) |
| `retained` | `per_field` kept the previously stored value; the run still records this package could not supply it |
| `normalize` | provenance only (a declared transformation); excluded from the loss summary |

Unmapped source fields are listed per line (`unmapped`), so adding a field at the
supplier is visible without being auto-ingested.

## Examples

Baseline object array (numbers):

```jsonc
{
  "lines": { "path": "lines", "mode": "array" },
  "selectors": {
    "line_id":    { "path": "line_id", "target": "string" },
    "sku":        { "path": "sku", "target": "string" },
    "description":{ "path": "description", "target": "string" },
    "quantity":   { "path": "quantity", "target": "integer", "steps": [{ "number": true }] },
    "unit_price": { "path": "unit_price", "target": "decimal", "steps": [{ "number": true }] },
    "amount":     { "path": "amount", "target": "decimal", "steps": [{ "number": true }] },
    "unit":       { "path": "unit", "target": "string" },
    "currency":   { "path": "root.currency", "target": "string", "steps": [{ "currency": true }, { "case": "upper" }] }
  }
}
```

Positional rows (`[["AC-1","acme-77","Hex bolt",10,2.25,22.5], ...]`):

```jsonc
{
  "lines": { "path": "rows", "mode": "array" },
  "selectors": {
    "line_id":    { "path": "", "target": "string", "steps": [{ "array_item": 0 }] },
    "sku":        { "path": "", "target": "string", "steps": [{ "array_item": 1 }] },
    "quantity":   { "path": "", "target": "integer", "steps": [{ "array_item": 3 }] },
    "unit_price": { "path": "", "target": "decimal", "steps": [{ "array_item": 4 }] },
    "amount":     { "path": "", "target": "decimal", "steps": [{ "array_item": 5 }] }
  }
}
```

Packed string lines (`{"NW-1":"nw-1001|4|12.50"}`):

```jsonc
{
  "lines": { "path": "lines", "mode": "object_of_objects" },
  "selectors": {
    "line_id":    { "path": "", "target": "string", "steps": [{ "derived_line_id": { "parts": ["$key"] } }] },
    "sku":        { "path": "", "target": "string", "steps": [{ "split": "|" }, { "array_item": 0 }] },
    "quantity":   { "path": "", "target": "integer", "steps": [{ "split": "|" }, { "array_item": 1 }, { "number": true }] },
    "unit_price": { "path": "", "target": "decimal", "steps": [{ "split": "|" }, { "array_item": 2 }, { "number": true }] },
    "currency":   { "path": "root.currency", "target": "string", "steps": [{ "currency": true }] }
  }
}
```

Ambiguous arrays are never picked automatically. The detector emits one
candidate per position, each with `N_AMBIGUOUS_ARRAY` and `N_VARIANT_CHOICE`
notes; approving one is the human decision. A read plan that refuses the package
for every candidate produces no candidate at all and the package waits for a
hand-written mapping.

## Approve, supersede, revoke

* Approving a draft makes it the source's only `approved` mapping; a previous
  approved version becomes `superseded` with `superseded_by` pointing at the new
  one, in one transaction.
* Approval immediately replays every package not cleanly applied. Packages the
  new version still cannot read stay `awaiting_mapping` with a recorded reason.
* Revoking an approved mapping is immediate. The source has no active mapping,
  new collections stop at `awaiting_mapping`, and a replacement must go through
  draft → approve again. Revoked mappings cannot be re-approved.
