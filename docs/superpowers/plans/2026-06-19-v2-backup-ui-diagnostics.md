# V2 Backup, UI, and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make history backup/restore reject malformed input before mutation, recover from partial write failures, and expose v2 transaction evidence in the history UI.

**Architecture:** Keep parsing, validation, import planning, and snapshot presentation in browser-independent core modules. `history-store.js` remains the compatibility facade and delegates persistence to `HistoryRepository`; UI modules consume a small diagnostic view model instead of interpreting schema fields themselves. Imports are staged entirely in memory and use a captured repository image for best-effort rollback.

**Tech Stack:** Browser ES modules, Node.js test runner, localforage/IndexedDB, SillyTavern extension APIs, vanilla DOM/CSS.

---

## Task 1: Versioned backup codec

- [ ] Add `tests/history-backup.test.mjs` covering v1 compatibility, v2 metadata, malformed keys, malformed snapshots, duplicate IDs, and unsupported future versions.
- [ ] Add `modules/core/history-backup.js` exporting:
  - `HISTORY_BACKUP_VERSION = 2`
  - `createHistoryBackup(data, diagnostics, now)`
  - `validateHistoryBackup(payload)`
- [ ] Require plain-object payload/data, keys in `apiId::presetName` form, arrays of snapshots, finite timestamps, non-empty IDs, plain-object presets, matching optional identity fields, and globally unique snapshot IDs.
- [ ] Normalize accepted v1 and v2 snapshots through `enrichSnapshotList` so downstream code always receives current metadata.
- [ ] Run `node --test tests/history-backup.test.mjs` and commit the codec.

## Task 2: Validate-before-commit import with rollback

- [ ] Extend `tests/history-backup.test.mjs` with merge/replace planning, ID de-duplication, pinned retention, and maximum-history trimming cases.
- [ ] Add `buildHistoryImportPlan(payload, existingByKey, options)` to `history-backup.js`; it must validate the complete payload before returning any writes.
- [ ] Add repository image capture and restore helpers to `history-store.js`.
- [ ] Change `importAll(payload, mode)` to:
  1. validate and normalize the entire payload;
  2. read the complete effective repository image;
  3. build the final in-memory image;
  4. apply it;
  5. restore the captured image and throw a contextual error if any write fails.
- [ ] Change `exportAll()` to emit version 2 with schema/repository diagnostics while preserving v1 import support.
- [ ] Run the focused tests and the full `node --test` suite.

## Task 3: Repository migration diagnostics

- [ ] Add tests to `tests/history-repository.test.mjs` for diagnostic counters and marker-state reporting.
- [ ] Track migration attempts, successes, and failures inside `HistoryRepository` without changing migration behavior.
- [ ] Add `getDiagnostics()` returning schema version, legacy/v2 key counts, marker counts by status, and migration counters.
- [ ] Expose those diagnostics through the history facade and include them in v2 exports.
- [ ] Verify failed migrations remain retryable and diagnostics never make reads/writes fail.

## Task 4: Snapshot diagnostic view model and UI

- [ ] Add `tests/snapshot-diagnostics.test.mjs` for v1 fallback and v2 change-path/transaction/status projection.
- [ ] Add `modules/core/snapshot-diagnostics.js` exporting `getSnapshotDiagnostics(snapshot)` and `getSnapshotSummary(snapshot)`.
- [ ] Update history cards to use v2 `changeSet.changedPaths` when legacy summary paths are absent and show compact schema/save-status evidence.
- [ ] Update the snapshot detail popup with schema version, canonical hash, transaction ID, parent snapshot ID, save status, and changed paths; escape all dynamic values.
- [ ] Add matching Chinese and English i18n labels and minimal diagnostic styles.
- [ ] Run focused tests, import/export checks, and i18n parity checks.

## Task 5: Integration verification and handoff

- [ ] Run `node --test`.
- [ ] Run `node _check.cjs`.
- [ ] Import every JavaScript module under Node-compatible guards, check circular dependencies, and verify Chinese/English key parity.
- [ ] In a real SillyTavern browser session, export v2, re-import it, import a v1 fixture, reject a corrupt fixture without changing history, and inspect transaction details in the UI.
- [ ] Review `git diff --check`, commit the phase, and leave the branch unpushed.
