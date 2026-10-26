# Independent Blind Review 8

Date: 2026-10-27, Asia/Shanghai.

Reviewed checkout: `dev`, commit `5a8a7f9a8645b3e95b629f2a5e72b86a9527cced`.

**Checkout timing limitation:** Production and test files changed during this review. The initial required gate ran before those changes; the final status check showed changes in lifecycle, history, canonicalization, import, grouping, settings, and host edit-event code. The score below describes the baseline and observations collected during this session, not a certification of the final working tree. Browser checks cannot all be assigned to an immutable snapshot because the harness serves the live checkout. A separate fresh-context review must evaluate the frozen final checkout.

## Independence and Scope

The reviewer received the checkout, repository rules, product brief, and a request to inspect, verify, exercise the maintained UI harness, and score the product. No implementation summary, target score, or earlier review report was consulted. Production files were not modified. The existing modified `.gitignore` and unrelated untracked files were preserved.

This is a current-product review, not just a review of a recent diff. It covers domain and integration tests, inspection of persistence/canonicalization/lifecycle boundaries, and browser execution of production controllers through the maintained host harness. It does not claim testing against a separately running SillyTavern server.

## Verdict and Scorecard

**Baseline-scoped assessment: 92.0 overall. All six observed dimension scores are at least 90.0, the initial required automated gate passed, and no release blocker was reproduced in the exercised paths. FINAL CHECKOUT VERDICT WITHHELD because of concurrent checkout changes. This report does not satisfy the final independent review gate for the changed working tree.**

| Dimension | Score | Concrete evidence and deductions |
| --- | ---: | --- |
| Core functionality and correctness | 94.0 | 545 passing tests; trusted browser edits created exactly three intended writes; manual snapshot preserved its predecessor; switch convergence rejected mixed identity/content; comparison selection survived search. Deduction for not independently exercising an actual host server. |
| Data safety and fault tolerance | 94.0 | Serialized immutable save requests, disk-before-history transaction boundary, verified migration writes, durable import rollback, pin/quota/read-failure tests, hostile translation execution test, strict external validation and secret exclusions. No data-loss or false-success case reproduced. Host persistence remains represented by adapter contracts and mocks in this run. |
| Operation logic and learnability | 92.0 | Status is readable immediately; one main snapshot command; secondary tools are separated; searchable A/B workflow remains usable; group alias rename, undo, redo, IME handling and Escape work. The compact comparison close action has a small extra-scroll cost. |
| Frontend engineering quality | 91.0 | Semantic tabs and menus, focus restoration, pure shell/markup seams, bounded rendering, matched 577-key translations, and production-controller browser harness. Large legacy controllers still combine multiple UI responsibilities. |
| Mobile, responsive, and accessible UX | 91.0 | All required viewports in both themes pass maintained layout audits for history, logs, settings, grouping, and comparison; actual keyboard navigation works; required compact targets pass 44px checks; main workspaces have one scroll owner. Smallest comparison dialog has two scroll regions, but scrolling reaches Close and does not trap navigation. |
| Performance and maintainability | 90.0 | 500-snapshot 1/15/46 MiB runs open in 22.1-54.7ms, with zero authoritative payload reads/writes during opening; warmed view callbacks max 2.4ms. Deductions for oversized legacy modules and an initial ordinary cold-browser 105ms long task that did not recur in the matrix/performance runs. |

Arithmetic mean: `(94 + 94 + 92 + 91 + 91 + 90) / 6 = 92.0`.

## Prioritized Findings

No P0/P1 issue or other release blocker was reproduced.

1. **P3, compact comparison close placement.** In the maintained harness at `360x800`, the comparison dialog's close button initially spans y=783..827, so its label is below the viewport. The dialog has 35px of outer overflow in addition to the diff body's 201px scroll range. Two successive downward wheel gestures brought the close button entirely into view (bottom y=792), and activating it closed the dialog. This is extra navigation, not an unreachable control or reproduced scroll trap. The harness owns the appended close button: `tests/harness/harness.css:138` and `tests/harness/harness.css:153`; the production inner scroller is `style.css:2225`. Prefer a reserved footer region in the harness and confirm the equivalent host popup behavior during live-host acceptance. Evidence: `output/playwright/blind8-diff-light-360.png`.
2. **P3, legacy responsibility concentration.** `modules/panel-group-manager.js` is 1,629 lines, `modules/preset-grouping.js` 1,524, `modules/auto-save.js` 1,365, `modules/history-panel.js` 1,298, and `modules/history-store.js` 1,175. For example, `modules/history-panel.js:537` owns interaction binding while `modules/history-panel.js:1039` owns import watching. The extracted core boundaries and regression coverage substantially reduce risk, but future changes still require broad contextual reading. Continue cohesive extraction when touching these responsibilities; a wholesale rewrite is not indicated.
3. **P3, cold-browser performance observation.** The first ordinary browser load recorded 255ms readiness and a 105ms long task. The eight ordinary matrix runs subsequently reported no audit warnings, and all six large-history runs had no recorded long tasks. This is not evidence of an ordinary typing/scrolling regression, but should remain in performance evidence rather than being omitted. A reproducible cold-start sampling protocol would distinguish browser startup/JIT cost from product work.

