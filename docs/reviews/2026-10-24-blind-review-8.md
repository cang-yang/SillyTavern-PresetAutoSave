# Independent Product Review 8

Date: 2026-10-24
Checkout: `D:/JAVA/XM/SillyTavern-PresetAutoSave`, branch `dev`, existing staged and unstaged work preserved.
Reviewer isolation: received the checkout, `AGENTS.md`, `PRODUCT.md`, and the independent review instruction. No earlier review reports or implementation summaries were read. Production code was not edited.

## Verdict

**NOT PASSED.** Automated verification passed, and the exercised persistence, organization, switching, comparison, and lifecycle scenarios were successful. However, compact Settings switches do not satisfy the required 44x44px touch-target minimum. The maintained audit incorrectly passes that surface because it does not measure the switch's actual clickable labels.

No reproducible data loss, identity corruption, injection, false-success persistence, or duplicated lifecycle resources was found in the reviewed scenarios. The outstanding acceptance failures below must be corrected before declaring the full optimization program complete.

## Scorecard

| Dimension | Score | Evidence and deduction |
| --- | ---: | --- |
| Core functionality and correctness | 93.0 | 494 passing tests; browser manual snapshot created a distinct record while preserving the prior record; comparison selection survived filtering; dirty-switch guard saved the source without changing the destination; flat and nested takeover selection succeeded. Full SillyTavern installation was not available. |
| Data safety and fault tolerance | 93.0 | Serialized save and repository seams, migration read-back verification, durable import rollback journal, import validation, retention and lifecycle fault tests passed. Inspected `save-transaction.js`, `history-repository.js`, `history-import-journal.js`, `history-backup.js`, `preset-schema.js`, and recovery seams. This is sampled fault coverage, not proof against every browser/storage failure. |
| Operation logic and learnability | 91.0 | Current save state is textual; partial status explicitly distinguishes saved preset from incomplete history; aliases support undo/redo and IME; comparison A/B selection remains searchable; conflict import explains unavailable merge and replacement scope. Some compact secondary surfaces still depend on small controls and dense technical metadata. |
| Frontend engineering quality | 89.0 | Production renderer/controller harness, escaped hostile translations, disclosure semantics, focus restoration and owned popup resources are strong. The audit's missing Settings hit-target coverage is a material verification gap: it reports zero findings for a directly noncompliant primary control. |
| Mobile, responsive, accessible UX | 86.0 | History passed the full dark/light viewport matrix, including overflow, labeled actions, single scroll owner, and keyboard tabs. Settings toggle labels measure 38x20px, with alternate labels only 16.67px tall at both compact widths. This violates the explicit touch-target acceptance rule. |
| Performance and maintainability | 90.0 | Fresh 500-snapshot/46MiB browser opens were 29.6-71.0ms with no authoritative payload reads/writes; warmed view callbacks were at most 2.7ms. Pure interfaces and 86-file module linking help maintainability. Several legacy modules/styles remain large; initial cold ordinary opening produced a 164ms long task, though subsequent scenarios did not reproduce it. |
| **Arithmetic mean** | **90.3** | `(93 + 93 + 91 + 89 + 86 + 90) / 6`, rounded to one decimal. The mean does not override two dimensions below 90. |

## Prioritized Findings

### P2: Compact Settings switches miss the minimum touch target

- Source: `style.css:1748` sets `.pas-switch` to `width: 38px; height: 20px`; its input is 0x0. `modules/panel-settings-log.js:247` renders a separate text label and switch label.
- Runtime: open `http://127.0.0.1:4173/tests/harness/`, select Settings, and inspect `#pas-setting-enabled` or `#pas-setting-sliderReleaseSave` at 390x844 and 360x800.
- Both widths: switch label is **38x20px**; the alternate text label is **78x16.67px**. Neither offers a 44x44px clickable area. This includes the master automatic-save setting, not just an obscure auxiliary control.
- Keyboard focus is present: tabbing to the checkbox produces a 2px purple focus box-shadow on the slider. This finding is specifically about touch geometry, not missing keyboard focus.
- Evidence: `output/playwright/blind8-settings-touch-360.png`, `output/playwright/blind8-settings-360.png`; measured with `getBoundingClientRect()` on every associated `input.labels` entry.
- Required correction: provide at least 44x44px effective switch hit areas on compact layouts while retaining a compact visual face; verify both associated labels and actual pointer behavior.

### P2: The layout audit passes Settings without measuring its toggle targets

- Source: `tests/harness/app.mjs:1048` defines `importantSelector`; `.pas-switch` is absent. At line 1060, controls enumerate buttons, summaries, inputs and selected roles, but not the associated switch labels. The hidden checkbox has 0x0 geometry and is excluded as invisible.
- Runtime: with the undersized Settings switches visible at both compact widths, `__PAS_HARNESS__.audit()` returns `passed: true`, `findings: []`, zero errors and warnings.
- This can allow the same accessibility failure to survive future UI changes. The production issue and the verification issue require separate acceptance coverage.
- Required correction: measure effective clickable labels or control wrappers, cover Settings controls in the compact audit, and first demonstrate a failing regression against the current 38x20px implementation.

### P3: Retain explicit legacy-complexity and cold-start follow-up

- Source inspection found substantial responsibility concentrated in `modules/auto-save.js`, `modules/panel-group-manager.js`, `modules/history-panel.js`, `modules/preset-takeover.js`, and `style.css`. This remains maintainability debt, not evidence of a new correctness regression.
- The first ordinary page opening took approximately 355ms and recorded a 164ms long task. Subsequent remounts were 31.5-51.1ms, and all four large-history runs had no long tasks. Keep cold-start observation separate from warmed interaction claims.
- Follow-up should remain incremental and evidence-led; no broad rewrite is warranted by this review.

