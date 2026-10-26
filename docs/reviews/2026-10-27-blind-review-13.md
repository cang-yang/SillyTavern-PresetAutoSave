# Independent Blind Review 13

Date: 2026-10-27 (Asia/Shanghai)

## Scope And Independence

Reviewed the current `dev` checkout independently, starting from `AGENTS.md`,
`PRODUCT.md`, repository source, tests, and the maintained browser harness. No
earlier review report, conversation history, implementation summary, or target
score was supplied or read. Existing staged, unstaged, and untracked work was
preserved. No production or test files were changed by this review.

This evaluates the current checkout, not just a commit or staged diff. Browser
evidence uses production modules mounted inside `tests/harness`, with its
simulated SillyTavern context and real browser IndexedDB. It is not a claim that
an external SillyTavern installation was exercised.

## Result

**PASS: 91.8/100 overall.** Every dimension is at least 90.0, the required
automated gate passed, and no release blocker was reproduced in this review.

| Dimension | Score | Concrete evidence |
| --- | ---: | --- |
| Core functionality and correctness | 93.0 | 584 passing tests; actual manual snapshot creates a distinct recovery point without replacing the preceding record; comparison selection, preset-switch convergence, batch target invalidation, and takeover controls completed in Chromium. |
| Data safety and fault tolerance | 94.0 | Verified repository writes and tombstones, durable import rollback, canonical secret exclusion, recovery conflict refusal, and serialized lifecycle/write paths; integration and failure-injection suites passed. Literal `__proto__` group alias rename/undo/redo retained canonical membership in the browser. |
| Operation logic and learnability | 92.0 | Readable save state, one dominant snapshot action, visible search and comparison action, scope-cleared batch state, and functional reversible inline alias edits. Keyboard menus, Escape, IME preservation, undo, and redo succeeded. |
| Frontend engineering quality | 90.0 | Production mount interfaces, controller disposal, scoped style layers, semantic tab navigation, literal rendering of hostile translations, and matching 577-key locale sets. Large legacy UI controllers remain a maintenance cost. |
| Mobile, responsive, and accessible user experience | 92.0 | Main workspace passed four widths in both themes; settings passed the full width matrix; compact grouping, comparison, and state screens passed audits. Inspected screenshots show readable text and reachable controls. Main mobile workspace has one vertical scroll owner. |
| Performance and maintainability | 90.0 | 500-snapshot/46 MiB fixture opened in 35.1 ms warm and 75.2 ms cold; repeated view-switch render callbacks <=2.6 ms, no payload reads or observed long tasks in those measurements. Deep domain/repository interfaces are valuable, but eight production modules still exceed 800 lines. |

Arithmetic mean: `(93 + 94 + 92 + 90 + 92 + 90) / 6 = 91.833...`,
rounded to **91.8**.

## Prioritized Findings

### P3: Continue Extracting Cohesive UI Responsibilities

`modules/panel-group-manager.js` is 1,593 lines, `modules/history-panel.js`
1,298, and `modules/panel-actions.js` 991. Grouping markup, edit handling,
drag/drop, popup ownership, and controller state still share one large module.
For example, grouping mount/disposal begins at
`modules/panel-group-manager.js:1428`, after extensive rendering and interaction
logic. History mounting/disposal at `modules/history-panel.js:337` likewise
coexists with data loading and many individual bindings.

This is an objective maintainability concern, not a reproduced correctness
failure or reason to perform a broad rewrite. Extract one cohesive rendering or
controller responsibility when that area next changes, keeping the current
mount/disposal interfaces and focused tests.

### P3: Supplement Harness Coverage With A Real-Host Smoke Run

The harness uses real production modules and IndexedDB, but
`tests/harness/app.mjs` supplies `presetManager`, context, and `HarnessPopup`
adapters. It therefore cannot establish compatibility with every installed host
theme, popup implementation, or preset-manager revision. The simulated
takeover test is strong: it exercises native-select keyboard interaction,
mutation observation, teardown, and remount, rather than only static markup.

A release smoke run in an actual supported SillyTavern installation should
cover opening/closing history and grouping dialogs, save/switch/restore, and
disable/re-enable recovery. Record the host revision and theme. This is a
coverage limitation, not evidence of a current host incompatibility.

## Required Verification

Commands run from the repository root:

| Command | Result |
| --- | --- |
| `git status --short --branch` | `dev`; pre-existing staged/unstaged/untracked work observed and preserved. |
| `npm test` | PASS: 584 tests, 584 passed, 0 failed, 0 skipped; reported duration 9,082.7 ms. |
| `npm run check` | PASS: 91 production modules natively parsed/linked, no cycles or residual-symbol failures, identical 577-key locale sets. |
| `node --check` for `index.js` and every `.js`/`.mjs` under `modules/` | PASS: 91 files. |
| `git diff --check` | PASS; only a Git LF/CRLF advisory for the already-dirty `.gitignore`. |

The test suite deliberately emits simulated failure diagnostics. These were
not test failures. Error-state browser scenarios likewise deliberately log
`HARNESS_EXPECTED_STORAGE_FAILURE`; ordinary browser scenarios had no console
errors or unhandled-rejection entries.

Source inspection included `modules/core/save-transaction.js`,
`modules/core/history-repository.js`, `modules/core/history-import-journal.js`,
`modules/core/history-backup.js`, `modules/core/preset-schema.js`,
`modules/core/runtime-lifecycle.js`, `modules/core/lifecycle-recovery.js`,
`modules/host/preset-recovery.js`, grouping organization operations, UI
mount/disposal code, and lifecycle orchestration.

