# Independent Product Review 6

Date: 2026-10-24

## Scope and Independence

Reviewed the current checkout on `dev`, base commit
`186301d17d17d404976051143f8b2d987583923c`, including its existing uncommitted
changes. The reviewer received the repository, AGENTS.md, PRODUCT.md, and the
instruction to inspect, verify, exercise, and score. No previous review report,
implementation summary, or requested score was supplied or consulted.
Production files were not changed by this review.

## Verdict

**Not passing.** The automated verification gate passes, and the exercised UI
is responsive and functional. One reproduced release blocker remains:
replacement import can accept an invalid, non-restorable canonical preset and
commit its replacement of valid history.

| Dimension | Score | Evidence |
| --- | ---: | --- |
| Core functionality and correctness | 88 | Save coordination, canonical parity, switch convergence, restore, and grouping tests pass; actual browser snapshot and comparison flows pass. Import accepts a record that ordinary restore rejects. |
| Data safety and fault tolerance | 82 | Verified migration, durable import rollback, quota/pin protection, and recovery tests are substantial. The reproduced malformed replacement bypasses validation, removes valid history, and reaches the committed state. |
| Operation logic and learnability | 91 | Save state and the snapshot command are immediately visible. Search remains usable during A/B selection. Group aliases support inline edit, undo/redo, IME, and Escape. Consequential import acceptance remains the issue described below. |
| Frontend engineering quality | 92 | Separated core modules, panel mounting/disposal, centralized escaping, bounded rendering, and tested markup contracts. No unexpected browser error in ordinary scenarios; legacy controllers remain large. |
| Mobile, responsive, and accessible UX | 93 | All four required widths pass in both themes; comparison and grouping also pass. Keyboard disclosures, menus, dropdown selection, Escape focus return, and 44px primary controls were exercised. |
| Performance and maintainability | 90 | 500-record, 46 MiB IndexedDB scenario opens in 32.0-68.3 ms; repeated view callback maximum 3.2 ms, zero payload reads and recorded long tasks during measured opening/navigation. Legacy file sizes remain a maintenance risk. |

Arithmetic mean: `(88 + 82 + 91 + 92 + 93 + 90) / 6 = 89.3`.
The safety and correctness dimensions fail the threshold, and the release
blocker independently prevents passing.

## Prioritized Findings

### P1: Reject non-restorable snapshots before replacement import

Locations: `modules/core/history-backup.js:25`,
`modules/core/history-backup.js:45`,
`modules/core/history-backup.js:151`,
`modules/core/history-repository.js:57`.

`validateSnapshot` checks that `preset` is an object but then accepts an empty
canonical result. For example, the OpenAI preset `{not_a_preset: true}` becomes
`{}` and passes validation. It also accepts `pinned: "false"` as a string.
The resulting record is enriched as `saveStatus: "committed"`.

The actual `HistoryRepository` replacement path was exercised with in-memory
storage dependencies. A valid, pinned `openai::Good` history was replaced by
the invalid imported record. The call resolved with `imported: 1`, the old
history was no longer readable, and the only new preset payload was `{}`.
The import journal regards this as successful and removes its rollback image.
By contrast, `modules/core/preset-write-commands.js:9` explicitly rejects a
restore with no canonical content. Thus a successful import can leave the
user with an unusable recovery record after replacing useful history.

This violates the complete-payload validation/fail-closed contract. A
scope-specific replacement confirmation is not a substitute for validating
whether incoming records are recoverable.

Reproduction, run at the repository root with `node --input-type=module -e`
and the following JavaScript as its argument:

```js
import { buildHistoryImportPlan, applyHistoryImportPlan } from './modules/core/history-backup.js';
import { HistoryRepository } from './modules/core/history-repository.js';
const memory = () => {
    const data = new Map();
    return {
        getItem: async key => data.get(key) ?? null,
        setItem: async (key, value) => data.set(key, structuredClone(value)),
        removeItem: async key => data.delete(key),
        keys: async () => [...data.keys()],
    };
};
const repository = new HistoryRepository({ legacyStore: memory(), v2Store: memory() });
const good = {
    id: 'good', timestamp: 1, preset: { temperature: 0.8 },
    apiId: 'openai', presetName: 'Good', pinned: true,
};
await repository.setItem('openai::Good', [good]);
const existing = new Map([['openai::Good', await repository.getItem('openai::Good')]]);
const invalid = {
    version: 2,
    data: {
        'openai::Broken': [
            { id: 'broken', timestamp: 2, preset: { not_a_preset: true }, pinned: 'false' },
        ],
    },
};
const plan = buildHistoryImportPlan(invalid, existing, { mode: 'replace' });
const imported = await applyHistoryImportPlan(repository, plan);
console.log(JSON.stringify({
    imported,
    keys: await repository.keys(),
    good: await repository.getItem('openai::Good'),
    broken: await repository.getItem('openai::Broken'),
}));
```

Observed core result:

```json
{
  "imported": 1,
  "keys": ["openai::Broken"],
  "good": null,
  "broken": [{"preset": {}, "pinned": "false", "saveStatus": "committed"}]
}
```

Required acceptance: malformed metadata and a preset with no canonical
content must fail validation before any replacement write. Test both
merge/replace and the actual repository path, prove red-green behavior, and
verify the original pinned history and storage keys are unchanged on rejection.
Retain compatibility with explicitly supported legacy optional metadata.

