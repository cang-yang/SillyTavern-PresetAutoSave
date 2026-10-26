# Independent Blind Review 12

Date: 2026-10-27 (Asia/Shanghai)

## Scope And Isolation

Reviewed the current working checkout on `dev`, including staged and unstaged production changes, not only HEAD. Base HEAD was `5a8a7f9a8645b3e95b629f2a5e72b86a9527cced`.

The reviewer received the checkout, repository rules, product document, and the instruction to verify and score. No earlier review, implementation summary, desired score, or implementation defense was read. The reviewer did not implement any production or test change. Browser fixtures were isolated to the reviewer's `review12` Playwright session; that session was closed after inspection. The existing server on port 4173 was not stopped.

## Verdict

**NOT PASSED.** Automated verification passes and the arithmetic mean exceeds 90, but frontend engineering and mobile/accessibility remain below 90. Passing the existing browser audit does not establish readable settings text: that audit omits the affected descriptions and units.

No reproducible preset/history data loss, credential exposure, executable injection, or unrecoverable migration was identified in the inspected paths. The following are objective product defects, not claims that such a safety blocker exists.

| Dimension | Score | Evidence |
| --- | ---: | --- |
| Core functionality and correctness | 91.0 | 580 passing tests; real manual snapshot creates a new ID without changing the earlier record; target convergence rejects mixed selector/payload states. A literal `__proto__` custom group cannot be renamed through its normal inline control. |
| Data safety and fault tolerance | 94.0 | Immutable queued save requests, host-before-history transaction ordering, verified import rollback journal, migration readback verification, protected retention, strict recovery inventory lookup, and conflicting native-target preservation are present and exercised by tests. |
| Operation logic and learnability | 90.0 | Save state is visible immediately; search, A/B selection, native comparison dialog, grouping rename/undo/redo, scope clearing and contextual menus work. The special-name rename silently discards the submitted alias. |
| Frontend engineering quality | 89.0 | Production controller/styles run in a maintained browser harness, markup escaping and focus/menu behavior are covered. Actual settings text contrast fails while the audit returns passed; coverage excludes an entire visible text class. |
| Mobile, responsive, accessible UX | 87.0 | All four required widths pass layout/target checks in both themes; main workspace has one vertical scroll owner. Settings descriptions are 10.27px and below 4.5:1 in both tested themes, including consequential retention/disable explanations. |
| Performance and maintainability | 90.0 | 500 records/46 MiB open without authoritative payload reads/writes; measured warm open 21.6ms, cold open 62.2ms, warmed view switches at most 2.6ms. Several large legacy modules remain; the first cold browser visit had a 134ms long task. |
| **Arithmetic mean** | **90.2** | `(91 + 94 + 90 + 89 + 87 + 90) / 6 = 90.1667`, rounded to one decimal. Two dimensions fail the independent threshold. |

## Prioritized Findings

### 1. P2: Settings explanations are too small and fail text contrast; the browser audit misses them

Source:

- `style.css:1726`: `.pas-setting-desc` uses `font-size: 0.79em` and `var(--pas-fg-faint)`.
- `style.css:1741`: units also use the faint token and a reduced font.
- `style.css:3401`: light theme sets `--pas-fg-faint` to `rgba(0, 0, 0, 0.36)`.
- `tests/harness/app.mjs:1095`: audited metadata selectors do not include `.pas-setting-desc` or `.pas-setting-unit`.
- `tests/harness/app.mjs:1111`: settings control checks collect names, descriptions and target dimensions, but not rendered description contrast or size.

Reproduction:

