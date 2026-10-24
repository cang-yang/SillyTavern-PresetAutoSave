# Independent Blind Review 4

Date: 2026-10-24. Reviewer: independent agent, fresh task context.

Reviewed the current working checkout on `dev`, base HEAD
`186301d17d17d404976051143f8b2d987583923c`, including its existing dirty and
untracked production/test files. Read `AGENTS.md` and `PRODUCT.md`; no earlier
review report, implementation summary, intended score, or author rationale was
supplied or consulted. No production source was changed.

## Verdict

**Not passed. Overall: 89.5/100.** The required browser verification has a
reproducible accessibility failure in the light-theme empty-history scenario.
All command-line verification passes. No data-loss, identity-corruption,
credential-exposure, or false-success defect was reproduced in this review.

| Dimension | Score | Concrete evidence and remaining limitation |
| --- | ---: | --- |
| Core functionality and correctness | 90 | 464 passing tests; browser manual snapshot creation increased count from 31 to 32 without losing the prior record; switch-convergence and dirty-switch acceptance passed. Real SillyTavern rather than the maintained simulated host was not available. |
| Data safety and fault tolerance | 91 | Inspected `core/save-transaction.js`, `core/save-coordinator.js`, `core/history-repository.js`, `core/history-import-journal.js`, `core/history-backup.js`, and `core/preset-schema.js`; serialized immutable requests, host-before-history ordering, verified rollback journal, tombstones, and credential filtering have focused automated coverage. Tests include import recovery, deletion writer races, restore, quota, and lifecycle failure isolation. |
| Operation logic and learnability | 90 | Readable save state, one primary snapshot action, searchable comparison selection, scoped batch targets, native empty-version disclosure, group rename/undo/redo all worked in the harness. Loading and read-failure text remains explicit. |
| Frontend engineering quality | 89 | Production renderer/controller harness, semantic menu/disclosure tests, literal hostile translations, and mounted-resource cleanup are strong. A remaining legacy opacity rule defeats the new readable metadata tokens; the empty state is not represented in a passing browser matrix. |
| Mobile, responsive, and accessible UX | 87 | Ordinary history passes 1280, 768, 390, and 360 pixel widths in both themes; comparison is usable at 360px and primary measured touch targets are 44px. Empty-state metadata fails contrast at all four widths; see P2 finding. |
| Performance and maintainability | 90 | 500-snapshot/46 MiB IndexedDB harness opens in 35.1ms warm and 63.6ms cold; warmed view callbacks at most 1.6ms, zero payload reads/writes during opening. Large legacy modules and stylesheet ownership remain maintenance debt, but deep core seams and broad tests materially contain that risk. |

Arithmetic: `(90 + 91 + 90 + 89 + 87 + 90) / 6 = 89.5`.
The score is not a substitute for the failing visual verification.

## Prioritized Findings

### P2: Empty preset metadata loses contrast through inherited opacity

- Source: `style.css:3049`, `.pas-version-empty > .pas-version-header`
  applies `opacity: 0.78`; hover restores opacity, which does not help the
  resting keyboard/touch state.
- Reproduction: open the maintained harness at
  `/tests/harness/?scenario=empty&theme=light`, wait for
  `window.__PAS_HARNESS__.ready`, then call `window.__PAS_HARNESS__.audit()`.
- At 1280x900 and 768x900 the audit reports three
  `metadata-text-contrast` errors for `.pas-version-count`,
  `.pas-version-size`, and `.pas-version-latest`.
- At 390x844 and 360x800 it reports two errors, for count and size. The
  timestamp is hidden at these compact widths.
- Measured composited contrast is **4.25391713813864:1**, below the harness's
  4.5:1 normal-text requirement. Computed foreground is `rgb(75, 82, 104)`;
  the empty header's computed opacity is `0.78`.
- Causal check: setting only the empty header's inline opacity to `1` in the
  browser makes the same audit pass with zero findings. This temporary DOM
  experiment was discarded on navigation and did not modify production files.
- Required follow-through: retain a visual distinction for empty presets
  without fading their text below contrast requirements, add a failing
  regression for this ancestor-opacity case, and rerun empty plus ordinary
  scenarios in both themes over the complete viewport matrix.

This is the outstanding verification blocker for acceptance. It is not a
claim that preset persistence or recovery is broken.

