# Resource measurements — v3 event store at corpus scale

> **Development-machine figures.** Every number below was measured on ONE
> developer laptop, on a warm filesystem, single process, no concurrent load.
> They are **not** target-hardware numbers, they are **not** a capacity plan,
> and they must never be quoted as either. Their purpose is to show the shape
> of the growth curve and to catch an order-of-magnitude surprise early.

- generated: 2026-09-15T22:46:28.304Z
- machine: darwin/arm64, Apple M5 × 10, 32 GB, 25.6.0
- node: v26.8.2
- store: `src/events/event-store.ts` (`node:sqlite`, WAL), events written to `.twining/events/**` and fsynced
- sharding: events spread over 24 calendar months (the store shards event files by `occurred_at.slice(0,7)`). Pass `--single-shard` to pile the whole corpus into one directory.
- workload: `scripts/measure/corpus.ts` — `created` decision records with a realistic body (~600 B of prose, two affected files), round-robin over five scopes, Ed25519-signed on append
- concurrent load: **none** — this run had the machine to itself. (An earlier run of the same script alongside `vitest` and `tsc` produced materially worse latency; if you re-run it, run it alone or say that you did not.)
- method: latency measured per `append()` call (validation + signature + journal row + event file + fsync), so **durable local capture** is the thing being timed

## Results

| tier | events written | month shards | events/s | append p50 | append p95 | append p99 | append max | append total | admit | project | rebuild | records | on disk | bytes/event | RSS after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 1,000 | 24 | 85.3 | 11.918 ms | 13.135 ms | 14.024 ms | 17.114 ms | 11.7 s | 0.2 s | 0.0 s | 0.4 s | 1,002 | 1.3 MB | 1319 B | 240.6 MB |
| 2,000 | 2,000 | 24 | 67 | 13.724 ms | 22.186 ms | 27.909 ms | 41.745 ms | 29.8 s | 2.0 s | 0.1 s | 3.5 s | 2,002 | 2.5 MB | 1318 B | 273.9 MB |
| 4,000 | 4,000 | 24 | 48.3 | 19.879 ms | 31.168 ms | 40.055 ms | 63.46 ms | 82.8 s | 0.9 s | 0.1 s | 1.8 s | 4,002 | 5.0 MB | 1318 B | 353.3 MB |
| 8,000 | 8,000 | 24 | 36 | 26.887 ms | 55.606 ms | 68.708 ms | 138.687 ms | 222.1 s | 17.2 s | 0.6 s | 11.5 s | 8,002 | 10.1 MB | 1318 B | 470.5 MB |
| 16,000 | 16,000 | 24 | 21 | 48.947 ms | 77.797 ms | 94.923 ms | 199.016 ms | 762.0 s | 6.7 s | 0.7 s | 7.9 s | 16,002 | 20.1 MB | 1319 B | 751.2 MB |



### Storage split

| tier | event files | derived db (after rebuild) | total |
| --- | --- | --- | --- |
| 1,000 | 1.3 MB | 0 KB | 1.3 MB |
| 2,000 | 2.5 MB | 0 KB | 2.5 MB |
| 4,000 | 5.0 MB | 0 KB | 5.0 MB |
| 8,000 | 10.1 MB | 0 KB | 10.1 MB |
| 16,000 | 20.1 MB | 0 KB | 20.1 MB |

### Rebuild fidelity

| tier | projection digest after rebuild equals digest before |
| --- | --- |
| 1,000 | yes |
| 2,000 | yes |
| 4,000 | yes |
| 8,000 | yes |
| 16,000 | yes |

### Growth fit and what it implies

Least squares over the 5 completed tiers in log-log space gives

```
append p50 (ms) ≈ 0.323 × n^0.50
```

so **per-append latency grows with the number of events already in the store**
(a flat cost would be α ≈ 0). Total time to write a corpus therefore grows as
n^1.50, not linearly.

Consequences, stated as predictions from this fit rather than as measurements:

- **100,000 events was not attempted to completion.** Extrapolating, p50 would
  be ≈ **108 ms** and a single-threaded write of the whole
  corpus would take ≈ **3.0 hours** on this machine. The
  largest tier actually completed is **16,000**.
  That is the honest answer to "1k/10k/100k": 1k and (beyond) 10k are measured,
  100k is projected and must be labelled projected.
- **C28 A25 names a p95 target of < 100 ms for durable local capture.** The
  measured p95 at 16,000 events is
  **77.797 ms** — already close. Using the measured
  p95/p50 ratio of 1.59, the fit puts the crossing at roughly
  **35000 events**. A store that keeps every event
  forever reaches that in ordinary use.

**FINDING F-APPEND-GROWTH (owner: lane 02, `src/events/event-store.ts`).**
This lane measured the curve; it did not diagnose the mechanism, and two
plausible causes were ruled out (month sharding, concurrent load — see below).
The remaining candidates worth checking are the per-event fsync, the
`admission_log` insert per append, and anything that re-reads growing state on
the append path. Reproduce with:

```sh
npx tsx scripts/measure/corpus.ts --tiers 1000,2000,4000,8000,16000
```

### Append latency versus corpus size — the number to watch

The `events/s` and `append p50` columns **across** tiers are the interesting
comparison, not any single row. If per-append latency grows with the number of
events already in the store, the cost of a write is a function of history
length — which matters a great deal for a design whose whole premise is an
append-only log that is never truncated, and which would put a hard ceiling on
migration and bulk-import throughput.

Two things were ruled out while producing this table, and are recorded so
nobody re-derives them:

