# Independent Blind Review 10

Date: 2026-10-27, Asia/Shanghai.

## Scope And Result

Reviewed the current working checkout on `dev`, including staged and unstaged changes, not only HEAD (`5a8a7f9a8645b3e95b629f2a5e72b86a9527cced`). Inputs were the repository, AGENTS.md, PRODUCT.md, and the instruction to inspect and verify the product. No earlier review reports or implementation summaries were supplied or read. Production code and tests were not modified.

**Result: FAIL. One reproducible recovery/data-loss release blocker remains.** The required automated commands pass, and the exercised browser scenarios pass their maintained audit, but these do not cover the null-returning missing-preset case described below.

## Scorecard

| Dimension | Score | Evidence |
| --- | ---: | --- |
| Core functionality and correctness | 88.0 | 569 tests pass. Real manual snapshot creation creates a distinct ID and preserves the prior record; group editing and preset-switch convergence pass. Missing-preset recovery nevertheless produces a false successful skip. |
| Data safety and fault tolerance | 82.0 | Serialized writes, verified migration, durable import journal, protected retention, and canonical credential filtering are substantial safeguards. Finding R10-1 permits deletion of the last recovery image without restoring the missing preset. |
| Operation logic and learnability | 92.0 | Current save state is visible in the header. Snapshot, search, grouping, and comparison have explicit scopes. Search remains usable after selecting comparison A; B selection exposes a named start action. Empty/loading/error presentations are understandable. |
| Frontend engineering quality | 91.0 | Production controller and styles are exercised by the harness; eight ordinary viewport/theme audits pass. Group menus expose state, keyboard navigation, outside-click cleanup and disposal. Bilingual dictionaries share 577 keys. Large legacy modules and reliance on a simulated host remain maintenance risks. |
| Mobile, responsive, accessible UX | 91.0 | 1280x900, 768x900, 390x844 and 360x800 pass in light/dark ordinary scenarios. Compact settings have one vertical scroll owner. Keyboard tab navigation, disclosures, menus, IME handling and comparison are exercised. Native-host popup and screen-reader testing remain outside this harness evidence. |
| Performance and maintainability | 90.0 | 500 snapshots / 46 MiB IndexedDB warm open: 27 ms, no authoritative payload reads/writes, no archive payload reads, no observed long tasks. Warm view render callbacks max 2.3 ms. Deterministic core seams are testable; oversized legacy controllers still increase review cost. |

Arithmetic mean: `(88 + 82 + 92 + 91 + 91 + 90) / 6 = 89.0`.

The overall score is below 90 and the blocker independently prevents acceptance.

## Prioritized Findings

### R10-1 [P1, Release Blocker]: Null Missing-Preset Result Skips Recovery Before Destructive Cleanup

Locations:

- `modules/core/snapshot-writeback.js:31`: native inventory can explicitly establish that the target name is absent.
- `modules/core/snapshot-writeback.js:43-46`: an absent result still falls through to `findPreset`; `null !== undefined` becomes true.
- `modules/core/snapshot-writeback.js:86-91`: this is counted as an existing preset and therefore a successful skip, without calling the recovery writer.
- `modules/core/lifecycle-recovery.js:55-58`: zero failures allows snapshot cleanup.
- `index.js`, `deleteRuntime`: connects this skip-existing writer to `runDeleteRecovery`.

This is not merely a hypothetical null convention: `tests/harness/app.mjs:140` itself returns `null` for missing `findPreset` results. An empty authoritative inventory plus that repository-supported adapter result reproduces the failure using production core modules.

Reproduction, from repository root:

```js
import { createSnapshotWriteback } from './modules/core/snapshot-writeback.js';
import { runDeleteRecovery } from './modules/core/lifecycle-recovery.js';
const calls = [];
const write = createSnapshotWriteback({
    loadSnapshots: async () => [{
        id: 'recovery', apiId: 'openai', presetName: 'Missing',
        timestamp: 1, preset: { temperature: 0.7 },
    }],
    getPresetManager: () => ({
        getPresetList: () => ({ preset_names: [], presets: [] }),
        findPreset: () => null,
    }),
    savePreset: async () => calls.push('saved'),
});
const result = await runDeleteRecovery({
    restoreArchives: async () => ({ restored: 0, failed: 0, cleanupFailed: 0 }),
    writeBackSnapshots: () => write({ skipExisting: true }),
    clearSnapshots: async () => calls.push('history-cleared'),
    clearArchives: async () => calls.push('archives-cleared'),
});
console.log(JSON.stringify({ result, calls }));
```

Executed as `node --input-type=module -e "<the code above>"`. Observed:

```json
{"result":{"complete":true,"archive":{"restored":0,"failed":0,"cleanupFailed":0},"snapshots":{"written":0,"skipped":1,"failed":0},"snapshotsCleared":true,"archivesCleared":true,"errors":{"snapshots":null,"archives":null}},"calls":["history-cleared","archives-cleared"]}
```

