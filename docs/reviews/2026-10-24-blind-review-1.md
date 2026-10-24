# Independent Product Review 1

Date: 2026-10-24

## Scope and Verdict

**FAIL: two independently reproduced release blockers remain.**

Reviewed checkout: `186301d17d17d404976051143f8b2d987583923c`. The initial branch
was `main`; the parent agent switched the shared workspace to `dev` during the
review. The final branch is `dev`, with the same unchanged HEAD commit.
The checkout had an existing modified `.gitignore` and numerous unrelated
untracked files. These were not changed or used as product evidence.

This review started with the checkout, `AGENTS.md`, `PRODUCT.md`, and the
instruction to independently inspect, verify, exercise the UI, and score it.
No previous review, implementation summary, or intended score was supplied or
read. No production code was changed. Browser fault injection affected only the
disposable harness origin at `127.0.0.1:4187`.

The normal UI and automated suite are substantially stronger than the recovery
edge cases. Passing tests and good responsive performance do not compensate for
an archive deletion path that loses unreadable recovery data or for a restore
that can be overwritten after reporting success.

## Scorecard

| Dimension | Score | Evidence and deduction |
| --- | ---: | --- |
| Core functionality and correctness | 80.0 | 341 tests pass; browser snapshot creation, switch-guard persistence, disclosures, grouping rename/undo/redo pass. A confirmed restore is overwritten by an earlier in-flight save, violating the central write ordering contract. |
| Data safety and fault tolerance | 60.0 | Canonicalization, export sanitization, history migration verification, rollback, pins, and corruption tests are present. Fault injection demonstrates permanent deletion of an unreadable archive during delete recovery, with `complete: true`. |
| Operation logic and learnability | 86.0 | Readable current save status, a single primary snapshot action, visible view modes, and consistent tools disclosure support common work. The reproduced restore success message does not describe the eventual persisted state. |
| Frontend engineering quality | 90.0 | Production shell/controller harness, scoped layered styles, markup/view-model seams, literal hostile translations, semantic tabs, and cleanup tests are strong. Large controllers and limited host-dialog fidelity remain risks, not new independently reproduced frontend blockers. |
| Mobile, responsive, and accessible UX | 91.0 | Ordinary view passes all four required widths in both themes; representative screenshots were visually inspected as detailed below. Mobile grouping target measured 272.61 x 44 px. Menu keyboard navigation, Escape, outside click, IME preservation, tab arrow navigation, and visible focus were exercised. Full assistive-technology and physical touch-device testing was not performed. |
| Performance and maintainability | 86.0 | 500-snapshot/46 MiB IndexedDB fixture opens quickly without payload reads and repeated view switching is fast. Eight production modules still exceed 1,000 lines, and independent restore persistence bypasses the coordinator despite its existence. |

Arithmetic mean: `(80 + 60 + 86 + 90 + 91 + 86) / 6 = 82.2`.

The overall and relevant dimensions remain below 90 under the release-blocker
rule. The optimization program does not pass this review.

## Prioritized Findings

### R1 - P1: Strict archive reads silently discard failures, then deletion clears the unread archive

**Release blocker: reproducible recovery-data loss.**

Evidence:

- `modules/archive-store.js:156` accepts `{ strict: true }`, but line 165 catches
  every individual `getItem` rejection and substitutes `null`.
- Line 166 filters those unreadable entries out. Strict mode only handles errors
  escaping the outer block. Invalid entries are also silently omitted.
- `modules/preset-takeover.js:1401` calls this strict reader for recovery; an empty
  result becomes a success result with zero failed archives.
- `modules/core/lifecycle-recovery.js:52` considers that archive result ready and
  lines 60-61 call `clearArchives`.

Browser reproduction used the real production archive store, takeover recovery,
and delete-recovery orchestrator with real IndexedDB. The snapshot callbacks were
no-ops to isolate an archive-only recovery case:

1. Seed `openai::BlindReviewUnreadableArchive` using `archivePreset`.
2. Temporarily make `IDBObjectStore.prototype.get` throw for that archive data key
   only; do not fail key enumeration or summary reads.
3. Call `runDeleteRecovery` with `restoreAllFromArchive`, successful empty
   snapshot writeback, no-op snapshot cleanup, and `clearAllArchived`.
4. Restore the IndexedDB method and inspect the archive keys.

Observed result:

```json
{
  "before": [
    "__archive_summary__::openai%3A%3ABlindReviewUnreadableArchive",
    "openai::BlindReviewUnreadableArchive"
  ],
  "result": {
    "complete": true,
    "archive": {
      "restored": 0,
      "failed": 0,
      "cleanupFailed": 0,
      "fromSnapshot": 0,
      "fromArchive": 0
    },
    "snapshotsCleared": true,
    "archivesCleared": true
  },
  "remaining": []
}
```

The exception is not surfaced as a recovery failure, no archive is restored,
and the only recovery image is removed. This is not merely missing verification.

Required acceptance: in strict recovery mode, any failed or malformed archive
read must fail closed; cleanup must preserve every unverified archive. Add a
regression covering item-level read rejection as well as malformed entries,
and demonstrate that delete recovery cannot report complete or clear archives
in either case.

### R2 - P1: Snapshot restore races an already running coordinated save

**Release blocker: reproducible stale overwrite after restore success.**

Evidence:

- `modules/panel-actions.js:415` calls `beginAtomicRestore`, then line 420 invokes
  `savePresetSafe` directly, outside the save coordinator.
- `modules/auto-save.js:1600` suppresses event handling and invokes
  `cancelPendingSave`, but does not wait for, cancel, or serialize the active
  coordinator worker.
- `modules/auto-save.js:802` shows that `cancelPendingSave` only clears the debounce
  timer.
- `modules/panel-actions.js:444` reports restore success before an earlier active
  write has necessarily finished.

Browser reproduction used production `saveNowDetailed`, `handleListClick`,
history records, and the host adapter:

1. Load the ordinary harness and select its current preset.
2. Set its live temperature to `1.987`.
3. Wrap the harness preset manager's `savePreset` so its first call waits on an
   explicitly controlled promise, then start `saveNowDetailed()`.
4. Once that save has entered persistence, dispatch the production restore action
   for the oldest current-preset snapshot, whose temperature is `0.55`.
5. Await restore completion, then release and await the earlier save.

Observed result:

```json
{
  "requestedRestoreTemperature": 0.55,
  "afterRestore": 0.55,
  "finalTemperature": 1.987,
  "writes": [
    { "call": 2, "temperature": 0.55 },
    { "call": 1, "temperature": 1.987 }
  ],
  "events": [
    { "level": "success", "message": "restore success with snapshot time" }
  ]
}
```

The actual success message was the localized `Restored To Time` message.
The observed final state differs from the successfully restored state. The old
save can overwrite live settings and disk after the user has been told recovery
completed. Historical snapshots remain available in this reproduction, but the
requested persisted state is incorrect.

Required acceptance: restore must use the same serialized persistence ownership
as automatic/manual saves. Cover an active save, queued save, restore failure,
and delayed completion; the final persisted value and tracking baseline must
match the last accepted user operation. Timer suppression alone is insufficient.

### R3 - P2: Large lifecycle and interaction controllers retain expensive review boundaries

Objective size observations:

| Module | Lines |
| --- | ---: |
| `modules/auto-save.js` | 1,727 |
| `modules/panel-group-manager.js` | 1,647 |
| `modules/history-store.js` | 1,610 |
| `modules/preset-grouping.js` | 1,566 |
| `modules/preset-takeover.js` | 1,449 |
| `modules/compatibility.js` | 1,309 |
| `modules/history-panel.js` | 1,302 |
| `modules/panel-actions.js` | 1,158 |

Size alone is not a blocker and should not motivate mechanical splitting.
However, R2 is concrete evidence that the existing save-coordination abstraction
does not own every production write path. Prioritize that cohesive ownership
correction, with concurrency tests, over broad cosmetic refactoring.

## Verification Commands

All required automated checks passed on the reviewed production checkout:

| Command | Result |
| --- | --- |
| `npm test` | 341 passed, 0 failed, 0 skipped; approximately 4.0 seconds |
| `npm run check` | Imports/exports, cycles, residual references, and all 555 translation keys pass |
| `node --check` for `index.js` and every `.js`/`.mjs` under `modules/` | All 71 production files pass |
| `git diff --check` | Pass; only an existing `.gitignore` LF/CRLF advisory |

Additional inspection used `git status --short --branch`, `git rev-parse HEAD`,
`rg`, and PowerShell file reads. Existing unrelated scripts were not executed.

Harness server:

