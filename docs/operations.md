# Operating it

## Lifecycle at a glance

```
collect ──▶ received ──▶ queued_detection ──▶ detecting ──▶ detected
   │                (raw bytes + sha256)          │
   │                                              ├─▶ awaiting_mapping  (candidate ready, nothing approved)
   │                                              ├─▶ needs_mapping     (no candidate is executable)
   │                                              ├─▶ needs_attention   (worker crashed; package untouched)
   │                                              └─▶ detected          (active mapping still reads it)
   │
   ├─▶ awaiting_mapping   (no approved mapping for this source yet)
   ├─▶ applied / partial  (approved mapping landed it)
   ├─▶ quarantined        (whole_source policy refused the package as a unit)
   └─▶ incompatible       (read plan refused it outright: wrong structure)
```

Ingestion and detection run independently: an approved mapping keeps landing new
packages while detection studies a new shape. Detection can only move a package
out of its pre-ingest statuses; it never overwrites `applied`/`partial`/
`quarantined`.

## Page tour

* **Sources** — each supplier, its active mapping, its isolation policy, and its
  packages. `Collect` pulls a batch named in the picker.
* **Source** — switch `per_field`/`whole_source`, see which packages are waiting
  and why, collect more batches.
* **Package** — raw path, digest, detection job (pid, attempts, injected crash),
  whether the active mapping can read it, candidate mappings with validation and
  read-plan evidence, a hand-written mapping editor, and the run history.
* **Run** — "usable records" (ok + partial of total), losses by field, a line
  table showing each contract field's stored value, its raw source value and a
  status/reason, unmapped source fields, and changes vs the previous state.
* **Mappings / Mapping** — versions, statuses, fingerprints, the exact selector
  document, approve/revoke/delete. Revocation asks for a reason.
* **Events** — every state change with its reason.

## The three required demos

Start clean (`rm -rf data && npm start`) and open the console.

### 1. Old and new types interleaved

1. On **Sources → northwind**, collect `nw-2026-11-b` (numbers became
   `"$12.50"`, `"1,200"`, `"3,720.00 USD"`, and one price is an object).
   The run is `partial`: NW-1/NW-2 keep their old money values (recorded as
   `retained`), their text money is shown as `type_mismatch` raw; NW-4 is new
   and has no old value, so its unreadable fields are empty. `supplier_note` is
   reported unmapped.
2. Open the package: detection proposes one new mapping. Draft and approve it.
   v2 **supersedes** v1 and re-lands the package as `ok` with `4 / 12.50 / 50.00`,
   `100 / 0.35 / 35.00`, `1200 / 3.10 / 3720.00`.
3. Collect `nw-2026-11-c` (amount is now `[gross, discount]`). It is partial under
   v2. Detection offers **two** candidates, `amount[0]` and `amount[1]`, each
   noted `N_AMBIGUOUS_ARRAY` — the app will not pick one. Approving `amount[1]`
   lands the discounts.
4. Collect `nw-2026-11-d` (lines are packed strings). No candidate:
   `needs_mapping`. Other sources are unaffected. Use **Write a mapping by hand**
   with `split "|"` and `$key` to land it.

For the interleaved-shape case within one package, collect `gx-orders-552` on
globex: order A uses arrays, order B still uses scalars. The old mapping is
partial for A and clean for B; the approved unwrap mapping reads both.

### 2. Detection process crash

On any package, press **Crash detection (demo)**. The worker is a real child
process killed with SIGKILL: the job becomes `crashed`, the package
`needs_attention`, no candidate is produced, and the raw bytes are untouched.
Press **Retry detection**: it runs normally (attempts = 2). Repeating the crash
hits the bounded retry limit and then refuses further retries. A server restart
mid-detection is recovered by the startup sweep, which marks jobs whose PID is
gone as crashed instead of leaving them `running`.

### 3. Mapping approval revocation

On **Mappings → northwind@vN** press **Revoke** with a reason. The source drops
to no active mapping: collect any batch and it waits at `awaiting_mapping` with
the reason shown, while detection still proposes. Approve a replacement version
and the waiting package lands; the revoked document stays visible as history and
cannot be re-approved.

## Isolation policy

Per source, switchable at any time. It applies to future runs; use replay to
re-evaluate a stored package under the other policy.

* `per_field` — each line with `line_id` and `sku` lands. Unreadable optional
  fields are marked and, if a previous value exists, retained explicitly.
  Readable fields of the same line are not lost because one field changed type.
* `whole_source` — one unreadable field quarantines the whole package: rows are
  stored with `applied = 0`, current state is untouched, and the reason names the
  offending field. Nothing partially lands.

The run page states which records are usable either way.

## Replay and audit

Every run is append-only: package → mapping version → policy → trigger
(`collect`, `approval`, `replay`, `manual`). Replay re-reads the stored bytes and
verifies their digest; altered files are refused with `E_RAW_CHANGED`, never
re-fetched. After a mapping is approved, all packages that were not cleanly
applied are replayed automatically with it (the approval response lists the
results). Cleanly applied packages are not rewritten unless you replay them
explicitly.

## Checks

```bash
npm test          # 28 unit tests + 27 end-to-end tests (real workers, temp DBs)
npm run smoke     # against a running instance; additive, uses a smoke_* source
```

`npm test` never touches `data/`: each e2e group gets a temp root, a temp SQLite
file, an ephemeral fixture server and real detection child processes.