No save occurs, yet both cleanup callbacks run and the transaction reports complete. On uninstall, this can discard the only recovery record for a missing preset. The verified host writer does not help because the false skip prevents it from being reached.

Required acceptance: missing results must not be treated as positive existence; respect a usable authoritative inventory and fail closed on unverifiable/contradictory fallback answers. Add a red-green regression through the delete-recovery composition, covering missing null and undefined results, existing valid results, and no-authority cases. Cleanup must not occur unless restoration/existence has actually been established.

## Verification Commands

All commands were run against this checkout:

- `npm test`: 569 passed, 0 failed, 0 skipped, approximately 9.48 seconds. Fault-injection warnings/errors in the test process are expected fixture output, not test failures.
- `npm run check`: passes native parse/link for 89 production files, static imports, circular dependency and residual symbol checks, and identical 577-key i18n sets.
- `$files = node _check.cjs --list-files | ConvertFrom-Json; foreach ($file in $files) { node --check $file; if ($LASTEXITCODE -ne 0) { throw "Syntax failed: $file" } }`: 89 production files pass.
- `git diff --check`: passes; only a Git line-ending advisory for the pre-existing `.gitignore` working change.
- `git diff --cached --check`: passes.
- Direct production-core recovery reproduction above: demonstrates R10-1 despite all required tests passing.

Code inspection additionally covered `preset-schema.js`, `save-coordinator.js`, `save-transaction.js`, `history-repository.js`, `history-import-journal.js`, `history-backup.js`, `history-import-validation.js`, `snapshot-retention-policy.js`, `runtime-lifecycle.js`, `lifecycle-recovery.js`, `host/preset-recovery.js`, grouping membership and lifecycle orchestration.

## Runtime Evidence

Environment: Windows, Intel Core i7-13650HX, Node v24.14.1, Chromium 156 headless through Playwright CLI session `blind10`. Existing local service `http://127.0.0.1:4173/tests/harness/` was reused and not stopped. No CPU throttling. Measurements are local harness observations, not universal host performance claims.

Ordinary fixture: 31 snapshots, nine presets, nested series, pinned snapshot, long mixed Unicode and literal hostile-looking display text. Both themes at all four required viewports produced **zero audit errors and zero audit warnings**. Document-width, primary touch-target, labels, metadata contrast, hidden-focusable and disclosure-state checks passed. Initial ordinary render samples were 30.8 ms (dark) and 36.4 ms (light).

Screenshots captured under `output/playwright/`:

- `blind10-dark-1280.png`, `blind10-dark-768.png`, `blind10-dark-390.png`, `blind10-dark-360.png`.
- `blind10-light-1280.png`, `blind10-light-768.png`, `blind10-light-390.png`, `blind10-light-360.png`.
- `blind10-settings-390.png`, `blind10-diff-360.png`, `blind10-empty.png`, `blind10-loading.png`, `blind10-error.png`, `blind10-performance.png`.

Visually inspected dark desktop, light 360px history, dark 390px settings, light 360px comparison, and the mobile error state. No page-level horizontal overflow or obscured primary action was observed. Settings has `.pas-settings` as its only vertical scroll owner. Comparison's harness host and internal body both scroll; Escape closes the native dialog successfully, and its audited toolbar controls remain reachable. This is not evidence that every real SillyTavern popup/theme combination has been tested.

Operations actually exercised:

- Immediate snapshot: 31 to 32 records, new ID, prior hash/timestamp/preset preserved.
- Group alias rename, undo, redo, Escape cancellation and composing Enter preservation: all true.
- Group menus: semantic open state, arrow movement, Escape, continuing Tab, outside click, activation, disposal: all true.
- Series/version disclosure: Enter, Space and pointer activation each change state and synchronize semantics.
- Batch target API change: target captured, selection scope cleared, accessible checkbox name present.
- Preset switching: mixed state rejected, target settles, no speculative snapshot, no console error.
- Comparison: selection A survives search, B can be found, named start action is visible and enabled; actual click opens the diff dialog; Escape closes it.
- Actual keyboard ArrowLeft from Settings selects Logs and keeps focus on a tab.
- Settings and logs audits pass at 390x844.
- Empty/loading/error scenarios at 360x800 pass audit and present localized state text.
- Performance: 500 snapshots, 48,234,000 bytes / 46 MiB IndexedDB, warm catalog, open 27 ms; shell 0.8 ms; payload reads/writes and archive reads all zero; no measured long tasks. Six warm view-switch render callbacks range 1.2-2.3 ms.

Unexpected browser console errors: none in exercised normal flows. Deliberate error scenario injects `HARNESS_EXPECTED_STORAGE_FAILURE`, which the harness excludes by design. Optional host-capability warnings are present. The harness is not a complete live SillyTavern integration environment.

## Disposition

Do not release or declare the optimization gate complete. Fix R10-1 with red-green evidence, rerun the complete gate and browser scenarios, then request another fresh-context independent review. No further blocking UI finding was reproduced in this review; that does not override the recovery blocker.
