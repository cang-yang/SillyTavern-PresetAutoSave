# Save Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace auto-save's global save lock with a deterministic single-writer coordinator that preserves preset identity across concurrent edits and switches.

**Architecture:** A pure `SaveCoordinator` owns queueing, per-target coalescing, revisions, state transitions and recovery. `auto-save.js` remains the event adapter: it captures a request for a fixed `(apiId, presetName)`, submits it, and receives committed/failed status without directly managing a global write lock.

**Tech Stack:** Browser ES modules, Node.js built-in test runner, existing SillyTavern compatibility layer.

---

### Task 1: Define queue and state contracts

**Files:**
- Create: `modules/core/save-coordinator.js`
- Create: `tests/core/save-coordinator.test.mjs`

- [ ] Write failing tests proving requests execute one at a time and state transitions are `idle -> running -> idle`.
- [ ] Run `node --test tests/core/save-coordinator.test.mjs` and confirm module-not-found failure.
- [ ] Implement constructor injection `{ worker, onStateChange, now }`, `enqueue(request)`, `getState()` and `whenIdle()`.
- [ ] Run the focused test and confirm PASS.

### Task 2: Preserve target identity and coalesce safely

**Files:**
- Modify: `modules/core/save-coordinator.js`
- Modify: `tests/core/save-coordinator.test.mjs`

- [ ] Add failing tests for two targets queued concurrently and three pending revisions of one target.
- [ ] Assert different targets retain their own payloads and same-target pending requests keep only the newest revision.
- [ ] Implement immutable request snapshots, target keys and pending-map coalescing.
- [ ] Run focused tests and confirm PASS.

### Task 3: Recover from failures and support teardown

**Files:**
- Modify: `modules/core/save-coordinator.js`
- Modify: `tests/core/save-coordinator.test.mjs`

- [ ] Add failing tests proving a rejected worker does not block later requests.
- [ ] Add failing tests proving `close()` rejects new requests and settles/cancels queued work without leaving `whenIdle()` hanging.
- [ ] Implement per-request result objects `{ status, request, value|error }` and deterministic close behavior.
- [ ] Run all coordinator tests and confirm PASS.

### Task 4: Integrate coordinator into auto-save

**Files:**
- Modify: `modules/auto-save.js`
- Create: `tests/integration/auto-save-coordinator.test.mjs`
- Modify: `_check.cjs`

- [ ] Build a mocked SillyTavern context and write a failing integration test that schedules an edit, begins another save, then switches target.
- [ ] Assert each persisted payload keeps the API/name captured for its request.
- [ ] Extract the current save body into `executeSaveRequest(request)` and route `doSave()` through one coordinator instance.
- [ ] Replace `_isInternalSave`/timeout lock ownership with coordinator state while preserving public `isSaving()` behavior.
- [ ] Close the coordinator during teardown and create a fresh instance during initialization.
- [ ] Register the core module in `_check.cjs`.
- [ ] Run `npm test && npm run check` and confirm PASS.

### Task 5: Verify switching and event storms

**Files:**
- Modify: `tests/integration/auto-save-coordinator.test.mjs`
- Create: `tests/core/save-event-sequences.test.mjs`

- [ ] Add deterministic sequence tests for debounce + SETTINGS_UPDATED, switch guard during an active write, restore suppression, and worker timeout.
- [ ] Assert no sequence writes a payload under a different preset name, commits twice for one revision, or leaves the coordinator non-idle.
- [ ] Run the sequence suite repeatedly with `node --test tests/core/save-event-sequences.test.mjs`.
- [ ] Run full tests, structural checks, syntax checks and `git diff --check`.
- [ ] Commit locally as `refactor: serialize preset saves through coordinator`; do not push.
