# Save, Restore, And Lifecycle Implementation

Owner: save/lifecycle implementation agent. No commits or pushes performed.

## Contract

See `docs/superpowers/specs/2026-10-24-save-lifecycle-contract.md`.
Public UI entry: `restoreSnapshotDetailed({ apiId, presetName, preset })`.
Returns committed/unchanged/partial/failed/cancelled/unavailable with snapshot or
error where applicable. Root UI owns confirmation and scope revalidation.
Old `beginAtomicRestore` / `endAtomicRestore` protocol was removed with the root
UI migration.

## Red Evidence

- `node --test tests/integration/save-completion-runtime.test.mjs
  tests/integration/lifecycle-stop-runtime.test.mjs`: both failed as expected.
  Save asserted final 0.3 but disk contained 0.2; stop resolved before the blocked
  archive initialization could finish.
- Added coordinator explicit-command tests: expected active/before/restore/after,
  actual active/after; cancellation API absent.
- Restore integration initially failed because command API was absent.
- Repeated stop test initially returned cleanup result 2 instead of cached 1.
- Observable status test initially failed because subscription API was absent.
- Diagnostic observer probe failed restore before persistence when the worker
  diagnostic callback threw; the worker now isolates that diagnostic.

## Implemented

- Immutable captured raw fingerprint, canonical hash, mutation generation, and
  submitted revision drive completion. New live edits keep pending state and are
  scheduled even without a DOM input event.
- Explicit manual/restore/native-observation commands are non-coalescible barriers.
  Restore cancels only same-target queued automatic work and waits behind the
  active writer. Native observations record history without repeating host write.
- Restore host/history partial failure stays partial and is not automatically
  replayed. Settings-disabled automatic saving does not disable explicit restore.
- Runtime lifecycle owns initialization generation, stop serialization, repeated
  stop idempotency, restart-after-stop, and failed-init rollback.
- Save status owns isolated subscriptions and a partial state. Injector subscribes
  without importing autosave, and no presentation timer silently clears errors.
- Save, native observation, restore and initial seeding now use the shared
  `requireCanonicalPreset` contract. Invalid live input returns a failed detailed
  result with error status and performs no write.

## Green Evidence

- 32 focused save/lifecycle/status tests passed after integration wiring.
- Additional toolbar subscription lifecycle test and partial presentation assertion
  passed; the final focused status/restore subset reported 9/9.
- `node --check` passed for all eight owned production files.
- `git diff --check` passed (only pre-existing `.gitignore` line-ending warning).
- Full `npm test` was attempted during parallel implementation. Peer-owned new
  settings, host-emitter, and compact-canonical tests were still intentionally red;
  this is not a final complete gate result. Root runs the final repository gate.

## Remaining Verification

Real-host delayed persistence/restore and phase-by-phase lifecycle matrix remain
part of the root integration/browser acceptance. Status partial copy/styles are
owned by root. No storage schema, preset identity, or user data migration changes.

## Inventory, Seeding And Dropdown Follow-On

- Extracted exact native inventory into `modules/host/preset-inventory.js`.
  Preserves case, numeric names and whitespace-bearing names; native option values
  remain distinct from identity. The old numeric-name heuristic failed the new
  fixture (actual `['A']`, expected `['123',' A ','A']`) before replacement.
- Extracted synchronous capture plus serialized, cancellable initial snapshot
  creation into core/runtime seeding modules. The production verified-payload
  regression failed with temperature `0.99` instead of captured `0.8`, then passed.
  Target cancellation drains active writes and blocks queued seeds before delete.
- Takeover retains public compatibility exports. Autosave imports the seeding
  service directly. Index owns its initialization and shutdown before recovery.
- Full option fingerprint replaces first/middle/last sampling. The actual original
  fingerprint stayed `presets::8::Preset 0::Preset 4::Preset 7::0` when option 1 was
  renamed; the new exact fingerprint changes for name/value/disabled updates.
- One dropdown controller owns flat/nested click and keyboard listeners. Real
  focus reaches group headers and visible items; collapsed ancestors are checked;
  rerenders preserve stable focus/expansion; teardown restores original native
  style, tabindex and aria-hidden attributes and releases handlers.
- Native fetch observer moved from core to host. Capture failures no longer reject
  successful host fetches (red probe threw `observer unavailable`). Late responses
  cannot claim a later user click (red probe recorded `Older`, expected no record).
  Captured request epochs and disposal suppress stale completion notifications.

## Serialized Deletion

`deleteHostPresetDetailed(target, { afterDelete })` runs host deletion and the
recovery-aware cleanup callback under the same save coordinator. Deletion cancels
queued target writes, invalidates retries, drains target seeding, and rechecks
current-target protection when its turn begins. Callback exceptions return
`partial`, `deleted:true`, and the original error. Root owns cleanup stage labels.

The cleanup-barrier regression first failed with `Deletion returned without
running its cleanup barrier`. Green order is host delete, cleanup:start,
cleanup:end, then the queued save. Other tests cover pending restore cancellation,
current-target protection, false host deletion, and target reuse after failure.
Deletion blocks stale target writes; a new explicit native save can release the
block only if its request started after the deletion epoch and its target is
currently selected.

## Mounted Browser Evidence

Maintained `tests/harness/takeover-scenario.mjs` is exposed as
`window.__PAS_HARNESS__.exerciseTakeover({ nested })`.
Playwright CLI, Chromium, Windows, Node v24.14.1, local server port 4173:

- Flat and nested modes at 1280x900, 768x900, 390x844 and 360x800 all passed eight
  checks: real focus on open, group expansion, one native change on selection,
  Escape focus return, same-count rename refresh, exact legal names, native-state
  restoration on teardown, and one wrapper after remount (64 boolean checks).
- Zero browser console errors. One expected existing warning: optional host
  template-render capability absent in the mock harness.
- Screenshot inspected at `output/playwright/takeover-360-before-touch.png`.
  Actual touch heights were 35-36px; reported to root stylesheet owner for a
  feature-scoped 44px fix before the independent review. Behavior evidence above
  is not a claim that this pre-fix screenshot satisfies touch acceptance.
- This is the local host mock, not a live SillyTavern deployment.

`npm run check` passed 85 production modules and 573 matching i18n keys.
The latest full test run during the root touch-style red phase was 451/452, with
only the new feature-owned dropdown touch/style test failing. Root owns the final
fresh all-green gate after its style change; this report does not certify it.

After root's touch CSS fix, reloaded the 360x800 page and remeasured all visible
dropdown buttons: trigger/header/items exactly 44px high. Document scrollWidth
and viewport width were both 360px. Focus was the actual group-header DOM node.
Inspected `output/playwright/takeover-360-touch-verified.png`; no horizontal
overflow or overlapping dropdown controls. All 85 production files passed fresh
`node --check`. Production code is now frozen for independent review.