1. Open `/tests/harness/?theme=light`, resize to 390x844 or 360x800, and activate the Settings tab.
2. Inspect `.pas-setting-desc`. Its actual font size is `10.27px` and color is `rgba(0, 0, 0, 0.36)`.
3. The local light surface is approximately RGB 234/236/241 after compositing the group tint; this gives approximately **2.47:1**, well below 4.5:1. The panel radial gradient prevents the current contrast helper from returning an exact value here. Even the best-case white background gives only approximately 2.5:1 for this black alpha, so the failure does not depend on the gradient approximation.
4. Repeat in dark theme. Computed text is RGB 111/122/144 on group RGB 25/31/44. The repository's own `collectTextContrast` returns **3.8175723554373744:1**, again below 4.5:1.
5. `window.__PAS_HARNESS__.audit()` nevertheless returns `{ passed: true, findings: [] }`.

The text includes explanations of disabling functionality and automatic history retention. These are not purely decorative labels. Screenshot: `output/playwright/review12-settings-360.png`.

Suggested acceptance: give settings descriptions and units a readable scoped token and appropriate size; extend the maintained audit to these text classes in dark and light themes, including alpha/background composition. A failing regression must demonstrate the current computed values before the fix.

### 2. P2: Inline rename silently loses an alias for a literal `__proto__` group

Source: `modules/panel-group-manager.js:749` and `modules/panel-group-manager.js:753`.

The editor copies aliases into an ordinary object and assigns `aliases[seriesKey] = value`. For a valid canonical key of `__proto__`, the inherited object setter receives the string instead of creating an own alias property.

Browser reproduction used the production settings and grouping-manager exports:

1. Set `groupingManualOverrides` to `{ Demo: '__proto__' }` and `groupingSeriesAliases` to `{}`.
2. Mount the production grouping manager with `presetNames: ['Demo']`. The rendered canonical key and group heading are both `__proto__`.
3. Click the visible rename button, fill `Renamed Literal Group`, and press Enter with Playwright's real keyboard input.
4. The editor closes, but the rendered name remains `__proto__`, persisted alias map remains `{}`, and Undo is still disabled.

The ordinary automatic preset-name parser can strip boundary underscores, so simply using `__proto__ V1.0` is not an equivalent reproduction. The manual-group route above is necessary and supported.

No preset or history bucket was renamed or deleted in this reproduction. This is a literal-key handling/operation-completion defect, not a demonstrated prototype-pollution exploit.

Suggested acceptance: use an own-property-safe map update consistent with `modules/core/group-membership.js`; test the actual inline editor path for this canonical key, including undo/redo and unchanged membership.

## Verification Commands

All commands were run against the working checkout:

| Command | Result |
| --- | --- |
| `git status --short --branch` | `dev...origin/dev`; staged, unstaged and unrelated untracked work observed and preserved |
| `npm test` | **580 passed, 0 failed, 0 skipped**, duration approximately 9.10s |
| `npm run check` | Passed; 90 production module parse/link checks, no import cycles or residual deleted symbols, 577 identical bilingual keys |
| `node --check` for `index.js` and every production `.js`/`.mjs` under `modules` | **90 files passed** |
| `git diff --check` | Passed; line-ending conversion warnings only |
| `git diff --cached --check` | Passed; line-ending conversion warnings only |

Failure-injection tests intentionally emitted their expected errors to the terminal; the test runner reported no failed test.

## Browser Evidence

Environment: Windows, Intel Core i7-13650HX / 20 logical processors, Node v24.14.1, Playwright CLI, Headless Chrome 156.0.0.0, local maintained harness on `127.0.0.1:4173`. No CPU throttling was requested. This is a maintained adapter harness, not a claim of testing against a running full SillyTavern installation.

### Viewport Matrix

| Viewport | Dark | Light | Evidence files |
| --- | --- | --- | --- |
| 1280x900 | Audit passed | Audit passed | `output/playwright/review12-{dark,light}-1280.png` |
| 768x900 | Audit passed | Audit passed | `output/playwright/review12-{dark,light}-768.png` |
| 390x844 | Audit passed | Audit passed | `output/playwright/review12-{dark,light}-390.png` |
| 360x800 | Audit passed | Audit passed | `output/playwright/review12-{dark,light}-360.png` |

The reviewer visually opened representative desktop, tablet, compact-light, settings, error and comparison screenshots. Long Unicode/HTML-like names stayed literal and did not create horizontal page overflow. Truncated names expose full values through titles/accessibility text. Required compact controls meet the harness's 44px target checks.