## Required Verification

Executed from the repository root:

| Command | Result |
| --- | --- |
| `git status --short` | `dev` had an existing modified `.gitignore` and unrelated untracked files; preserved. |
| `git branch --show-current` | `dev`. |
| `git rev-parse HEAD` | `5a8a7f9a8645b3e95b629f2a5e72b86a9527cced`. |
| `npm test` | 545 tests, 545 pass, 0 fail, 0 skip; 8,494.8ms reported duration. |
| `npm run check` | Pass; native parse/link verification of 88 production files; no circular dependencies or residual references; identical 577-key i18n sets. |
| `node --check` over `index.js` and every `.js`/`.mjs` below `modules/` | 88/88 pass. |
| `git diff --check` | Initial and final calls passed; final call additionally warned about LF/CRLF in concurrently modified host edit-event source/test files. |

The final `git status --short` was no longer equivalent to the initial status. Among other files, `index.js`, `modules/core/runtime-lifecycle.js`, `modules/core/preset-schema.js`, `modules/core/history-backup.js`, `modules/core/history-import-validation.js`, `modules/history-store.js`, and their tests were modified. These subsequent changes were neither reverted nor reviewed here. No fresh `npm test`/`npm run check` result for that final state is claimed.

The unit suite intentionally logs failures from fault-injection fixtures. These are not failed assertions or unexpected browser console errors.

Syntax enumeration used:

```powershell
$files = @('index.js') + @(Get-ChildItem modules -Recurse -File |
    Where-Object { $_.Extension -in '.js', '.mjs' } |
    ForEach-Object { $_.FullName })
foreach ($file in $files) {
    node --check $file
    if ($LASTEXITCODE -ne 0) { throw "Syntax failed: $file" }
}
```

## Runtime and Viewport Evidence

Environment: Windows, Intel Core i7-13650HX, Node `v24.14.1`, Chromium `156.0.0.0`, headless browser via the available Playwright CLI. No CPU throttling was applied. The harness server was started locally on `127.0.0.1:4173`.

Browser commands used `npx --no-install @playwright/cli -s=blind8` with `open`, `goto`, `snapshot`, `click`, `eval`, and `run-code`. Screenshots were taken through the Playwright page API. Navigation waited for `window.__PAS_HARNESS__.ready`.

| Viewport | Dark | Light | Surfaces exercised |
| --- | --- | --- | --- |
| 1280x900 | Pass | Pass | History, logs, settings, grouping layout, comparison |
| 768x900 | Pass | Pass | History, logs, settings, grouping layout, comparison |
| 390x844 | Pass | Pass | History, logs, settings, grouping layout, comparison |
| 360x800 | Pass | Pass | History, logs, settings, grouping layout, comparison |

Every recorded matrix audit returned zero errors and zero warnings. Checks include overflow, required labels, compact touch targets, accessible command names, disclosure state, readable metadata contrast, hidden focusable content, and comparison side labels. Screenshots were visually inspected for desktop history, narrow light history, compact settings, and desktop/compact comparison.

Additional runtime checks:

