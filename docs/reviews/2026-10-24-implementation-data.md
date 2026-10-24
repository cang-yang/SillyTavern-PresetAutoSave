# Data Safety Implementation Evidence

Date: 2026-10-24. Branch: dev. No commits or user-owned files changed by this worker.

## Scope and Decisions

- A02: strict archive enumeration now rejects individual unreadable, malformed,
  key-mismatched, and unusable payload entries. Non-strict browsing stays compatible.
- A03: recovery preserves real base-name preset targets; the legacy filterGhosts
  option no longer discards identities based on parsed display family names.
- A10: HistoryRepository serializes migrating reads, writes, deletion, catalog
  reads, clear, and complete import application. Internal operations do not
  recursively acquire its queue; facade RMW commands retain their existing queue.
- A11: import merge and preview check snapshot-ID ownership across all existing
  targets. Reserved v2 metadata keys are invalid backup targets.
- A15: an exact raw v2/marker rollback image is durably written and read back
  before import mutation. Pending images recover before reads/writes, including
  a new repository after restart. Committed images need cleanup only. Failed
  recovery retains the image and blocks partial reads.

Architecture and non-goals are recorded in
`docs/superpowers/specs/2026-10-24-history-transaction-supplement.md`.
Legacy storage is untouched. Archives are not canonicalized. Pins, IDs, names,
prior hashes, and parent metadata survive raw rollback. No dependency added.
Production backup application delegates to repository.applyImportPlan; no facade
integration changes are required. Plain test adapters retain a conservative
fallback that restores values before removing extras and skips unchanged values.

## Red-Green Evidence

Command:

```text
node --test tests/archive-store.test.mjs tests/snapshot-writeback.test.mjs tests/core/history-backup.test.mjs tests/core/history-repository.test.mjs
```

Before implementation: 43 tests, 38 passed, 5 failed as expected:
strict entry read, malformed entry, cross-target ID, migration/delete interleaving,
and legitimate base-name writeback. After implementation: 43/43 passed.

```text
node --test tests/core/history-import-recovery.test.mjs
```

Before journal implementation: 4 tests, 1 passed, 3 failed as expected (no durable
image, lost rollback recovery image, missing committed cleanup marker).
After implementation and added concurrency/malformed-journal cases: 6/6 passed.

Reserved metadata key regression was subsequently added and observed failing with
"Missing expected exception"; rejecting the reserved namespace made it pass.

Final scoped run included the four initial suites, history-import-recovery,
history-catalog-integration, and storage-read-integrity: **57/57 passed**.
Syntax checks for all five changed/new production files passed.
`npm run check` passed (imports, cycles, i18n).
`git diff --check` passed, with only the existing user-owned .gitignore line-ending warning.

The concurrent full `npm test` run was not green: another in-progress lifecycle
change invalidated the old source-regex test for `_runtimeReadyPromise`.
The root owner was notified; no claim of a completed full-project gate is made here.

## Remaining Integration Verification

- Root reruns the complete gate after concurrent work converges.
- Browser/UI acceptance and independent review remain root-owned.
- Durable rollback requires enough storage for the before-image; quota refusal
  before journal verification safely rejects import without changing data.
- Repository serialization is per runtime instance; this does not introduce a
  cross-tab locking protocol or claim simultaneous-tab transaction isolation.

## Canonical Contract and Semantic Comparison

Implemented the followup accepted in
`docs/superpowers/specs/2026-10-24-preset-semantic-contract-supplement.md`.

- Compatibility delegates aliases, exclusions and prompt ownership to the pure
  schema. Capture and backup preserve unreferenced custom prompt definitions,
  normalize aliases identically, and omit the separate logit-bias library.
- `comparePresetStates` supplies canonical before/after, full semantic deltas
  (including raw values for detailed UI), and friendly summary projections.
  Character-specific orders use group identity. Unknown fields remain visible;
  the model no longer truncates all changes at twelve entries.
- History facade delegates summary/hash to core. Duplicate obsolete comparison
  helpers and its competing serializer were removed.
- New snapshots carry contractVersion 1 and canonicalHash. Old hash/ID/payload
  fields are not bulk rewritten. Legacy envelopes retain their old hash.
- New writes accept valid nonempty canonical JSON objects regardless of field
  count, reject invalid payloads explicitly, and capture caller data before queueing.
- Corrupt inspection returns `{cleaned:0,scanned,quarantined}` with original data
  preserved. Root/frontend owner updates labels and recovery inspection wording.

