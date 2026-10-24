# Independent Blind Review 3

Date: 2026-10-24

## Scope And Independence

Reviewed the current checkout on `dev`, HEAD `186301d17d17d404976051143f8b2d987583923c`, including its existing dirty and untracked implementation files. Read `AGENTS.md` and `PRODUCT.md`; received no implementation summary, previous review, or target scores. No production files were modified. This report assesses the checkout, not only HEAD.

Environment: Windows, Node v24.14.1, Playwright CLI, Headless Chromium 156.0.0.0. Browser evidence uses the maintained production-module harness at `http://127.0.0.1:4173/tests/harness/`, with real IndexedDB and a simulated SillyTavern adapter. It is not a claim of live SillyTavern end-to-end verification.

## Verdict

**Not passed.** Automated verification is green, but a directly exercised mobile comparison state violates the product's labeled-action and 44px touch-target requirements and fails the maintained compact-layout audit. No reproducible data-loss, credential-exposure, injection, or false-success defect was found in this review.

| Dimension | Score | Concrete Evidence |
| --- | ---: | --- |
| Core functionality and correctness | 93 | 460 passing tests; browser snapshot creation, A/B comparison, snapshot viewing, restoration, switch convergence, dirty-source switch guard, group rename/undo/redo, and native selector takeover succeeded. |
| Data safety and fault tolerance | 94 | Serialized request capture in `modules/core/save-coordinator.js`; staged persistence in `save-transaction.js`; verified rollback journal in `history-import-journal.js`; repository migration/tombstone verification and canonical secret exclusion; passing fault-injection, import-recovery, deletion, restore, lifecycle, and retention tests. |
| Operation logic and learnability | 88 | Status and snapshot diagnostics are readable; reversible grouping edits work. However, the only compact comparison-launch control becomes an unlabeled play glyph, making a primary history operation unnecessarily ambiguous. |
| Frontend engineering quality | 89 | Production controller harness, scoped styles, semantic tabs, disposal tests, and 573 matching translation keys. A broad legacy CSS rule still removes a primary action label, and the maintained audit omits this control from its important-target and required-label coverage. |
| Mobile, responsive, accessible UX | 84 | Eight initial theme/viewport cases pass; keyboard tab navigation and grouping menu focus behavior pass. Comparison-selected state at 360x800 has a 24px-high launch target, no meaningful accessible action name, and history content beginning at 318px against the harness's 190px compact budget. |
| Performance and maintainability | 91 | 500-snapshot / 46 MiB IndexedDB fixture opens in approximately 31-33ms with no full payload reads or writes; warmed view callbacks are at most 2.4ms. Legacy modules remain large, and first browser warm-up produced a 126ms long task. |
| **Arithmetic mean** | **89.8** | `(93 + 94 + 88 + 89 + 84 + 91) / 6`, rounded to one decimal. |

## Prioritized Findings

### P1: Compact comparison launch loses its label and adequate touch target

Evidence: `modules/panel-shell.js:86`, `style.css:2978`, `styles/panel-v4.css:669`.

Reproduction:

1. Open the ordinary harness at 360x800.
2. Expand the current `V1.0` preset.
3. Select the first snapshot as A and a different snapshot as B.
4. Inspect `.pas-btn-start-diff` in the resulting comparison toolbar.

Actual DOM contains a play icon and a `span` with the translated action text, but neither `aria-label` nor `title`. The legacy `.pas-mini-btn span { display: none; }` rule hides the text. Playwright's accessible snapshot names the button only `▶`; locating it by its meaningful translated action name fails. Its measured box is **284.0625x24px**. Clicking the glyph does open comparison, so this is not a failed diff engine.

The control is the only launch route after choosing A/B. It violates the repository's prohibition on an unlabeled icon as the only route and the 44x44px primary-touch requirement. Fix the visible and accessible labeling and hit area together, preserving the action's scope. Add acceptance coverage after selecting A/B, not only initial panel opening.

Screenshot: `output/playwright/blind3-compare-launch-360.png`.

### P2: The selected-comparison toolbar fails the maintained compact-height contract

Evidence: `styles/panel-v4.css:666`, `tests/harness/layout-audit.mjs:4`, `tests/harness/layout-audit.mjs:142`.

The same reproduction stacks comparison label, A slot, B slot, and action row above the list. At 360x800, `.pas-snapshot-list` starts at **318px**. Calling `window.__PAS_HARNESS__.audit()` after the operation returns:

```json
{"passed":false,"findings":[{"code":"compact-chrome-too-tall","severity":"error","message":"History content starts at 318px; compact workspace chrome must end by 190px.","selector":".pas-snapshot-list"}],"summary":{"errors":1,"warnings":0}}
```

Keep the active comparison state usable without obscuring its scope or consuming this much of the compact workspace. Any intentionally different active-state budget must be justified in the design, rather than silently bypassing the audit.

### P2: Layout acceptance does not cover comparison-launch semantics or hit area

Evidence: `tests/harness/app.mjs:1048`, `tests/harness/app.mjs:1071`.