- `exerciseCoreOperations()`: manual snapshot count 31 -> 32; distinct new ID; prior snapshot hash/time/content preserved. Group rename/undo/redo, composition preservation, and Escape cancellation all passed.
- `exerciseGroupingMenus()`: semantic opening, ArrowDown, Escape with return focus, Tab continuation, outside click, rename activation, and disposal all passed.
- `exerciseGroupingLayout()`: search field height 44px at all sizes; widths 792.61, 632.61, 302.61, and 272.61px.
- `exerciseHostileTranslations()`: literal `<img>` text displayed; no injected element and no handler execution.
- `exercisePresetSwitchConvergence()`: mixed live-memory/selector state rejected; target later settled; no speculative snapshot and no console errors.
- `exerciseDisclosures()`: series/version headers activated correctly with Enter, Space, and click; semantics agreed with visibility.
- `exerciseBatchTargets()`: immutable target captured; selection cleared after API change; checkbox accessible name present.
- `prepareComparisonSelection()`: search remained usable after selecting A, selection survived filtering, and the visible named comparison action enabled. A real button click opened comparison.
- `showDiffLabelScenario()`: removed/added/unchanged content had explicit A/B meaning; hostile prompt strings were rendered literally. Both themes passed all viewports.
- Real ArrowRight keyboard events moved focus/selection from Records to Logs to Settings.
- `exerciseTakeover({nested:true})`: keyboard open, expand/select, Escape, native option rename, exact numeric/whitespace-bearing names, teardown restoration, and single-wrapper remount all passed.
- Empty, loading, and injected-error scenarios at `390x844` passed in both themes. Expected injected storage failure is marked as such by the maintained harness, not counted as a new product console error.
- At `360x800`, history had only `.pas-snapshot-list` as an overflowing vertical workspace container; settings had only `.pas-settings`. The comparison outer/inner scrolling observation is recorded above.
- Browser console: no unexpected errors. Optional missing Template Render was a documented harness capability warning.

The edit-intent harness was also exercised using actual browser input rather than synthetic DOM edit events:

1. Ambient extension/render noise caused zero preset writes.
2. Filling Tokens with 2048 produced one write to preset A.
3. Editing Main prompt and moving focus produced the second write with the expected text.
4. Clicking Toggle main produced the third write with the prompt disabled.
5. History contained three snapshots and reported no runtime errors.
6. After `__EDIT_INTENT__.teardown()`, another Tokens edit caused no additional write.

## Performance Evidence

All cases used 500 snapshots in real browser IndexedDB. Both warm and cold catalog modes used the maintained valid summary-marker fixtures; this is not a benchmark of rebuilding an arbitrary old unmarked database.

| History size | Catalog | Ready, ms | Max warmed view callback, ms | Payload reads/writes | Recorded long tasks |
| --- | --- | ---: | ---: | --- | --- |
| 1 MiB | warm | 24.4 | 2.0 | 0 / 0 | None |
| 15 MiB | warm | 22.1 | 2.2 | 0 / 0 | None |
| 46 MiB | warm | 23.5 | 1.8 | 0 / 0 | None |
| 1 MiB | cold | 42.4 | 2.4 | 0 / 0 | None |
| 15 MiB | cold | 50.9 | 2.0 | 0 / 0 | None |
| 46 MiB | cold | 54.7 | 2.2 | 0 / 0 | None |

Archive payload reads were zero in every case. Shell creation ranged from 0.2 to 0.6ms. These timings describe this environment only; callback timing is not an end-to-end physical-device latency measurement.

## Inspected Safety Boundaries

- `modules/core/save-coordinator.js`: request cloning, serialized worker queue, target-bound coalescing, closed-state rejection, and observer isolation.
- `modules/core/save-transaction.js`: preset persistence precedes memory/history; partial completion is represented by a typed error.
- `modules/core/history-repository.js`: serialized access, read-back verification, rollback, tombstones, and recovery-before-access.
- `modules/core/history-import-journal.js`: verified durable before-images, restart recovery, and committed-marker cleanup.
- `modules/core/history-import-validation.js` and `modules/core/history-backup.js`: complete external payload validation, ID ownership/conflict checks, merge/replace planning, and rollback.
- `modules/core/preset-schema.js`: shared canonical representation and connection-secret filtering.
- `modules/core/runtime-lifecycle.js`: start/stop generation ownership and cleanup after uncancellable startup work.

Relevant passing suites cover migration corruption, pins, quota preservation, malformed reads, import validation/deduplication, save races, deletion, restore, observer failure isolation, timers, popup cleanup, grouping identity, and translation escaping.

## Evidence Files and Limitations

Local screenshot evidence:

- `output/playwright/blind8-{dark,light}-{1280,768,390,360}.png`
- `output/playwright/blind8-diff-{dark,light}-{1280,768,390,360}.png`
- `output/playwright/blind8-settings-390.png`

Playwright console evidence is in `.playwright-cli/console-2026-10-26T17-13-00-195Z.log` and `.playwright-cli/console-2026-10-26T17-19-46-813Z.log`. UTC artifact timestamps are on October 26; the local review date is October 27.

One reviewer-side browser locator attempt timed out because desktop tab names include numeric badges. Repeating the matrix with badge-tolerant role/name matching passed. This was not a product interaction failure.

Remaining coverage limits: no real host server/HTTP persistence, no mobile hardware or screen reader, no arbitrary third-party host themes, and no exhaustive proof against every corrupted database. These limits are explicit and do not replace the successful maintained harness, contract tests, or the concrete scope of this review.
