# Independent Blind Review 5

Date: 2026-10-24. Reviewer inspected the checkout independently, with no implementation summary, previous review report, or intended score supplied. Read `AGENTS.md` and `PRODUCT.md`. Production files were not edited.

Checkout: branch `dev`, base HEAD `186301d17d17d404976051143f8b2d987583923c`, with the existing dirty working tree included in the review. Findings describe the checkout observed during this review, before any subsequent author fixes.

## Decision

**Not passing.** One reproducible release blocker remains: imported hash metadata can suppress a genuinely different automatic recovery snapshot while the save status becomes `saved`. The full automated gate passes, but does not cover this case.

| Dimension | Score | Concrete evidence |
| --- | ---: | --- |
| Core functionality and correctness | 88.0 | 465 passing tests; live harness manual snapshot, compare, dirty-switch, grouping and menu operations succeeded. Automatic save can incorrectly return `unchanged` in finding R1. |
| Data safety and fault tolerance | 84.0 | Serialized coordinator and repository operations; durable import rollback journal; migration verification; fault, recovery and quota tests pass. R1 violates canonical deduplication and successful-history reporting. |
| Operation logic and learnability | 92.0 | Clear current save label and dominant snapshot action; visible compare command; reversible alias edit with undo/redo; search remains usable after selecting comparison A. Common non-adversarial tasks completed. |
| Frontend engineering quality | 91.0 | Production renderer/controller harness, centralized escaping, scoped styles, accessible tabs and menu controller; hostile translated markup stayed literal. Large legacy controller modules remain maintenance debt. |
| Mobile, responsive, accessible UX | 93.0 | Eight theme/viewport runs passed maintained layout audits; inspected screenshots; comparison popup and settings/log tabs passed at 390px; keyboard arrows/Escape and one mobile history scroll owner verified. |
| Performance and maintainability | 90.0 | 500-snapshot, 46 MiB IndexedDB scenario opens in 52.4 ms cold / 29.2 ms warm, with no payload reads or opening long tasks; cached view-switch callbacks at most 2.6 ms. Deterministic seams and tests help, although five legacy modules remain above 1,000 lines. |
| **Overall arithmetic mean** | **89.7** | `(88 + 84 + 92 + 91 + 93 + 90) / 6`, rounded to one decimal. |

## Prioritized Findings

### R1 - P1 Release Blocker: Unverified Imported Hash Suppresses a Changed Recovery Point

Locations: `modules/core/history-backup.js:25`, `modules/core/history-backup.js:46`, `modules/core/history-schema.js:50`, `modules/history-store.js:322`, `modules/history-store.js:330`, `modules/auto-save.js:1101`.

Import validation canonicalizes the incoming preset but retains its caller-supplied `hash`. Enrichment also copies that value into `canonicalHash`. Automatic deduplication computes the real previous canonical hash, yet accepts **either** a match with that real hash **or** a match with the unverified stored hash.

Consequently an otherwise accepted backup containing temperature `0.1`, but a stale/hash-mismatched `hash` equal to the canonical hash of temperature `0.9`, causes the next automatic `0.9` save to write the host preset without making its recovery snapshot. The production API returns `{"status":"unchanged"}`, the global save status is `"saved"`, and history still contains only temperature `0.1`. This is not merely a diagnostic-label discrepancy: the requested changed recovery point does not exist.

Reproduced through the production import, history store, save coordinator, transaction path, and save-status module, using the maintained host fixture. The fixture simulates the host and storage; no real user presets were touched.

```js
import { installRuntimeHost } from './tests/fixtures/runtime-host.mjs';
const host = installRuntimeHost();
const compat = await import('./modules/compatibility.js');
compat.initCompatibility();
const settings = await import('./modules/settings.js');
await settings.initSettings();
settings.batchUpdate({
    takeoverEnabled: false,
    autoSeedOnTakeover: false,
    fallbackPolling: false,
});
const history = await import('./modules/history-store.js');
await history.initHistoryStore();
const autoSave = await import('./modules/auto-save.js');
await autoSave.initAutoSave();
const future = { ...host.live, temperature: 0.9 };
await history.importAll({
    version: 2,
    data: {
        'openai::race': [{
            id: 'imported', apiId: 'openai', presetName: 'race',
            timestamp: 1, trigger: 'manual',
            hash: history.hashPreset(future),
            preset: { ...host.live }, pinned: false, name: '',
        }],
    },
}, 'merge');
host.live.temperature = 0.9;
console.log(await autoSave.saveNowDetailed('auto'));
console.log(host.writes.at(-1).preset.temperature);
console.log((await history.getAllSnapshots())[0].preset.temperature);
console.log((await import('./modules/core/save-status.js')).getSaveStatus());
await autoSave.teardown();
await history.teardownHistoryStore();
```

Executed with `node --input-type=module -e "<the code above>"`. Observed output:

```text
Imported 1 verified snapshots (mode: merge, source v2)
{ status: 'unchanged' }
0.9
0.1
saved
```

Required acceptance: do not trust imported/stale hash metadata as independent evidence of equal canonical payloads. Preserve compatibility with old backups, but either reject inconsistent metadata before mutation or derive current canonical metadata from the sanitized payload. Add a red-green regression proving a mismatched imported hash cannot suppress an automatic or switch-guard recovery point. Also retain explicit manual/restore retention semantics.

