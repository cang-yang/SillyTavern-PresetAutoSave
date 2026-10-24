# Independent Blind Review 7

Date: 2026-10-24

## Scope and Independence

Reviewed the current working checkout on `dev`, not just committed HEAD. The checkout contains substantial tracked and untracked work. No production files were changed or staged. This reviewer received the checkout, repository rules, product definition, and a request to inspect, verify, exercise the UI, and score it. No earlier review report or implementation narrative was read.

Read `AGENTS.md` and `PRODUCT.md`; inspected persistence, canonicalization, import recovery, save coordination, lifecycle, comparison rendering, and the maintained browser harness.

## Verdict

**Does not yet pass the independent review gate.** The complete automated verification gate passes. One reproducible primary comparison accessibility/learnability problem remains: compact prompt diffs convey which side a line belongs to and whether it was added or removed only through color and CSS class names. The arithmetic mean is **89.5**, with three dimensions below 90.

## Scorecard

| Dimension | Score | Concrete evidence |
| --- | ---: | --- |
| Core functionality and correctness | 93 | All 487 tests pass. Browser snapshot creation preserves the previous snapshot; comparison selection survives search; mixed-state switching is rejected; dirty source saves complete without changing the destination. `modules/core/save-coordinator.js` captures requests and serializes workers. |
| Data safety and fault tolerance | 94 | `modules/core/history-repository.js:163` verifies migrated writes; import uses a durable prior-image journal in `modules/core/history-import-journal.js:41`; strict external validation resides in `modules/core/history-import-validation.js`; canonical filtering and credential exclusions are shared in `modules/core/preset-schema.js`. Fault/recovery, restore, deletion, and lifecycle integration tests pass. No data-loss or credential-exposure reproduction was found in this review. |
| Operation logic and learnability | 87 | Current save status, snapshot, search, visible comparison start, and scoped actions are readily available. Group rename/undo/redo and comparison search work. However, the compact prompt comparison does not identify A/B or addition/removal on its text rows, and B can appear before A, making a common comparison's direction ambiguous without color interpretation. |
| Frontend engineering quality | 88 | Real production controllers/styles are exercised by the maintained harness; popup cleanup, context-menu ownership, hostile translation escaping, and settings lifecycle tests pass. The diff renderer still emits unlabelled generic `div` cells and the audit reports this ambiguous comparison as passed. The important semantic gap needs both a renderer change and an acceptance test. |
| Mobile, responsive, and accessible UX | 85 | All eight ordinary theme/viewport layout audits pass; inspected desktop and compact screenshots. Primary targets in audited surfaces meet 44px, no horizontal overflow was found, and Escape restores comparison-trigger focus. Compact prompt diff semantics fail to survive the single-column layout, which is a release-gating accessibility problem for this primary task. |
| Performance and maintainability | 90 | The 500-snapshot/46 MiB IndexedDB scenario opens in 35.7 ms warm and 76.6 ms cold, with 2.7 ms maximum warmed view-render callback and no measured long tasks or authoritative payload I/O on open. Deterministic core seams have substantial tests. Several legacy orchestration/UI modules remain very large, so future changes still require care. |

Mean: `(93 + 94 + 87 + 88 + 85 + 90) / 6 = 89.5`.

## Prioritized Findings

### P2, Release Gate: Prompt Diff Direction Is Color-Only on Compact Screens

Locations:

- `modules/diff-viewer.js:463`: `contentTableHTML` renders generic `.pas-diff-cline-a` / `.pas-diff-cline-b` cells containing only line numbers and prompt text.
- `modules/diff-viewer.js:477` and `modules/diff-viewer.js:480`: deleted and added lines have no visible side/change labels or equivalent accessible identification.
- `style.css:2558` and `style.css:2565`: deletion/addition is represented by red/green backgrounds.
- `style.css:3005`: compact layout collapses the A/B columns to one column.

Reproduction performed in Chromium:

1. Open `/tests/harness/?theme=light` at `360x800`.
2. Run the maintained `prepareComparisonSelection()` helper, which selects the latest labelled revision as A and the preceding revision as B.
3. Activate the visible `开始对比` button using Playwright's role-based click.
4. Inspect the prompt section and accessibility snapshot.

Observed:

- The header identifies A as revision 5 and B as the preceding snapshot.
- The first content row is B's revision 4, class `pas-diff-cline-add`.
- The second content row is A's revision 5, class `pas-diff-cline-del`.
- Each row contains only `1` and the prompt text. Both row `aria-label` values are null; their cells have no semantic side/change identification either.
- Computed grid columns are a single `319px` column.
- The green/red backgrounds are the only visible addition/removal distinction on these full-line rows. The accessibility snapshot exposes two unlabeled text blocks, not their A/B identities.
- `window.__PAS_HARNESS__.audit()` nevertheless reports no findings.

Evidence: `output/playwright/blind7-diff-360.png`; `.playwright-cli/page-2026-10-24T12-04-34-866Z.yml`. This is not a claim that a particular screen reader was run; the browser accessibility snapshot and DOM were inspected directly.