### P3: Continue reducing large controller responsibilities

Objective observation, not a release blocker: `modules/auto-save.js` has
1,747 lines, `modules/panel-group-manager.js` 1,629,
`modules/preset-grouping.js` 1,524, and `modules/history-panel.js` 1,298 at
review time. Existing deep core seams and integration tests mitigate the risk,
but future changes should continue extracting coherent ownership boundaries.
No mechanical split or unrelated rewrite is requested.

## Verification Executed

- `git status --short --branch`: `dev`, existing dirty checkout preserved.
- `git rev-parse HEAD`: base commit recorded above.
- `npm test`: 478 passed, 0 failed, 0 skipped; approximately 6.37 seconds.
- `npm run check`: successful static module linking for 85 production files,
  no circular dependencies or residual references, identical 573-key
  English/Chinese translation sets.
- PowerShell enumeration of `index.js` and every `.js`/`.mjs` under `modules`,
  invoking `node --check` for each: all 85 pass.
- `git diff --check`: exit 0; only the existing `.gitignore` LF/CRLF warning.
- Node executable reproduction above: confirmed malformed replacement commit.
- Global `playwright-cli`, isolated `blind6` session, using maintained harness
  at `http://127.0.0.1:4173/tests/harness/`.

Environment: Windows (`navigator.platform: Win32`), Node v24.14.1,
Chromium 156.0.8078.47. The maintained harness mounts production modules,
production styles, browser IndexedDB, and a deterministic SillyTavern host
adapter. This is not a claim of a full external SillyTavern deployment test.

## Runtime and Viewport Evidence

The ordinary fixture contains long Unicode/untrusted names, nested groups,
multiple versions, pinned records, and meaningful snapshot changes.

| Theme | Viewport | Layout audit | Panel render ms |
| --- | --- | --- | ---: |
| Dark | 1280x900 | Pass, no findings | 39.9 |
| Dark | 768x900 | Pass, no findings | 41.5 |
| Dark | 390x844 | Pass, no findings | 42.7 |
| Dark | 360x800 | Pass, no findings | 47.3 |
| Light | 1280x900 | Pass, no findings | 39.3 |
| Light | 768x900 | Pass, no findings | 44.4 |
| Light | 390x844 | Pass, no findings | 40.2 |
| Light | 360x800 | Pass, no findings | 44.8 |

Fresh screenshots are under `output/playwright/blind6-*`. Inspected desktop
dark, 360px light, and 360px comparison screenshots visually. No horizontal
page overflow, occluded primary controls, or compressed vertical words were
observed. Mobile history uses a full-screen workspace, a visible status and
command area, and the history scroll region; filter chips retain horizontal
scroll access. Long names truncate while retaining full accessible text.

Additional executed browser scenarios:

- `exerciseCoreOperations`: snapshot count 31 -> 32, distinct ID, previous
  recovery record unchanged; group rename, undo, redo, IME preservation, and
  Escape cancellation all true.
- `exerciseGroupingMenus`: semantic open state, arrow navigation, Escape,
  Tab continuation, outside dismissal, command activation, and disposal pass.
- `exerciseGroupingLayout`: visible mobile rename control 272.61x44px;
  grouping manager audits pass at all four viewport sizes.
- `exerciseHostileTranslations`: hostile text literal; no injected element
  or executed event handler.
- `exerciseDisclosures`: Enter, Space, and pointer activation agree with
  body visibility for series/version disclosures.
- `exerciseUnusedNativeSeries`: native presets without history hydrate both
  empty versions, without stranded collapsed actions.
- `exerciseBatchTargets`: captured API identity, API-switch selection reset,
  and accessible target name pass.
- `exercisePresetSwitchConvergence`: mixed live/selected state rejected,
  target settles, no speculative snapshot.
- `exerciseDirtyPresetSwitchGuard`: original preset and history committed,
  destination unchanged, target settles.
- `prepareComparisonSelection`: A survives no-result search, search remains
  usable, B enables the labeled comparison command.
- Opened the actual comparison dialog; all four viewport audits pass. Escape
  closes it and restores focus to `.pas-btn-start-diff`.
- `exerciseTakeover({nested:true})`: keyboard open/expand/select, Escape,
  exact numeric/whitespace names, native option rename, teardown restoration,
  and single-instance remount all pass.
- Empty, loading, and intentionally failed storage scenarios pass the 390px
  layout audit. Loading/error messages are distinct. The injected error
  scenario emits expected diagnostic console errors; ordinary scenarios have
  zero unexpected errors. The optional Template Render capability warning is
  expected in the host adapter.

Performance fixture: 500 snapshots, 48,234,000 bytes (46 MiB), browser IndexedDB,
1280x900. Cold-catalog opening: 68.3 ms; warm: 32.0 ms. Repeated view-switch
callback maxima: 2.5 ms cold scenario, 3.2 ms warm. Opening/navigation metrics
record zero authoritative history/archive payload reads, zero payload writes,
and no >50 ms long tasks. These observations are scoped to this local harness
and measured operations, not all possible host workloads.

## Remaining Limits

The complete automated gate passes but does not detect the reproduced malformed
import. Add coverage rather than treating the green suite as evidence that
this input is safe. A fresh independent review is required after the blocker
is fixed. No claim is made that the above sampling exhaustively proves every
external host version, screen reader, or browser combination.