### R2 - P3 Follow-Up: Large Controllers Still Concentrate Responsibilities

Measured line counts: `modules/auto-save.js` 1,724; `modules/compatibility.js` 1,090; `modules/history-panel.js` 1,298; `modules/panel-group-manager.js` 1,629; `modules/preset-takeover.js` 1,124. The coordinator, resource-owner, projection, inventory and repository modules provide useful seams, but the remaining controllers still demand substantial context. This is not a release blocker or a request for unrelated broad refactoring. Continue extracting cohesive, tested responsibilities when those paths next require material changes.

## Fresh Automated Verification

All commands ran from the repository root:

- `git status --short --branch`: `dev`, existing tracked/untracked work preserved.
- `git rev-parse HEAD`: base commit recorded above.
- `npm test`: **465 passed, 0 failed, 0 skipped**, approximately 7.2 seconds.
- `npm run check`: **passed**; native parse/link of 85 production modules, no cycles or residual deleted-symbol references, identical **573-key** English/Chinese dictionaries.
- `node --check` for `index.js` and every `.js`/`.mjs` under `modules/`: **85 passed**.
- `git diff --check`: **passed**; Git emitted only its existing `.gitignore` LF/CRLF warning.
- Additional production-path Node reproduction above: confirmed R1.

Some unit fixtures deliberately log storage/recovery failures; these tests passed their assertions. They were not treated as unexplained production browser console errors.

## Browser Evidence

Used Playwright CLI in an isolated `blind5` browser session against the maintained harness at `http://127.0.0.1:4173/tests/harness/`. Environment: Windows, Node **v24.14.1**, HeadlessChrome **156.0.0.0**, `navigator.hardwareConcurrency = 20`; no CPU throttling. This is a production-module harness with a simulated SillyTavern host, not a separately installed live SillyTavern instance.

| Viewport | Dark ordinary opening | Light ordinary opening | Layout audit |
| --- | ---: | ---: | --- |
| 1280x900 | 37.5 ms | 30.8 ms | Both pass, no findings |
| 768x900 | 42.9 ms | 40.4 ms | Both pass, no findings |
| 390x844 | 42.6 ms | 41.5 ms | Both pass, no findings |
| 360x800 | 33.7 ms | 44.7 ms | Both pass, no findings |

Each ordinary run reported zero captured console errors. Screenshots were saved as `output/playwright/blind5-{dark,light}-{1280,768,390,360}.png`; directly inspected desktop, tablet and compact/mobile captures. Also inspected `output/playwright/blind5-light-390-diff.png`. Long mixed-language names remain safely rendered and truncation does not displace primary controls.

Runtime actions exercised:

- `exerciseCoreOperations`: distinct manual recovery point increased count from 31 to 32, preserved previous ID/content, rename/undo/redo succeeded, IME Enter preserved editing and Escape canceled.
- `exerciseGroupingMenus`: menu semantics, initial focus, arrow movement, Escape return focus, Tab continuation, outside dismissal and disposal all passed.
- `exerciseGroupingLayout`: 44px-high mobile search, audit passed.
- `exerciseHostileTranslations`: literal text rendered; no injected image or executed handler.
- `exerciseDisclosures`: Enter, Space and click synchronize expanded/hidden state.
- `exerciseUnusedNativeSeries`: two real empty versions rendered correctly after expansion.
- `exerciseBatchTargets`: captured API/name scope, cleared stale selection after API change, named checkbox.
- `prepareComparisonSelection`: A preserved through no-results filtering; B selected; visible named start command enabled. Clicked the real command, opened the native dialog, and audited/screenshot-inspected it at 390x844.
- `exercisePresetSwitchConvergence` and `exerciseDirtyPresetSwitchGuard`: rejected mixed state, no speculative snapshot, source persisted and recorded, destination unchanged and settled.
- Actual keyboard ArrowRight moved through record/log/settings tabs with `aria-selected=true`; Escape closed the diff dialog.
- At 390x844, actual wheel scrolling moved only `.pas-snapshot-list` (`scrollTop=170`, client height 620, scroll height 790); page scroll stayed zero and document width remained 390.
- Empty, loading and expected read-error scenarios passed at 390x844. The read-error fixture deliberately produces its known storage failure; it shows an explicit error surface rather than empty-success content.

The 500-snapshot performance scenario used **48,234,000 bytes (46 MiB)** in IndexedDB. Cold/warm opening was **52.4/29.2 ms**, shell creation **0.7/0.5 ms**, zero history payload reads/writes and zero archive payload reads during opening, and no recorded opening long tasks. Six warmed flat/series switches had maximum render callback duration **2.4/2.6 ms**. These are harness measurements on this environment, not universal hardware guarantees.

## Review Limits And Next Gate

The harness cannot prove every host-theme or SillyTavern-version combination. Broad runtime and fault-injection tests support lifecycle/recovery confidence, but R1 demonstrates why green existing tests alone are insufficient. No production code was changed, no user data was modified, and no commit or push was performed.

Fix R1 with observed red-green evidence, rerun the complete gate, and request a fresh-context independent review. This report does not certify the current product as meeting the 90+ rule.