## Verification Commands

All commands ran from the repository root:

| Command | Result |
| --- | --- |
| `npm test` | PASS: 494 tests, 0 failures, 0 skipped; approximately 6.47s reported test duration. Expected fault-injection diagnostics appeared in output. |
| `npm run check` | PASS: native parse/link of 86 production files, no circular dependencies, no residual deleted-symbol references, 577 matching i18n keys. |
| `node --check` for `index.js` and every `.js`/`.mjs` under `modules/` | PASS: 86 production files. |
| `git diff --check` | PASS; Git emitted only the existing `.gitignore` LF/CRLF notice. |
| `git diff --cached --check` | PASS. |
| `node tests/benchmarks/save-export.mjs` | PASS; synthetic memory adapter, no user data or host I/O. |
| `playwright-cli -s=blind8 open http://127.0.0.1:4173/tests/harness/ --headed` | Existing maintained harness server used; dedicated reviewer browser session. |
| Playwright `resize`, `snapshot`, `click`, keyboard operations, `eval`, `run-code` | Browser scenarios and geometry below. Harness evaluation was used for its maintained scenario entrypoints, metrics, and screenshots. |

## Browser Evidence

Environment: Windows 11 build 26100, Intel Core i7-13650HX, 20 logical CPUs, about 31.6GiB RAM, Node v24.14.1. Browser UA identified Chrome 156 on Windows; desktop browser viewport emulation, not physical phone hardware.

### Viewport Matrix

| Surface | 1280x900 | 768x900 | 390x844 | 360x800 |
| --- | --- | --- | --- | --- |
| Ordinary history, dark | Pass | Pass | Pass | Pass |
| Ordinary history, light | Pass | Pass | Pass | Pass |
| Compact Settings touch-target probe | Not applicable | Not applicable | **Fail** | **Fail** |

Eight ordinary history screenshots are saved as `output/playwright/blind8-{dark,light}-{1280,768,390,360}.png`. Desktop and 360px screenshots were visually inspected. No horizontal page overflow was measured. At 390px and 360px, the page height matched its viewport, panel body overflow was hidden, and `.pas-snapshot-list` was the vertical scrolling region. Settings had one scrolling `.pas-settings` region.

Additional runtime outcomes:

- `exerciseCoreOperations()`: snapshot count 31 -> 32, distinct ID, old hash/timestamp/payload preserved; alias rename, undo, redo, Escape cancellation and IME preservation all true.
- `exerciseGroupingMenus()`: semantic opening, ArrowDown navigation, Escape focus return, Tab continuation, outside close, action activation and disposal all true.
- `exerciseGroupingLayout()`: compact search 273.94x44px, audit passed.
- `exerciseDisclosures()`: Enter, Space and click synchronized expansion state for series and versions.
- `exercisePresetSwitchConvergence()` and `exerciseDirtyPresetSwitchGuard()`: mixed state rejected; no speculative snapshot; dirty source persisted and committed to history; destination unchanged and settled.
- `exerciseBatchTargets()`: target captured, stale API scope cleared, accessible checkbox name retained.
- `exerciseHostileTranslations()`: hostile text rendered literally; no injected element or executable handler.
- `prepareComparisonSelection()`: selected A survived no-results search and subsequent selection of B; visible start action remained enabled and named.
- Clicked the actual comparison button at 360px; dialog covered the viewport, audit passed; Escape closed it and returned focus to `.pas-btn-start-diff`. Screenshot: `blind8-diff-360.png`.
- Keyboard ArrowLeft moved from Settings to Logs with matching selected tab and a visible 2px outline.
- `exerciseTakeover()` in flat and nested modes: keyboard opening, expansion, single selection event, Escape, exact names including whitespace/numeric strings, option rename refresh, teardown and remount all true.
- Empty, loading, and error scenarios rendered bounded, readable states at 360px. Error messages were deliberately injected by the harness; those expected console errors are not new product regressions.
- Partial save state rendered the literal distinction "preset saved, history incomplete"; conflict import disabled merge and explained replacement scope. The fixture import preview is layout evidence, not a real file-import execution.

Ordinary and performance runs had no unexpected browser console errors. The harness warns that optional template rendering is absent. Fault scenarios intentionally emitted errors.

### Large-History Performance

500 snapshots, actual IndexedDB fixture payload 48,234,000 bytes (46MiB):

| Catalog | Viewport | Panel opening | Largest warmed view callback |
| --- | --- | ---: | ---: |
| Warm | 1280x900 | 36.9ms | 2.5ms |
| Warm | 390x844 | 29.6ms | 2.6ms |
| Cold | 1280x900 | 70.8ms | 2.6ms |
| Cold | 390x844 | 71.0ms | 2.7ms |

All four runs: zero authoritative history payload reads, zero payload writes, zero archive payload reads, no recorded long tasks; shell construction 0.7-0.9ms. Screenshots: `blind8-performance-{warm,cold}-{1280,390}.png`.

Synthetic Node benchmark examples: 1MiB canonical capture p95 10.919ms; serialized memory commit p95 9.167ms; 500-record/10KiB-per-prompt backup export p95 26.107ms. These do not represent SillyTavern disk/network persistence latency or mobile hardware.

## Review Limits And Next Gate

The checkout has a maintained, useful real-browser harness and substantial runtime fault tests. It is not a full SillyTavern installation: host event timing, native popup chrome, host themes, physical touch devices, and real host save I/O remain external compatibility risks.

Fix both P2 findings with red-green evidence, rerun the full gate and viewport matrix, then request another fresh-context review. The passing arithmetic mean here must not be used to waive the frontend and mobile scores below 90.