Red-green command:
`node --test tests/core/preset-contract-parity.test.mjs tests/history-store-manual-retention.test.mjs`
initially failed six expected assertions: capture/backup parity, false identical
group toggle, permutation exception, unknown prompt field omission, compact
preset rejection, and destructive pinned cleanup. All became green.
A later immutable-input test failed `0.9 !== 0.2` before capture was fixed.

Added defensive cases: 20 changed fields, group-qualified paths, unnamed-label
separation, duplicate/missing prompt identifiers, cycles/nonplain JSON and safe
`__proto__` preservation. Updated the official-field contract assertion only for
the explicitly documented separate-library selector; no fixture field list changed.

Latest complete run during shared implementation: 425 total, 424 passed, one
unrelated source-regex failure for moved seeding code. `npm run check` and
`git diff --check` passed. Root notified; final full gate remains pending.

## Credential Policy Followup

A synthetic root/non-OpenAI/extensions credential-variant test was observed red
before the shared contract removed normalized api-key/access-token/refresh-token/
auth-token/bearer-token/client-secret/secret-key/authorization keys. Exact string
`token`/`password` properties are treated as credentials at root/inside extensions;
token counters, prompt names/identifiers/content and string templates remain
literal. Diagnostics contain paths/reasons only. Nested object properties use
defineProperty, including `__proto__`, without changing object prototypes.

## Catalog Measurements

Design: `docs/superpowers/specs/2026-10-24-catalog-read-cost-supplement.md`.
Repeatable command: `node tests/benchmarks/history-catalog.mjs`.
Environment: Windows, Node v24.14.1, Intel Core i7-13650HX, structuredClone memory
store, 3 warmups, 20 measured samples. This measures JavaScript/catalog costs,
not IndexedDB latency or a browser long-task certification.

| Snapshots / operation | Before p50/p95/max ms | After p50/p95/max ms |
| --- | --- | --- |
| 500 / 100 status reads | 261.509 / 275.377 / 280.237 | 0.011 / 0.031 / 0.037 |
| 500 / full defensive read | 2.680 / 3.047 / 3.067 | 2.958 / 3.308 / 3.635 |
| 500 / one bucket update | 13.181 / 14.081 / 14.134 | 6.549 / 7.421 / 7.480 |
| 5000 / 100 status reads | 2589.419 / 2827.089 / 2860.179 | 0.002 / 0.002 / 0.003 |
| 5000 / full defensive read | 27.977 / 29.700 / 30.310 | 23.519 / 30.832 / 32.907 |
| 5000 / one bucket update | 109.660 / 138.968 / 139.490 | 57.140 / 61.423 / 62.754 |

Cold builds before/after: 500 = 42.333/40.625 ms; 5000 = 220.954/192.923 ms.
No claim that complete reads improved at 500 or that 5000 updates meet 50 ms.
The explicit 500-snapshot operation target improved without storage sharding.

Implementation adds clone-free readState and defensive indexed findSummary,
caches flattened ordering by verified image, avoids redundant deep copies of
untouched internally owned bucket projections, and lets internal mutation callers
request metadata only. Public full reads remain independent copies.

Three catalog tests were observed red before implementation: missing metadata
API, missing indexed lookup, and unordered rebuild keys causing a false manifest
mismatch. All became green; fault tests ensure failed writes preserve old index/
generation. The focused catalog/canonical/facade run passed 31/31.

## Final Scoped Verification

Final focused storage/canonical/catalog selection passed 76/76. A broader
selection of every `.test.mjs` path matching history, canonical, change-set,
archive-store, snapshot-writeback, preset-contract or official-contract passed
141/141 with no failures or cancellations. This includes the history facade,
catalog startup/legacy refresh, quota preservation, batch deletion, migration,
backup, journal recovery, canonical capture, and semantic comparison suites.

`npm run check` passed with 573 matching i18n keys and no module-link/cycle
errors. Syntax checking every production module and index completed successfully.
`git diff --check` passed; the pre-existing `.gitignore` line-ending warning is
unrelated and that file was not edited by this workstream.

The latest full-suite observation during concurrent integration was 439 tests,
437 passed, with two root/frontend-owned failures: import-popup lifecycle
ownership and a panel-summary source-regex expectation for the moved restore
lookup. Both owners were notified. This report does not certify the final shared
checkout or replace the required fresh-context independent review.

Reviewed final scoped diffs for defensive cloning, durable rollback ordering,
canonical field ownership, nested property safety, historical hash preservation,
and catalog generation invalidation. No further scoped blocker was found.
Remaining constraints: journal isolation is per repository instance, not a
cross-tab lock; durable import needs storage for its verified rollback image;
5,000-snapshot full-document updates remain above 50 ms in the recorded Node
probe. No product files were committed or pushed by this workstream.

