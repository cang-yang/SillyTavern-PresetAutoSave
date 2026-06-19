# History Repository v2 Implementation Plan

**Goal:** Introduce a rollback-safe v2 history repository without deleting or making existing v1 history unreadable.

**Architecture:** Keep `history-store.js` as the public compatibility facade. Place a repository adapter beneath it that reads/writes a new `history_v2` store, lazily migrates each `(apiId, presetName)` key from the legacy `history` store, and records migration/tombstone metadata. Existing UI and import/export callers continue using the same functions.

**Compatibility rules:**

- Never delete or rewrite the legacy `history` store during migration.
- A key is marked migrated only after the v2 write has been read back and verified.
- Preserve snapshot IDs, names, pins, timestamps, trigger values, preset data, and legacy `hash`.
- Add v2 metadata without removing v1-compatible fields.
- Failed migration falls back to legacy reads and remains retryable.
- Clear/delete operations create v2 tombstones so legacy records cannot silently reappear.

## Task 1: Define and test the v2 snapshot envelope

Create `modules/core/history-schema.js` and focused tests for:

- enriching v1 snapshots with `schemaVersion`, `canonicalHash`, `changeSet`, `cause`, `transactionId`, `parentSnapshotId`, and `saveStatus`;
- preserving all compatibility fields and user metadata;
- deterministic parent links and transaction IDs;
- validating identity, pin/name, count, and hash invariants.

## Task 2: Build the lazy migration repository

Create `modules/core/history-repository.js` with injected legacy/v2 stores. Test:

- successful migration and read-back verification;
- failure fallback without a false migration marker;
- v2 preference after migration;
- union key listing with metadata filtered out;
- tombstone behavior for remove and clear;
- normal writes always using the v2 envelope.

## Task 3: Put the repository under the existing facade

Update `history-store.js` initialization to use `HistoryRepository` over:

- legacy: `PresetAutoSave/history`;
- v2: `PresetAutoSave/history_v2`.

Keep every current exported function and payload shape available. Add integration tests proving legacy arrays remain visible through the facade-compatible repository contract.

## Task 4: Correct persistence ordering

Change the save worker to persist the SillyTavern preset first and commit history second. A disk failure must create no history snapshot; a history failure must be reported as a partial persistence failure rather than a false committed snapshot. Remove the old compensating snapshot delete path.

## Task 5: Verify and checkpoint

Run all Node tests, import/export checks, syntax checks, and diff checks. Re-run a real SillyTavern browser save against a clean temporary v1 history key, verify v2 migration/enrichment and confirm the legacy key is unchanged.
