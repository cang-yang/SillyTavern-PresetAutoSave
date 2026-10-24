# History Transaction Safety Supplement

Status: implementation supplement to the accepted reliability optimization design.

## Ownership

HistoryRepository owns serialization of reads that migrate, writes, tombstones,
clear, and complete import application. Existing facade queues remain responsible
for higher-level read-modify-write commands; repository methods never call the
facade queue. Internal transaction helpers do not recursively acquire the
repository queue.

Import validation/planning remains pure. The repository accepts a frozen complete
image and persists a verified rollback journal in its existing v2 store before
changing any authoritative bucket. The journal records exact prior v2 values and
markers, including missing values, and never changes legacy storage. Pending
journals roll back before subsequent repository access, including a fresh
repository instance after restart. A committed journal is cleanup-only.

Rollback restores prior entries before removing newly introduced entries and
checks exact readback. A failed rollback retains its durable journal and blocks
normal access rather than exposing partial data as complete. Imports write new
values before removing omitted buckets. Journal write/quota failure occurs before
authoritative mutations.

## Narrow Fixes

Strict archive enumeration rejects unreadable, malformed, or key-mismatched
entries; non-strict browsing retains its best-effort compatibility behavior.
Recovery never infers synthetic preset identity from a base series name.
Merge validation checks ID ownership across existing and incoming buckets.

## External Import Acceptance

External backups have a stricter acceptance boundary than existing storage reads
or rescue exports. Before enrichment, planning, journal creation or bucket
mutation, every incoming snapshot must contain a nonempty canonical preset.
Recognized OpenAI scalar fields must have their normalized numeric, boolean or
string type. Prompt definitions and orders must have object/array structure and
valid types for known fields; extension metadata must be an object. Unknown
custom prompt fields and non-OpenAI fields remain JSON data, not a new whitelist.

Incoming records require JSON-compatible plain own enumerable data. Optional
legacy metadata may be absent. Supplied pins, labels, hashes, sizes, causes,
summary arrays/counts and change-set metadata must have their consumed types;
invalid values are rejected rather than coerced. Explicit nonempty diagnostic
status strings, including partial states, remain unchanged. Snapshot schema
versions 1/2 and canonical contract version 1 are supported when supplied.

The pure import-validation module owns this boundary. Export sanitization retains
its prior readable-legacy behavior and secret exclusions. Existing repository
migration/enrichment is unchanged; old empty records remain recoverable as data
but cannot be introduced through a new successful replacement import.

## Non-goals and Compatibility

No archive canonicalization, history ID changes, destructive legacy migration,
new storage dependency, new UI, or new host API. Existing public facade methods
remain compatible. The optional import method is preferred by the backup helper;
plain test adapters retain a conservative in-memory fallback.

## Verification Order

1. Observe failing strict-read, base-name, migration interleaving and ID tests.
2. Implement narrow fixes and serialized repository operations.
3. Observe failing durable-journal, rollback-restart and quota tests.
4. Implement import journal and delegation; run focused and complete gates.
5. Reject malformed complete imports in pure and real facade/repository tests,
   including invalid late entries in merge/replace with zero storage writes.
6. Verify positive official preset shapes, old metadata omissions, partial
   diagnostics, stale hashes, custom fields, and unchanged rescue exports.
