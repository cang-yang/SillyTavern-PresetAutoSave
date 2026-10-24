# Catalog Read Cost Supplement

Status: measured optimization under the accepted performance scope.

The catalog remains one derived, rebuildable document with the existing schema.
Public full reads remain independent mutable copies. A metadata-only readState
does not materialize snapshots. A defensive findSummary(id) avoids cloning every
summary for one authoritative lookup.

Cache only flattened ordering and ID lookup for the currently verified bucket
image. Invalidate after successful publication or load, never on failed writes.
State/progress changes do not invalidate unchanged verified summaries.
Bucket replacement shares internally owned immutable projections of untouched
buckets; storage serialization still receives its own complete clone.
Publication callers may request metadata only when they do not consume summaries.

No sharding, runtime dependency, authoritative storage migration, or stale-read
tradeoff. Benchmark 500/5000 snapshots, 3 warmups and 20 samples, record environment,
cold build, 100 status reads, full read, single bucket update p50/p95/max.
Acceptance includes clone-free metadata reads, immutable caller isolation,
successful update cache invalidation, failure preserving previous generation,
and full existing catalog/facade tests.