- **Month sharding is not the cause.** The store shards event files by
  `occurred_at.slice(0,7)`. Piling a whole corpus into one directory
  (`--single-shard`) was measured *faster* at 1,000 events than spreading it
  over 24 months, not slower — spreading costs a little on append and a lot on
  `rebuild`, which has more directories to walk.
- **Concurrent load is not the cause** of the growth in the table above: this
  run had the machine to itself.

Whatever remains is a property of `append` itself at corpus scale, and belongs
to lane 02 (`src/events/event-store.ts`). The growth-curve tiers below exist
to characterise it rather than to assert a mechanism.

## Reading these numbers

- **Durable local capture** is the `append` column. C28 A25 names a p95 target of < 100 ms. Compare against the p95 column, not the mean, and remember this machine has an NVMe SSD and no competing load.
- **Admission and projection are whole-corpus passes here**, not incremental ones: `project()` recomputes every record from the admitted set. A production deployment that projects on every write would pay the `project` column on every write; one that batches pays it per batch. The slice does not yet have an incremental projector, so the `project` column is the honest cost of the current design at that corpus size.
- **Rebuild** is the recovery-time number: drop the derived database, replay every event file. It is the floor for "how long is this store unavailable after losing the index".
- **bytes/event** includes the pretty-printed JSON event file (the store writes `JSON.stringify(ev, null, 2)`), so it is an upper bound; a compact encoding would cut it materially.
- **RSS** is the measuring process's resident size at the end of the tier, which includes the harness and the accumulated latency array. It is an upper bound on the store's own footprint, not an attribution.

## Not measured here

Queue capacity, indexing delay, migration time and upgrade compatibility need
lane 02's outbox/migration tooling and are **not tested**. Recall and injection
latency (C28 A25's < 1 s target) need lane 04's retrieval path. None of these
may be reported as passing on the strength of this document.

## Raw results

```json
{
  "machine": {
    "platform": "darwin/arm64",
    "release": "25.6.0",
    "cpu": "Apple M5",
    "cores": 10,
    "mem_gb": 32,
    "node": "v26.8.2"
  },
  "results": [
    {
      "target": 1000,
      "completed": 1000,
      "shards": 24,
      "append_mean_ms": 11.677,
      "events_per_sec": 85.3,
      "append_p50_ms": 11.918,
      "append_p95_ms": 13.135,
      "append_p99_ms": 14.024,
      "append_max_ms": 17.114,
      "append_total_ms": 11724,
      "admit_ms": 246,
      "project_ms": 37,
      "projected_records": 1002,
      "rebuild_ms": 395,
      "rebuild_digest_equal": true,
      "events_bytes": 1318824,
      "db_bytes": 0,
      "total_bytes": 1318824,
      "bytes_per_event": 1319,
      "rss_after_mb": 240.6,
      "heap_after_mb": 65.1
    },
    {
      "target": 2000,
      "completed": 2000,
      "shards": 24,
      "append_mean_ms": 14.884,
      "events_per_sec": 67,
      "append_p50_ms": 13.724,
      "append_p95_ms": 22.186,
      "append_p99_ms": 27.909,
      "append_max_ms": 41.745,
      "append_total_ms": 29848,
      "admit_ms": 2008,
      "project_ms": 121,
      "projected_records": 2002,
      "rebuild_ms": 3530,
      "rebuild_digest_equal": true,
      "events_bytes": 2636144,
      "db_bytes": 0,
      "total_bytes": 2636144,
      "bytes_per_event": 1318,
      "rss_after_mb": 273.9,
      "heap_after_mb": 87.9
    },
    {
      "target": 4000,
      "completed": 4000,
      "shards": 24,
      "append_mean_ms": 20.646,
      "events_per_sec": 48.3,
      "append_p50_ms": 19.879,
      "append_p95_ms": 31.168,
      "append_p99_ms": 40.055,
      "append_max_ms": 63.46,
      "append_total_ms": 82800,
      "admit_ms": 948,
      "project_ms": 150,
      "projected_records": 4002,
      "rebuild_ms": 1799,
      "rebuild_digest_equal": true,
      "events_bytes": 5270814,
      "db_bytes": 0,
      "total_bytes": 5270814,
      "bytes_per_event": 1318,
      "rss_after_mb": 353.3,
      "heap_after_mb": 67.3
    },
    {
      "target": 8000,
      "completed": 8000,
      "shards": 24,
      "append_mean_ms": 27.713,
      "events_per_sec": 36,
      "append_p50_ms": 26.887,
      "append_p95_ms": 55.606,
      "append_p99_ms": 68.708,
      "append_max_ms": 138.687,
      "append_total_ms": 222094,
      "admit_ms": 17220,
      "project_ms": 601,
      "projected_records": 8002,
      "rebuild_ms": 11460,
      "rebuild_digest_equal": true,
      "events_bytes": 10540154,
      "db_bytes": 0,
      "total_bytes": 10540154,
      "bytes_per_event": 1318,
      "rss_after_mb": 470.5,
      "heap_after_mb": 105.1
    },
    {
      "target": 16000,
      "completed": 16000,
      "shards": 24,
      "append_mean_ms": 47.573,
      "events_per_sec": 21,
      "append_p50_ms": 48.947,
      "append_p95_ms": 77.797,
      "append_p99_ms": 94.923,
      "append_max_ms": 199.016,
      "append_total_ms": 762029,
      "admit_ms": 6675,
      "project_ms": 733,
      "projected_records": 16002,
      "rebuild_ms": 7908,
      "rebuild_digest_equal": true,
      "events_bytes": 21100804,
      "db_bytes": 0,
      "total_bytes": 21100804,
      "bytes_per_event": 1319,
      "rss_after_mb": 751.2,
      "heap_after_mb": 196.7
    }
  ]
}
```