### P3: Continue reducing legacy ownership when touching these modules

Objective observation, not an additional release blocker: `auto-save.js`
has 1724 lines, `panel-group-manager.js` 1629, `preset-grouping.js` 1524,
`history-panel.js` 1298, and `history-store.js` 1173. Panel styles still interact
with the 4000-plus-line legacy stylesheet. The P2 defect is a concrete example
of the remaining cross-layer cascade risk. Future scoped changes should
continue extracting cohesive ownership rather than adding broad overrides.
No wholesale rewrite is requested by this review.

## Verification Executed

Environment: Windows x64, Node `v24.14.1`, Playwright CLI with
HeadlessChrome `156.0.0.0`. Used the existing localhost harness server on
port 4173. Timing is one-machine evidence, not a hardware-independent claim.

- `npm test`: **464 passed, 0 failed, 0 skipped**, approximately 7.5 seconds.
- `npm run check`: **passed**; 85 native production modules parsed/linked,
  no circular dependencies or residual references, identical 573-key
  English/Simplified-Chinese translation sets.
- Explicit `node --check` for `index.js` and every `.js`/`.mjs` under
  `modules/`: **85 passed**.
- `git diff --check`: **passed**; only Git's existing `.gitignore` LF/CRLF
  conversion warning appeared.
- Used `npx --yes --package @playwright/cli playwright-cli -s=blind4` for
  fresh browser navigation, viewport changes, snapshots, screenshots,
  semantic button activation, and maintained acceptance API execution.

## Browser Evidence

| Scenario | Viewports / operations | Result |
| --- | --- | --- |
| Ordinary dark series | 1280x900, 768x900, 390x844, 360x800 | All layout audits pass; no application console errors. Initial 267ms render produces a soft 250ms warning, below the 500ms product opening target. |
| Ordinary light series | Same four viewports | All audits pass; document widths exactly match viewports; no application console errors. |
| Empty light series | Same four viewports | Contrast errors described above; otherwise normal layout. |
| Loading light | 360x800 | Audit passes; visible loading message. |
| Storage-error light | 360x800 | Audit passes; visible failure and recovery instructions. Expected deliberately injected storage errors appear in raw browser logs, not unexplained runtime errors. |
| Comparison | 360x800 | A survives search/no-results/research, B can be selected, visible named start command opens actual diff popup, popup audit passes and metadata contrast is 8.65:1. |
| Group manager | 360x800 | Rename/undo/redo, IME preservation, Escape cancellation, arrow navigation, Escape/outside close, Tab continuation, activation, and disposal all pass. Measured rename control 272.61x44px. |
| Disclosures | 360x800 | Enter, Space, and click toggle both series and versions with synchronized `aria-expanded`/hidden state; unused native series renders two empty versions and no misleading actions. |
| Save/switch | Ordinary light/dark | Snapshot previous-record preservation, no speculative switch snapshot, dirty source write/history commit, and unchanged destination all pass. |
| Hostile translations | Ordinary light | Rendered literally; no injected element and no executed handler. |
| Batch scope | 360x800 | Stable target captured, API switch clears scope, checkbox has accessible name. |
| 500 snapshots, 46 MiB, warm catalog | 1280x900 | 35.1ms opening; 0.5ms shell; no authoritative or archive payload reads/writes; no opening long tasks; warmed series/flat callbacks 1.4-1.6ms. |
| 500 snapshots, 46 MiB, cold catalog | 360x800 | 63.6ms opening; 0.6ms shell; no authoritative or archive payload reads/writes; no opening long tasks; exactly one overflowing vertical owner, `.pas-snapshot-list`. |

Screenshots produced include:

- `output/playwright/blind4-dark-1280.png`
- `output/playwright/blind4-dark-768.png`
- `output/playwright/blind4-dark-390.png`
- `output/playwright/blind4-dark-360.png`
- Corresponding `blind4-light-{1280,768,390,360}.png`
- `output/playwright/blind4-empty-360.png`
- `output/playwright/blind4-loading-360.png`
- `output/playwright/blind4-error-360.png`

The ordinary light desktop/mobile and dark compact images were visually
opened during review. The harness provides real production DOM/controllers
and IndexedDB but simulates the host preset manager, popup wrapper, and
events. Full upstream host/theme compatibility remains a residual integration
risk; it is not represented as verified here.