## Blind Review 2 Credential Correction

The independent P1 reproduction exposed a gap: extension recursion checked
generic credentials but did not use the known root connection-field exclusions.
Added two production-entry regressions before editing the sanitizer. The focused
run observed 23 passes and two expected failures (`true !== false`): production
backup export/import and individual-preset sanitization retained synthetic values.

The pure schema now shares one connection exclusion predicate between root and
recursive extension metadata. It normalizes known key spellings, includes known
provider API-key aliases, and excludes whole connection/header properties.
Tests cover objects inside arrays, OpenAI and non-OpenAI roots, literal prompt
names/content and templates, numeric token counters, safe diagnostics, and input
immutability. No real secrets are used or printed.

After correction the two target suites pass 25/25, and the broader data/history/
canonical selection passes 144/144. `npm run check` passes with 573 matching
i18n keys. This correction does not rewrite persisted history or recovery data.
Changed production-file syntax and `git diff --check` pass. Concurrent full
`npm test` observed 456 tests, 454 passed, with only the two in-progress
metadata-contrast acceptance tests failing in the separate frontend workstream;
root was notified. Final combined gate remains root-owned.

## Blind Review 5 Imported Hash Correction

The production import-to-save reproduction showed that stored hash equality
could override disagreement with the prior canonical payload. Added five
integration cases using the maintained isolated host and memory storage.
Before the fix, three failed: automatic save left history at temperature 0.1
after host persistence of 0.9; switch-guard snapshot was suppressed; distinct
canonical payloads with a deterministic 32-bit collision were also skipped.
Canonical equivalence with stale metadata and empty-legacy compatibility passed.

Changed only the history deduplication decision to compare exact canonical
serializations. Existing imported IDs, hashes and pins are preserved. A prior
empty legacy object is accepted for comparison rather than subjected to the
new-write nonempty validator. The two fixed collision inputs are send_if_empty
values `collision-46781` and `collision-126001`, both hash `vaqi4w`.

All five integration tests pass after the fix. The automatic path verifies
real importAll -> saveNowDetailed('auto'), host 0.9, history 0.9, committed
result, saved status, and preservation of the imported recovery record.
Inspection of other persisted-hash consumers found import merge also compares
actual payload content; coalescing uses trigger/time/pins rather than hashes.
Final gate: `npm test` 470/470 passed, `npm run check` passed (85 linked
modules, 573 matching i18n keys), syntax passed for all 87 production files
under modules/scripts plus index, and `git diff --check` passed. No live user
storage or preset was touched. In-memory auto-save hash guards are outside this
imported-history correction; this collision regression covers history deduplication.

## Blind Review 6 Strict External Import Boundary

Added a pure import-only validation seam; readable existing storage, enrichment
and rescue exports are not subjected to new-import rules. Nonempty canonical
payloads and recognized preset shapes are required before planning writes.
Supplied optional metadata has explicit type validation without coercion;
omitted legacy metadata and explicit partial diagnostic statuses are retained.
Unknown fields remain accepted only as JSON data. No history-schema edit or
destructive migration was made.

Red evidence: seven targeted tests initially had five failures: empty canonical
acceptance, invalid recognized preset shapes, malformed metadata, the reviewer's
actual repository replacement of pinned Good, and late malformed facade imports.
After correction all pass. Both merge and replace assert every storage map is
unchanged and that not even a journal write happens on validation failure.

The previous empty-legacy deduplication regression now seeds actual legacy
storage instead of importing an invalid empty external record. Official preset
fixture shapes, legacy/current summaries, custom prompt properties, normalized
aliases, non-OpenAI fields, old omissions, stale hashes, partial statuses and
rescue export compatibility have explicit positive tests.

The actual facade roundtrip creates prompt-edit/toggle summaries with addSnapshot,
exports and JSON-serializes them, then replaces through strict import and verifies
IDs, pins and canonical payloads. Historical generator inspection at a4fb2a5
confirmed legacy tags are objects with type/label/optional count. The supported
legacy numeric wi_format enum remains accepted alongside current string templates.

Final targeted run: 14/14 passed. Final complete gate: 487/487 tests passed,
86 production modules linked, 573 matching i18n keys, 88 production files passed
syntax (the final changed validator was checked again), and git diff --check
passed. No commits or pushes; product changes are frozen for independent review.
