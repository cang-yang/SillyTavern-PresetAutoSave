# Independent Checkout Review 9

Date: 2026-10-27 (Asia/Shanghai).

## Scope And Independence

Reviewed the current working tree on `dev`, based on repository files, `AGENTS.md`, and `PRODUCT.md`. HEAD was `5a8a7f9a8645b3e95b629f2a5e72b86a9527cced`; the reviewed tree includes tracked modifications and untracked production/test files, not merely HEAD. No earlier review report or implementation narrative was consulted. Production files and tests were not edited.

Environment: Windows x64, Node v24.14.1, Playwright CLI, HeadlessChrome 156.0.0.0. Browser evidence used the maintained production-controller harness at `http://127.0.0.1:4173/tests/harness/`. This is not a claim of testing inside a separately installed, live SillyTavern server.

## Verdict

**Not yet passing the six-dimension optimization gate.** Automated verification passed and no reproducible data-loss, identity-corruption, false-success, injection, or lifecycle duplication blocker was found in this review. However, the mobile/responsive/accessibility dimension remains below 90 because ordinary visible organization metadata fails contrast requirements in the light theme, and the maintained audit currently misses it.

| Dimension | Score | Evidence and remaining limitations |
| --- | ---: | --- |
| Core functionality and correctness | 94.0 | 568 passing tests; browser snapshot creation increases history from 31 to 32, preserves the preceding ID, and reports committed. Group rename, undo/redo, IME preservation, Escape cancellation, native selector takeover, and preset-switch convergence checks pass. |
| Data safety and fault tolerance | 94.0 | Reviewed canonical schema, serialized save transaction, history repository, import journal, retention policy, recovery adapter, and lifecycle orchestration. Tests cover recovery conflicts/readback failures, rollback, retry, partial-record retention, and connection-secret exclusion. Browser hostile-translation check creates no injected element and executes no handler. |
| Operation logic and learnability | 92.0 | Save state is visible in the header; one dominant snapshot action; common filters and named views remain visible. Rename and undo/redo complete inline. Menu Escape/outside-click, arrows, and focus continuation pass. Comparison exposes A/B and textual change state. Small organization badges still reduce scan clarity. |
| Frontend engineering quality | 91.0 | Production panel controller and styles are exercised, with semantic tabs, disclosures, bounded rendering, and scoped view modules. All imports link, no circular dependencies, and both locales have 577 identical keys. Contrast audit selectors omit a visible badge category, allowing a false all-clear. |
| Mobile, responsive, and accessible UX | 88.0 | Required four viewport sizes pass the maintained layout audit in both themes; no page overflow or unreachable primary command was observed. Native keyboard tab navigation and grouping menu checks pass; grouping action target measured 272.61 x 44 px. F1 remains: light-theme subgroup labels have only 1.55-1.63:1 contrast at 9.1 px. |
| Performance and maintainability | 90.0 | 500-snapshot/46 MiB IndexedDB scenario has zero authoritative payload reads/writes on measured opens, no recorded long tasks, and warm view-switch callbacks below 3 ms. Core seams and focused tests substantially reduce risk. Large legacy UI/style modules and selector-based coverage still require disciplined incremental extraction. |

Arithmetic mean: **91.5 / 100**. The mean does not override the 88.0 accessibility dimension.

## Prioritized Finding

### F1 [P2] Light-theme subgroup metadata is not readable enough, and the audit misses it

- Production source: `style.css:1517` defines `.pas-tag-subgroup` with `color: #93c5fd` and a translucent blue background. There is no effective light-theme correction for this badge in the reviewed tree.
- Renderer: `modules/panel-list-render.js:419` exposes meaningful organization information such as `1 子组` through this class.
- Reproduction: open the ordinary scenario with `?theme=light`, at 390 x 844 or 1280 x 900. Inspect the subgroup badge next to the current series and its nested creative-writing series.
- Actual browser styles: foreground `rgb(147, 197, 253)`, background `rgba(96, 165, 250, 0.12)`, font size `9.1px`.
- Using the repository's `collectTextContrast` helper over actual computed ancestor backgrounds and opacity gives **1.5499224251:1** for the current series and **1.6284839985:1** for the nested series. This is materially below the repository's 4.5:1 normal-text audit threshold.
- Visual evidence: `output/playwright/blind9-light-390.png` and `output/playwright/blind9-light-1280.png`. The same labels are plainly distinguishable in dark-theme screenshots, so this is not an inherently decorative icon with no information.
- Coverage gap: `tests/harness/app.mjs:1095` samples timestamps, sizes, hashes, and empty-state labels but not `.pas-tag-subgroup`. Consequently `window.__PAS_HARNESS__.audit()` returns zero errors while the above text fails contrast.
- Required follow-up: add a failing acceptance measurement for subgroup metadata in both themes, provide a scoped readable light-theme treatment, and re-run the viewport/contrast checks. Prefer consistent readable metadata typography as well; manual-origin badges are 9 px, although their measured light-theme contrast is above 4.5:1.