At 390x844 the main workspace's only vertically scrollable descendant was `.pas-snapshot-list` (620px viewport / 796px content), with no page overflow or nested main-workspace scroll trap.

### Completed Interactions

- Real manual snapshot button: count increased by one, new ID created, earlier hash/timestamp/payload preserved, success only after commit.
- Group rename, undo, redo, IME composition, Escape cancellation: normal fixture passed.
- Menus: correct role/expanded state, arrow navigation, Escape focus return, Tab continuation, outside-click closure, disposal closure all passed.
- A/B selection: search remained usable after choosing A; no-results search did not discard A; B selection enabled Start Compare; actual button opened the comparison dialog.
- Settings keyboard navigation: focused Settings tab plus ArrowLeft moved both focus and selection to Logs.
- Batch target safety: API switch cleared stale batch scope and retained accessible checkbox names.
- Hostile translation: rendered literal text, no injected element, no executable handler.
- Preset switch convergence: mixed state rejected, eventual target settled, no speculative snapshot or browser error.
- Empty/loading/error/no-results: rendered recognizable states and passed the existing audit.
- Comparison: visible A/B change labels, target sizes and audit passed at 360px. Escape closed the native dialog.

Additional dialog caveat: the harness comparison dialog at 360x800 had 35px outer vertical overflow as well as its internal body scroll. The outer close button could be reached by scrolling and Escape worked; this was not reproduced as an unreachable control or scroll trap. The synthetic host wrapper should not be treated as proof of full host-popup geometry.

Browser console recorded **zero errors**. The warning from the optional template-render capability in this harness is expected.

### Performance

- Initial browser visit: ordinary render 344ms, including a 134ms long task. This was recorded, not discarded; subsequent navigations were materially faster.
- Ordinary dark/light reloads: 36.8ms / 52.8ms render.
- Empty/loading/error: 10.8ms / 0.8ms / 6.5ms.
- 500 snapshots, 48,234,000 bytes (~46 MiB), warm catalog at 360px: 21.6ms render, 0.5ms shell, zero authoritative payload reads/writes, zero archive payload reads, no recorded long tasks.
- Same dataset, cold catalog at 1280px: 62.2ms render, 0.4ms shell, zero authoritative payload reads/writes, no recorded long tasks.
- Six warmed series/flat transitions: 1.0–2.6ms synchronous render callbacks.

These measurements describe this harness and machine only, not low-end-phone performance.

## Code And Risk Observations

The review sampled canonicalization/host capture, backup validation, repository migration/readback, import recovery journal, retention, lifecycle stop/retry, native recovery verification, save transaction/coordinator, group membership and inline editing. In particular:

- `modules/core/history-import-journal.js` writes and verifies a durable prior image and supports restart recovery.
- `modules/core/history-repository.js` serializes operations, verifies migrated records, and writes tombstones before physical deletion.
- `modules/host/preset-recovery.js` refuses an existing native target whose canonical content differs, and verifies newly restored content.
- `modules/core/save-coordinator.js` clones requests and isolates state observers; `save-transaction.js` reports partial memory/history stages after the native write.
- `modules/core/snapshot-retention-policy.js` protects pins and explicit noncommitted states.
- `modules/core/preset-schema.js` and host-capture/backup callers share credential and canonical-field boundaries.

Remaining maintainability debt is concrete: `panel-group-manager.js`, `preset-grouping.js`, `auto-save.js`, `history-panel.js`, `preset-takeover.js` and `history-store.js` remain large multi-responsibility modules. This is not a reason to perform an unrelated rewrite, but makes the missing literal-map edge case and unmeasured settings styles easier to overlook.

## Required Next Step

Fix the settings readability/audit gap and literal-key rename defect with focused red-green evidence, rerun the complete gate, and request a new fresh-context review. Do not use the 90.2 mean to override the two sub-90 dimensions.