Why it blocks: comparing historical prompt content is a primary product workflow. Once columns stack, users cannot reliably infer side identity from position, because additions can precede removals. The repository forbids color-only state and requires common operation scope to remain understandable. This is not data corruption, but the operation/UX gate remains below 90 until the direction is explicit.

Recommended acceptance: show meaningful A/B and added/removed/unchanged labels or equivalent non-color markers for compact rows, and expose those identities accessibly at all widths. Test both A-newer/B-older and A-older/B-newer, pure addition/removal, replacement, unchanged lines, and swap. A passing test must fail against the current renderer.

### P3: Legacy Module Size Remains a Maintenance Risk

Current line counts include `modules/auto-save.js` 1747, `modules/panel-group-manager.js` 1629, `modules/preset-grouping.js` 1524, `modules/history-panel.js` 1298, and `modules/history-store.js` 1175. These are not by themselves new release blockers: cohesive core seams and focused tests materially reduce risk. Continue incremental extraction when touching an ownership boundary; do not mechanically split files or rewrite the data path to chase a size target.

## Verification Run

All commands were run from `D:/JAVA/XM/SillyTavern-PresetAutoSave`.

- `git status --short`: inspected dirty checkout; preserved existing work.
- `git branch --show-current`: `dev`.
- `npm test`: 487 passed, zero failures/cancellations/skips.
- `npm run check`: all checks passed; 86 extension production modules parsed/linked, no dependency cycles, identical 573-key i18n sets.
- `node --check` over `index.js`, all production `.js/.mjs` under `modules`, and `.js/.mjs` under `scripts`: 88 files passed.
- `git diff --check`: passed; only the existing LF/CRLF advisory for `.gitignore`.

Expected fault-injection diagnostics occur in tests; these are not browser regressions.

## Browser and Runtime Evidence

Used the installed Playwright CLI and the already-running local maintained harness at `http://127.0.0.1:4173/tests/harness/`. No external service or real user history was exercised.

Ordinary scenario:

| Theme | Viewports | Result |
| --- | --- | --- |
| Dark | 1280x900, 768x900, 390x844, 360x800 | All four harness audits passed with zero findings. |
| Light | 1280x900, 768x900, 390x844, 360x800 | All four harness audits passed with zero findings. |

Screenshots saved as `output/playwright/blind7-{dark,light}-{1280,768,390,360}.png`; directly inspected dark 1280 and light 360. Long Unicode/hostile names remain literal and compact layout is contained. The initial compact main surface has one scroll owner, `.pas-snapshot-list`; after comparison dismissal it measured 510px client height / 772px scroll height.

Runtime helpers completed successfully:

- `exerciseCoreOperations`: snapshot count 31 to 32, unique ID, previous snapshot preserved, group rename/undo/redo, IME preservation, Escape cancellation.
- `exerciseDisclosures`: Enter, Space, and click synchronize expansion and content visibility.
- `exerciseUnusedNativeSeries`: two unused native presets remain visible with empty-history state.
- `exercisePresetSwitchConvergence`: mixed state rejected, destination settles, no speculative snapshot.
- `exerciseDirtyPresetSwitchGuard`: source persisted and recorded; destination unchanged.
- `exerciseBatchTargets`: immutable target captured, stale scope cleared on API switch.
- `prepareComparisonSelection`: A survives search; B completes selection; visible named start control.
- `exerciseGroupingMenus`: semantic open, arrow navigation, Escape, Tab, outside dismissal, action activation, and disposal.
- `exerciseGroupingLayout`, `exerciseHostileTranslations`, and `exerciseTakeover`: pass, including literal hostile text and teardown/remount.
- Empty, loading, and storage-error scenarios display distinct states and pass layout audits.
- Actual comparison dialog opened using the role-based button; Escape closed it and returned focus to `.pas-btn-start-diff`.

No unexpected browser console errors were recorded. The harness reports the expected optional missing template-render capability warning.

Performance environment: Windows, Intel Core i7-13650HX, Node v24.14.1, Playwright-launched local Chromium, 360x800 viewport, 500 snapshots totaling 48,234,000 bytes.

| Catalog | Shell | Open | Max warmed view callback | Payload reads/writes | Long tasks |
| --- | ---: | ---: | ---: | --- | --- |
| Warm | 0.7 ms | 35.7 ms | 2.7 ms | 0 / 0 | None recorded |
| Cold | 0.8 ms | 76.6 ms | 2.7 ms | 0 / 0 | None recorded |

Both also recorded zero archive payload reads. These are repeatable harness measurements, not a claim about every user device or live SillyTavern installation.

## Limits

The harness uses production extension code and IndexedDB with a simulated SillyTavern host contract. A full deployed SillyTavern installation, native mobile browser, and assistive-technology application were not available in this review. Existing tests and source inspection supply the remaining fault-path evidence. No passing score is asserted for the unresolved compact diff semantic gap.