The important-control list includes snapshot A/B buttons but omits `.pas-btn-start-diff` and `.pas-btn-clear-diff`. The required-label list likewise omits comparison launch. Consequently, the missing name and 24px target are not reported, even when the controls exist. Extend interaction-state coverage and assert meaningful accessible names independently of visual overflow checks. The initial matrix passing is not sufficient evidence for this operation state.

### P3: Remaining legacy file depth is a maintenance risk

Observed production file sizes include `auto-save.js` at 1724 lines, `panel-group-manager.js` at 1629, `preset-grouping.js` at 1524, `history-panel.js` at 1298, and `history-store.js` at 1173. The deterministic seams and tests substantially mitigate this risk; file size alone is not a release blocker. Continue cohesive extraction when changing these responsibilities, particularly UI event ownership and save orchestration.

## Verification Run

- `npm test`: **460 passed**, 0 failed, 0 skipped; reported duration approximately 6.44s.
- `npm run check`: passed; native parse/link checked **85 production files**, no circular dependencies or residual imports, identical **573-key** translation sets.
- `node --check` on `index.js` and every `.js`/`.mjs` under `modules`: **85 passed**.
- `git diff --check`: passed; only a Git line-ending notice for `.gitignore`.
- Browser launched through `npx --yes --package @playwright/cli playwright-cli -s=blind3 open ...`.
- Used actual Playwright clicks and keyboard input for expanding history, selecting A/B, launching comparison, viewing a snapshot, restoring a snapshot, and arrow-key tab navigation.
- Invoked maintained runtime exercises for core operations, grouping menus/layout, hostile translations, disclosures, unused native series, switch convergence, dirty switch guards, batch target scope, flat/nested takeover, and performance view switching.

Expected fault-injection logging in the Node tests was not misclassified as a browser regression. Browser operation runs reported zero console errors. The harness's optional template-render capability warning is expected in its simulated adapter.

## Viewport And Runtime Evidence

| Theme | Viewport | Initial Audit | Panel Open |
| --- | --- | --- | ---: |
| Dark | 1280x900 | Pass, no findings | 33.7ms |
| Dark | 768x900 | Pass, no findings | 31.2ms |
| Dark | 390x844 | Pass, no findings | 29.7ms |
| Dark | 360x800 | Pass, no findings | 38.7ms |
| Light | 1280x900 | Pass, no findings | 29.7ms |
| Light | 768x900 | Pass, no findings | 30.6ms |
| Light | 390x844 | Pass, no findings | 36.7ms |
| Light | 360x800 | Pass, no findings | 42.6ms |

Screenshots: `output/playwright/blind3-{dark,light}-{1280,768,390,360}.png`. Visually inspected desktop dark and narrow light captures, plus the narrow comparison dialog and active comparison toolbar. Long Unicode names remain bounded, host-close overlap was not observed in the harness, and the main mobile surface fits its viewport.

Empty, loading, and storage-error scenarios passed their layout audit at 1280x900 and 360x800. Error state remains explicit and does not render empty history as successful. At 360px, settings had one active scroll owner (`.pas-settings`, 667px viewport / 2359px content); comparison had one inner content scroller (`.pas-diff-body`, 460px viewport / 518px content). No horizontal overflow or nested-scroll trap was observed in these exercised states.

At 360x800, core exercise increased history from 31 to 32 snapshots with a new ID while preserving the prior snapshot. Rename, undo, redo, IME preservation, and Escape cancellation all passed. Group menus passed initial focus, arrow navigation, Escape return focus, Tab continuation, outside dismissal, action activation, and disposal cleanup. Search hit area measured 272.61x44px. Hostile translated markup rendered literally without creating the injected element or executing its handler.

Dirty switch guard persisted the source, committed source history, left destination data unchanged, and settled destination tracking. Native takeover passed flat/nested keyboard selection, Escape focus return, exact unusual names, option rename refresh, teardown restoration, and single remount.

Comparison opened successfully and displayed prompt and parameter changes. Snapshot view displayed canonical JSON and transaction diagnostics. Restore returned a successful completion message with no browser console error; integration tests additionally cover its persistence and baseline semantics. These successes do not waive the compact comparison-launch findings.

Performance scenario: **500 snapshots, 48,234,000 bytes (46 MiB)**. Warm catalog open 31.1ms; cold catalog open 32.9ms; zero authoritative payload reads, payload writes, and archive payload reads in both runs. Warmed view-switch callback maxima were 2.4ms and 1.4ms respectively, with no recorded long tasks in those measured opens. Initial first-browser ordinary open was 298ms with a 126ms long task; subsequent matrix opens were 29.7-42.6ms. Results are local harness measurements, not hardware-independent guarantees.

## Release Decision

The product has strong correctness and recovery evidence, but the optimization gate is **not satisfied**. Resolve the compact comparison action and active-state layout findings, add acceptance coverage for that state, rerun the complete verification and viewport workflows, and request another fresh-context review.