This is an accessibility quality-gate failure, not evidence of lost user data or an inaccessible primary task.

## Commands And Automated Results

Run from the repository root:

```text
git status --short
git branch --show-current
git rev-parse HEAD
npm test
npm run check
node _check.cjs --list-files
node --check <each of the 89 listed production .js/.mjs files>
git diff --check
```

- `npm test`: 568 tests, 568 pass, 0 fail, 0 skipped; approximately 9.26 seconds.
- `npm run check`: native parse/link of 89 production files; no missing imports, circular dependencies, or residual symbol errors; locale key sets identical at 577 keys.
- Every explicit production `node --check` succeeded.
- `git diff --check`: exit 0; only line-ending conversion warnings on existing worktree files.
- Test output includes deliberately simulated storage/host errors; these are expected fault-injection cases, not failing tests.

Reviewed fault-path implementations include `modules/core/history-repository.js`, `modules/core/history-import-journal.js`, `modules/core/history-backup.js`, `modules/core/history-import-validation.js`, `modules/core/save-transaction.js`, `modules/core/save-coordinator.js`, `modules/core/runtime-lifecycle.js`, `modules/core/lifecycle-recovery.js`, `modules/core/snapshot-retention-policy.js`, and `modules/host/preset-recovery.js`. The recovery adapter refuses divergent existing targets and reads back newly restored content before allowing success. The import journal preserves a verified prior image and retryable recovery state.

## Browser Evidence

| Scenario | Viewports | Result |
| --- | --- | --- |
| Ordinary dark history, nested groups, long Unicode/hostile names | 1280x900, 768x900, 390x844, 360x800 | Maintained audit has zero errors at all widths. Initial render was 338 ms while the complete test run was also active, producing its 250 ms soft warning but remaining below the repository's 500 ms panel-open target. |
| Ordinary light history | Same four sizes | Maintained audit has zero errors/warnings; independent visual/computed-style inspection discovers F1. |
| Empty, error, loading | 360x800, light | Clear localized states, no layout-audit error; screenshots retained. |
| Settings tab and keyboard tab navigation | 390x844, light | ArrowRight selects/focuses the next tab; settings controls pass names/descriptions/target audit; visible focus ring confirmed in screenshot. |
| Comparison | 390x844, light | Audit passes; A/B side labels, added/removed/unchanged text, group roles, and accessible names present. |
| Group manager | Compact light | Menu keyboard arrows, Escape, outside click, Tab continuation, activation and disposal checks all true; main compact grouping target height 44 px. |

Additional exercised production hooks:

- `exerciseCoreOperations`: snapshot preservation and commit, rename/undo/redo, IME, and cancellation pass.
- `exerciseGroupingMenus` and `exerciseDisclosures`: keyboard/click semantic state synchronization and cleanup pass.
- `exerciseTakeover({ nested: true })`: open, expand, select, Escape focus return, exact names, native rename refresh, teardown, and one-wrapper remount all pass.
- `exercisePresetSwitchConvergence`: mixed state rejected, target settles, no speculative snapshot, no console errors.
- `exerciseHostileTranslations`: no injected element or executed handler; hostile string rendered literally.

The browser reported zero console errors. Expected optional-host warnings are present. A review automation locator initially assumed the desktop tab name included `31` on mobile and timed out; a fresh accessibility snapshot showed the correct compact tab name `记录`, and the corrected keyboard check passed. This was not a product failure.

Screenshots are under `output/playwright/` with prefix `blind9-`, including dark/light width matrices, settings, and empty/error/loading states. Images were visually inspected at desktop, tablet, and compact sizes; the main compact history remains full-screen with one primary vertical content scroll area and visible fixed footer.

## Performance Measurements

Fixture: 500 snapshots, 48,234,000 stored bytes (46 MiB), IndexedDB, no network requests for preset content, local Chromium without CPU throttling.

- Warm catalog, 1280x900: shell 0.6 ms; payload reads 0, writes 0, archive payload reads 0; no recorded long tasks; six warmed view-switch callbacks ranged 1.1-2.6 ms.
- Cold catalog, 390x844: render 61.1 ms, shell 0.7 ms; payload reads 0, writes 0, archive payload reads 0; no recorded long tasks; six view-switch callbacks ranged 0.9-2.8 ms.
- These measure this reproducible harness/environment, not lower-end physical mobile hardware or every possible host extension combination.

## Review Cleanup

Only this report was intentionally added to tracked documentation. Browser output is local QA evidence. The independent `blind9` Playwright session was closed after inspection. The existing harness server was left running and was not restarted or terminated.
