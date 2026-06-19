# Lifecycle Recovery Cleanup Implementation Plan

> **For agentic workers:** Execute each task in order, keep every destructive cleanup conditional on verified recovery success, and commit each independently reviewable slice.

**Goal:** Make disable, enable, and delete lifecycle operations deterministic so active saves cannot race recovery, successful SillyTavern preset writes are recognized correctly, and recovery data is never deleted after a failed restore.

**Architecture:** Treat lifecycle transitions as serialized transactions. First quiesce the save coordinator, then restore external state, then remove recovery records only after verified success. Keep browser-facing orchestration in `index.js` and move independently testable recovery decisions into core modules.

**Tech Stack:** JavaScript ES modules, Node test runner, SillyTavern extension hooks and `PresetManager`, Playwright browser regression.

---

## Task 1: Lock down the official preset-save contract

- [x] Add a regression test proving `savePresetSafe` reports success when SillyTavern's `PresetManager.savePreset` resolves with `undefined`.
- [x] Change the compatibility wrapper to return `true` after a resolved write and continue propagating rejected writes.
- [x] Verify archive restoration removes its recovery entry only after the preset write resolves.

## Task 2: Make archive recovery deterministic and testable

- [x] Extract the archive recovery decision loop into a dependency-injected core service.
- [x] Select the newest usable snapshot deterministically; fall back to archived preset content when necessary.
- [x] Track write failures and archive-cleanup failures separately.
- [x] Add tests for successful restore, rejected write, failed cleanup, malformed entries, and snapshot fallback.

## Task 3: Quiesce active saves before lifecycle recovery

- [x] Make auto-save teardown close the coordinator and await `whenIdle()` before clearing module state.
- [x] Update all lifecycle callers to await teardown.
- [x] Add regression coverage proving an active save completes while queued saves are cancelled before recovery starts.

## Task 4: Make disable/delete hooks transactional

- [x] Return an awaited Promise from the disable hook so SillyTavern can wait for recovery.
- [x] Stop auto-save before archive or snapshot restoration.
- [x] Distinguish intentional snapshot skips from failed writebacks.
- [x] Preserve archives or snapshots whenever their restore/writeback phase reports a failure.
- [x] Remove non-cancelling timeout races and report partial failure truthfully.
- [x] Reset lifecycle initialization state so re-enable can initialize the extension again.

## Task 5: Verify the complete lifecycle against SillyTavern

- [x] Run the complete automated test suite and static checks.
- [x] Inspect the final diff for stale shared-state and fire-and-forget lifecycle paths.
- [x] Run a real-browser SillyTavern regression covering save, disable/re-enable, archive recovery, and failed delete recovery.
- [x] Confirm no console errors, no phantom history entries, and no recovery data loss.