```powershell
node --input-type=module -e "import { startHarnessServer } from './tests/harness/server.mjs'; await startHarnessServer({port:4187});"
playwright-cli --session blindreview open http://127.0.0.1:4187/tests/harness/
```

Browser exercises used `playwright-cli snapshot`, `click`, `press ArrowRight`,
`eval`, and `run-code` with explicit viewport changes and production harness
methods. The two failure reproductions used direct production entrypoints to
control timing and storage faults; they were not added to the existing suite.
They are currently coverage gaps despite the green baseline.

## Runtime and Viewport Evidence

Environment: Windows, Node `v24.14.1`, Intel Core i7-13650HX, 20 logical processors,
Playwright CLI browser, local loopback server, real browser IndexedDB.
No CPU throttling or physical mobile device was used.

| Scenario | Viewports | Result |
| --- | --- | --- |
| Ordinary, dark | 1280x900, 768x900, 390x844, 360x800 | Layout audit passes all four; screenshots captured |
| Ordinary, light | 1280x900, 768x900, 390x844, 360x800 | Layout audit passes all four; screenshots captured |
| Empty, dark | All four required viewports | Layout audit passes |
| Loading, dark | All four required viewports | Layout audit passes |
| Error, dark | All four required viewports | Layout audit passes; injected storage error is expected |
| Performance, warm/cold catalogs | 1280x900 | Audit passes; timing details below |

Screenshots are local review artifacts under
`output/playwright/blind-review-{dark,light}-{1280,768,390,360}.png`.
Desktop dark, narrow dark, and mobile light captures were visually inspected:
no page-width overflow, vertical compressed labels, or obscured primary action
was observed. The main mobile history viewport has an internal scroll region and
fixed accessible header/footer rather than document overflow.

Exercised operations:

- Manual snapshot count increased from 31 to 32, new ID committed, previous record
  preserved.
- Dirty-preset switch guard persisted the source and source history, left the
  destination unchanged, and settled destination tracking.
- Group alias rename, undo, redo, IME composition, and Escape cancellation passed.
- Group action menus expose expanded state; arrows move, Escape/outside click
  close, Tab continues, action activation works, disposal closes the menu.
- Series and version disclosures respond to Enter, Space, and click with matching
  `aria-expanded` and body visibility.
- Hostile translated markup renders literally; no injected element or executable
  handler was observed.
- At 360px width, Log-tab click followed by ArrowRight selected/focused Settings.
  Focus had a visible 2px purple outline. Settings had one measured vertical
  scroll owner (`.pas-settings`, 667px client height, 2465px content height).
- Grouping mobile action target measured 272.61px wide and 44px high.

Normal ordinary/performance operations reported zero console errors. The harness
reports an expected missing optional Template Render warning. The explicit error
scenario generated expected `HARNESS_EXPECTED_STORAGE_FAILURE` console messages,
which its audit excludes; those messages are not presented here as a new defect.

One initial ordinary render measured 263ms, triggering the harness's 250ms warning
but staying below the repository's 500ms opening target. Reloaded ordinary
light/dark audit runs had no warnings.

### Performance Measurements

500 snapshots, 48,234,000 bytes (46 MiB), IndexedDB:

| Catalog | Open/render | Payload reads | Archive payload reads | Observed open long tasks | Maximum repeated view render callback |
| --- | ---: | ---: | ---: | ---: | ---: |
| Warm | 26.1ms | 0 | 0 | 0 | 1.8ms |
| Cold | 57.0ms | 0 | 0 | 0 | 2.1ms |

These are single-machine harness measurements, not claims about all SillyTavern
hosts. Repeated view timing uses the harness's render-callback measurement rather
than end-to-end input latency. The cold fixture includes production catalog seed
metadata and is not equivalent to a complete legacy history migration.

## Limits and Required Next Gate

- The maintained harness uses production UI/controller/storage code but mocks the
  SillyTavern preset manager, popup implementation, and host events. No full live
  SillyTavern installation, screen reader, or physical mobile device was tested.
- The ordinary UI is Simplified Chinese. English key parity passed; English
  layouts were not independently rendered.
- No claim is made that every import, quota, native-save, or teardown failure
  permutation was browser-tested. Unit coverage was inspected and executed.
- Review fault injection changed only disposable browser state, never user
  presets or production repository code.

Fix R1 and R2 with demonstrated failing-then-passing regression tests, run the
complete verification gate again, and request a new fresh-context independent
review. Do not reuse this score as acceptance of the corrected implementation.
