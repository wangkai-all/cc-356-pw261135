# Contract Gate

Multiple suppliers send the same kind of line-item detail in different, evolving
shapes. Contract Gate keeps every original response byte-for-byte, studies new
structures in a separate process, and only lets an operator-approved, versioned
mapping move data into the agreed contract. Nothing is silently dropped and one
supplier's revision never blocks another's.

```
fixture sources ──collect──▶ raw package (sha256) ──detect worker──▶ candidate mappings
                                     │                                      │
                                     │                            operator drafts/approves
                                     ▼                                      ▼
                               replay / re-ingest ◀──────────── approved mapping (versioned)
                                     │
                                     ▼
                         contract-gated lines + per-field losses + audit runs
```

## Run it

Requires Node.js 24 (uses `node:sqlite`, `fetch` and `node:test`; no dependencies).

```bash
npm start                      # console + API on :4200, fixture sources on :4100
SEED_ON_START=0 npm start      # empty instance, no demo data
PORT=4300 FIXTURE_PORT=4100 npm start
npm test                       # unit + end-to-end tests
npm run smoke                  # against a running instance (BASE=... to point elsewhere)
```

Open <http://127.0.0.1:4200/>. The three fixture suppliers are seeded on first
start; their baseline batches are collected and detection runs, but **nothing is
approved automatically**. That is the decision point the page is built around.

## What is decided where

| Stage | Module | Rule |
| --- | --- | --- |
| Collection | `src/collect.js` | store the exact response bytes under `data/raw/<source>/<batch>.r<n>.json` and record `sha256`. Never interpret. |
| Detection | `src/detect.js`, `src/detect-worker.js` | propose candidate mappings from observed structure. Runs in a child process; a crash is a real process death and leaves the package untouched. |
| Contract | `src/spec.js` | `validateMapping` (document shape) and `buildReadPlan` (resolve selectors against the actual package). The plan is the closed set of locations ingestion may read. |
| Ingestion | `src/ingest.js`, `src/line-eval.js` | verify raw bytes, execute the plan, coerce to the contract, record provenance and losses. |
| Policy | `db.js` (`sources.policy`) | `per_field` (degrade per field) or `whole_source` (quarantine the package as a unit). |

### The contract

`line_id` and `sku` are required; `description`, `quantity` (integer),
`unit_price` and `amount` (canonical 2dp text), `currency` (3-letter code) and
`unit` (text) are optional. A field that cannot be coerced is marked
`absent`/`rejected`/`type_mismatch`, never rounded or guessed; a fractional
quantity is refused outright.

### The mapping document (`cg.map/1`)

```jsonc
{
  "spec": "cg.map/1",
  "source_id": "northwind",
  "version": 2,
  "lines": { "path": "orders.*.lines", "mode": "array" },
  "selectors": {
    "line_id":    { "path": "line_id", "target": "string" },
    "sku":        { "path": "sku", "target": "string" },
    "quantity":   { "path": "qty", "target": "integer", "steps": [{ "unwrap": true }, { "number": true }] },
    "unit_price": { "path": "price", "target": "decimal", "steps": [{ "unwrap": "amount" }, { "human_amount": true }] },
    "amount":     { "path": "total", "target": "decimal", "steps": [{ "human_amount": true }] },
    "currency":   { "path": "parent.currency", "target": "string", "steps": [{ "currency": true }, { "case": "upper" }] }
  },
  "notes": {}
}
```

* `lines.path` — dotted path; one optional `*` iterates an array and exposes that
  element as `parent.<path>` to selectors. `mode` is `array` or
  `object_of_objects`.
* Selector paths are relative to one line. `root.` reads the package envelope;
  `parent.` reads the wildcard element (e.g. an order). An empty path means the
  line itself (positional rows and packed strings) and requires an `array_item`,
  `split` or `$key`-based `derived_line_id` step.
* Steps, executed in order: `array_item`, `unwrap` (a single-element array
  unwraps; a string unwraps a nested key and passes scalars through unchanged),
  `number`, `human_amount` (`"$1,234.50"`, `"(12.00)"`, `"3,720.00 USD"`; ambiguous
  strings return `null`), `currency`, `trim`, `case`, `replace`, `split`,
  `coalesce`, `default`, `derived_line_id` (`$seq` / `$key` supported),
  `identity`, `match`.
* If two fields read the same location, each must have a `notes` entry
  explaining why (`E_ALIAS_UNDOCUMENTED` otherwise).

See [`docs/mapping.md`](docs/mapping.md) for the full selector reference and
[`docs/operations.md`](docs/operations.md) for the lifecycle and demo script.

## Isolation policy

* **`per_field`** (default) — every line that has a readable `line_id` and `sku`
  lands. A field the source changed shape for is recorded with its raw value and
  the reason; under `per_field` the previously stored value is retained and a
  `retained` loss is recorded. Other lines and other sources are unaffected.
* **`whole_source`** — if the read plan has any line-level problem, or any line
  fails required fields, the package is quarantined as a unit: rows are stored
  for inspection, `applied = 0` for all of them, and current state is untouched.

The package page always states which records are usable (`ok + partial` of total)
and the run page lists every loss with its raw source value, so "what did we
lose?" has an answer per field.

## Mapping lifecycle

```
draft ──approve──▶ approved ──approve newer──▶ superseded
                       └────revoke──▶ revoked  (source has no active mapping)
```

Approving a new version retires the previous one atomically; the source is never
unmapped in between. Approval re-runs every package that is **not cleanly
applied** (including `partial`, `quarantined` and `awaiting_mapping`) with the new
version and leaves a reason for anything it still cannot read. A cleanly applied
package is only re-read by an explicit replay. Revocation is immediate: new
collections wait at `awaiting_mapping`, old lines stay, and the revoked document
is kept for audit.

## Replay

`POST /api/ingest/replay {package_id}` re-reads the stored bytes, verifies their
`sha256`, and appends a new run. If the bytes changed on disk, replay refuses
with `E_RAW_CHANGED`; it never re-fetches from the supplier. Old runs are kept, so
before/after is auditable.

## Detection failures

Detection runs as `node src/detect-worker.js <jobId> <dbFile>`. A non-zero exit
or signal marks the job `crashed`, the package `needs_attention`, and leaves the
package and its raw bytes untouched. Retries are counted and bounded
(`MAX_ATTEMPTS = 3`). On startup the supervisor sweeps jobs whose PID is gone and
marks them crashed rather than leaving them `running` forever. `crash_after` in
`POST /api/detect` injects a SIGKILL after N collections for the demo; a retry
clears it.

## Layout

```
src/
  server.js        HTTP API + static console, one state endpoint for polling
  db.js            node:sqlite schema, migrations, store
  collect.js       source registry, byte-exact collection
  detect.js        structural candidate derivation
  detect-worker.js child process: verify bytes, derive, validate, plan, store result
  supervisor.js    spawn, crash detection, bounded retry, startup sweep
  spec.js          contract, selector evaluation, validation, read plan, extraction
  line-eval.js     per-line evaluation, losses, provenance, changes
  ingest.js        policy, runs, current state, replay, apply-on-approval
  seed.js          demo sources and baselines (never approves)
  main.js          boot + fixture source server
public/            operator console (no build step)
fixtures/          the three evolving supplier payloads
test/              unit tests and end-to-end tests (real processes, temp DBs)
scripts/smoke.js   additive health/demo check against a running instance
```

## Data

`data/contract-gate.sqlite3` plus `data/raw/**`. Delete `data/` to start clean;
raw packages are never rewritten by the app.