Notable safety properties verified in source and covered by passing tests:

- Preset persistence precedes history commit, with explicit partial-transaction
  errors instead of successful-history claims after a later failure.
- Migration writes are read back and checked before publication; tombstones are
  verified before physical removal to prevent legacy resurrection.
- Import journals retain a prior image and verify recovery writes/removals.
- Canonicalization excludes connection credentials and rejects non-JSON values.
- Recovery refuses to overwrite an existing native preset with differing content.
- Stop transitions wait for pending initialization, and failed recovery remains
  retryable without treating partial cleanup as complete.

## Browser Evidence

Environment: Windows, Intel Core i7-13650HX, 20 browser-reported logical
processors, Node v24.14.1, Chromium/Chrome 156.0.0.0. No CPU throttling was
applied. Used a dedicated `blind13` Playwright CLI session against the existing
local maintained harness at port 4173.

Representative invocation:

```text
npx --no-install --package @playwright/cli playwright-cli -s=blind13 open http://127.0.0.1:4173/tests/harness/ --headed
```

`run-code` and `eval` calls exercised the harness's public acceptance methods,
collected runtime metrics, and captured screenshots. Real Playwright clicks and
keyboard input additionally switched tabs, tested ArrowLeft selection/focus,
and dismissed the comparison dialog with Escape.

### Viewports And States

| Scenario | Viewports | Observation |
| --- | --- | --- |
| Ordinary history, dark and light | 1280x900, 768x900, 390x844, 360x800 | All eight layout audits passed with no findings after reload; screenshots captured. |
| Settings, dark | 1280x900, 768x900, 390x844, 360x800 | All four audits passed; compact controls and descriptions inspected. |
| Empty, loading, error, dark and light | 360x800 | All six audits passed; screenshots captured. Expected storage errors remain visibly represented as errors. |
| Grouping manager, light | 390x844 | Audit passed; screenshot inspected. |
| Grouping layout and menu operations | 360x800 | Audit passed; tested action target measured 273.94x44 px. |
| Comparison selection | 360x800 | Search remained usable after A selection; B selection enabled the visibly labeled compare command; audit passed. |
| Diff content, light | 390x844 | Audit passed; screenshot inspected; A/B labels remain readable and hostile prompt strings render literally. |

For the 390x844 main history view, the document height equaled the viewport
height and the only overflowing vertical owner inside the workspace was
`.pas-snapshot-list`. No horizontal page overflow, unreachable primary action,
or main-workspace nested-scroll trap was observed. The diff popup uses its own
content scroller and remained dismissible with Escape.

### Operation Completion

- `exerciseCoreOperations`: snapshot count 31 -> 32, new ID created, preceding
  snapshot unchanged; inline alias rename, undo, redo, composition handling,
  and Escape cancellation all returned success.
- `exerciseLiteralGroupIdentity`: alias rename/undo/redo for `__proto__`
  preserved literal own-key data and canonical membership.
- `exerciseGroupingMenus`: semantic opening, arrow navigation, Escape close,
  Tab continuation, outside click, command activation, and disposal close passed.
- `exercisePresetSwitchConvergence`: rejected mixed state, settled the new
  target, created no speculative snapshot, and recorded no console errors.
- `exerciseBatchTargets`: captured stable target and cleared incompatible scope
  after API change.
- `exerciseDisclosures`: Enter, Space, and click synchronized disclosure state
  and body visibility for series and versions.
- `exerciseTakeover`: open/expand/select/Escape, native option mutation,
  exact numeric/whitespace names, teardown restoration, and remount passed.
- `exerciseUnusedNativeSeries`: two native versions without snapshots remained
  visible with two empty states.
- `exerciseHostileTranslations`: no injected element or executed handler;
  translated content remained literal.
- ArrowLeft from Settings moved both focus and selected state to Logs.

### Performance

Repeatable fixture:
`?scenario=performance&history=46mb&catalog=warm` and the same URL with
`catalog=cold`, at 1280x900, followed by
`exerciseViewSwitchPerformance()`.

| Metric | Warm | Cold |
| --- | ---: | ---: |
| Stored fixture size | 48,234,000 bytes | 48,234,000 bytes |
| Panel-ready render time | 35.1 ms | 75.2 ms |
| Shell render time | 0.7 ms | 0.6 ms |
| Payload reads during opening | 0 | 0 |
| Maximum callback across six view switches | 2.6 ms | 2.6 ms |
| Observed opening long tasks | 0 | 0 |

The very first ordinary-page load measured 328 ms with one 157 ms opening
task, producing a harness warning against its stricter 250 ms ordinary-data
target. It remained below the repository's 500 ms opening target. Subsequent
ordinary viewport runs had no audit warnings. These are local measurements,
not claims about slower devices or external host loading.

Screenshots are retained under `output/playwright/` with the `blind13-`
prefix, including all eight main-view/theme combinations, settings widths,
state screens, grouping, and diff. Specifically inspected desktop dark,
360px dark, 390px light, 360px settings, 390px grouping, and 390px diff images.

## Blockers And Limits

No unresolved release blocker was identified. This is finite independent
sampling backed by the complete automated gate, not a proof of absence of all
defects. External host integration, physical touch hardware, assistive-technology
speech output, and slower-device performance were not directly exercised.
The non-blocking findings above should remain visible in future maintenance.
