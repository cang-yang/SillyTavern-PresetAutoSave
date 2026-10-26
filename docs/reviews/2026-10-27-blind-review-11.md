# Independent Blind Review 11

Date: 2026-10-27 (Asia/Shanghai).

Scope: the current working checkout on `dev`, including staged and unstaged changes, not only HEAD `5a8a7f9a8645b3e95b629f2a5e72b86a9527cced`. This reviewer read AGENTS.md and PRODUCT.md, inspected production code and tests, ran verification, and operated a separate Chromium session. No prior review, implementation narrative, intended score, or defended design decision was supplied or consulted. Production code and tests were not edited.

## Decision

**Not passing. One confirmed P1 release blocker remains: API credentials with an unlisted provider suffix/prefix survive canonicalization, import, and backup export.**

| Dimension | Score | Evidence and deductions |
| --- | ---: | --- |
| Core functionality and correctness | 92.0 | 576 passing tests; real manual snapshot adds an independent record and preserves the previous snapshot; grouping rename/undo/redo, IME cancellation, disclosure activation, batch target isolation, and comparison selection passed. SaveCoordinator captures requests and serializes work; save-transaction persists before history. Full deployed-host behavior was not independently reproduced. |
| Data safety and fault tolerance | 78.0 | Verified import journaling, read-back migration checks, protected retention, strict recovery inventory lookup, recovery conflict handling, and lifecycle retry coverage. However the production export path demonstrably emits synthetic API credentials described in P1 below, violating the explicit no-secrets invariant and triggering the release cap. |
| Operation logic and learnability | 93.0 | Current save state is readable in the header, primary snapshot action is visible, scopes remain explicit, A/B selection survives search, grouping edits remain inline and reversible, and empty/loading/error content is understandable. Extremely long names necessarily require title/accessibility inspection rather than complete inline display. |
| Frontend engineering quality | 91.0 | Production renderer/controller harness, semantic tabs and disclosures, escaped hostile translations, cleanup-aware menus, and dedicated layout audits are present. Existing controller files remain large and mix several responsibilities; no new console error appeared in ordinary or performance scenarios. |
| Mobile, responsive, and accessible UX | 93.0 | All eight light/dark viewport audits passed at 1280x900, 768x900, 390x844, and 360x800. Screenshots were inspected; no page overflow or obscured primary controls was found. Real ArrowRight key presses moved focus and selection to Settings, with a visible focus outline; compact controls and settings passed the 44px target checks. |
| Performance and maintainability | 90.0 | The 500-snapshot, 46 MiB warm IndexedDB scenario opened in 34.6 ms, with zero payload reads/writes, zero archive payload reads, and no recorded long tasks. Repeated warmed view callbacks peaked at 2.6 ms. Deep core seams exist, but seven legacy modules still exceed 1000 lines; this remains maintenance debt. |

Arithmetic mean: `(92 + 78 + 93 + 91 + 93 + 90) / 6 = 89.5`.

The overall score and data-safety dimension are below 90. Automated checks pass, but the no-release-blocker condition does not.

## Prioritized Findings

### P1: Unlisted-provider API keys enter history and exported backups

Location: `modules/core/preset-schema.js:9-24`, propagated through `removeExtensionCredentials` at lines 33-48 and `modules/history-store.js:1103-1112`.

`isCredentialKey` recognizes `api_key_<provider>` and `<provider>ApiKey` only when the normalized provider appears in a finite `CREDENTIAL_PROVIDERS` set. Consequently, unmistakable structured credential keys such as `api_key_custom`, `api_key_horde`, and `customApiKey` remain inside an allowed `extensions` object. This is not a hypothetical rendering problem: the same raw synthetic values were returned by the actual canonicalization, import-validation, and export-construction functions.

Minimal production-function reproduction:

```js
import { canonicalizePreset } from './modules/core/preset-schema.js';
import { createHistoryBackup, validateHistoryBackup } from './modules/core/history-backup.js';

const preset = {
    temperature: 0.7,
    extensions: { custom: {
        api_key_custom: 'SYNTHETIC_CUSTOM_CREDENTIAL',
        api_key_horde: 'SYNTHETIC_HORDE_CREDENTIAL',
        customApiKey: 'SYNTHETIC_SUFFIX_CREDENTIAL',
    } },
};
const data = {
    'openai::x': [{
        id: 'id', timestamp: 1, apiId: 'openai', presetName: 'x', preset,
    }],
};
console.log(canonicalizePreset(preset).canonical);
console.log(createHistoryBackup(data).data['openai::x'][0].preset);
console.log(validateHistoryBackup({ version: 2, data }).data.get('openai::x')[0].preset);
```

Observed: all three outputs retain all three `SYNTHETIC_*_CREDENTIAL` values. A control field named `access_token` is correctly removed, confirming the exclusion mechanism runs but fails for unlisted providers.

Impact: a user can export/share a history backup believing the documented connection-secret exclusion guarantee, while a third-party provider's API credential remains in that backup. The existing regression at `tests/core/history-backup.test.mjs:143` covers enumerated providers only and therefore does not catch this case.

Required acceptance: add a failing regression using synthetic unlisted-provider names in both prefix and suffix forms, including nested arrays and at least the production import/export entry seams. Exclude credential-key structures without requiring a provider-name allowlist, while preserving literal prompt text, token counts, and unrelated extension data. Prove red/green before another independent review. Do not solve this by dropping the entire extensions payload.

### P3: Large legacy modules remain a maintenance constraint

Objective observation from the current checkout: `panel-group-manager.js` is 1629 lines, `preset-grouping.js` 1524, `auto-save.js` 1365, `history-panel.js` 1298, `history-store.js` 1161, `preset-takeover.js` 1124, and `compatibility.js` 1059. Existing core seams substantially help testing, so this is not a release blocker or a request for broad immediate refactoring. Continue extracting cohesive behavior when future changes touch these modules; do not expand their responsibility.

## Verification Commands

- `git status --short`: inspected both staged/unstaged work and unrelated untracked files; none were reverted or staged by this reviewer.
- `git branch --show-current`: `dev`.
- `npm test`: **576 tests passed, 0 failed, 0 skipped**, approximately 9.5 seconds.
- `npm run check`: passed; native parse/link checks cover **90 production files**, no circular imports, no residual references, **577 identical i18n keys**.
- `node --check` over `index.js` and every `.js`/`.mjs` file under `modules`: **90 files passed**.
- `git diff --check`: passed; only Git LF/CRLF conversion warnings, no whitespace errors.
- The synthetic credential reproduction above ran using `node --input-type=module -e` and exited successfully while exposing the failing invariant.

## Runtime Evidence

Environment: Windows, Node v24.14.1, HeadlessChrome/156.0.0.0; existing local server at `http://127.0.0.1:4173/tests/harness/`. A separate Playwright CLI session named `blind11` was used. No existing server or other browser session was stopped.

Viewport/theme matrix:

| Theme | 1280x900 | 768x900 | 390x844 | 360x800 |
| --- | --- | --- | --- | --- |
| Dark | passed | passed | passed | passed |
| Light | passed | passed | passed | passed |

Each final matrix audit reported zero errors and zero warnings. The first cold ordinary opening measured approximately 305 ms and produced a non-blocking 250 ms harness-target warning, still below the repository's 500 ms opening target. Subsequent matrix navigation did not reproduce that warning.

Screenshots are in `output/playwright/blind11-{dark,light}-{1280,768,390,360}.png`; desktop dark and compact dark/light images were visually inspected. Settings keyboard focus was inspected in `output/playwright/blind11-settings-360.png`. Empty/loading/error screenshots are `output/playwright/blind11-{empty,loading,error}-360.png`.

Executed production-harness operations:

- `exerciseCoreOperations`: manual snapshot count 31 to 32, new ID created, prior snapshot preserved; group rename, undo, redo, IME protection, and Escape cancellation all true.
- `exerciseDisclosures`: Enter, Space, and click synchronize visibility and expanded state for series and versions.
- `exerciseBatchTargets`: captures canonical target, clears selection after API scope changes, and retains accessible labeling.
- `exerciseGroupingMenus`: semantic opening, arrows, Escape, Tab, outside close, action activation, and disposal all true.
- `exerciseGroupingLayout`: inline rename control 272.61x44 px at 360 px viewport; audit passed.
- `exerciseHostileTranslations`: no element injection, no handler execution, literal value preserved.
- `prepareComparisonSelection`: A remains selected while searching for B; comparison command enabled and labeled; audit passed.
- Actual Playwright keyboard presses from the Records tab: two ArrowRight presses produce Settings as both focused and selected tab; layout audit passed and focus outline was visible.
- `empty`, `loading`, and `error` scenario audits passed. Error scenario deliberately emits two `HARNESS_EXPECTED_STORAGE_FAILURE` console entries; these are expected injected failures, not new ordinary-runtime errors. Ordinary/performance scenarios had zero console errors, with the expected optional Template Render capability warning.
- `performance&history=46mb&catalog=warm`: 48,234,000 stored payload bytes, 34.6 ms opening, 0.7 ms shell, no payload or archive reads, no writes, no long tasks. Six repeated warmed view-switch render callbacks ranged from 0.8 to 2.6 ms.

## Limits

The maintained browser harness runs real extension modules against deterministic host adapters and real IndexedDB, not a live user SillyTavern deployment. Mobile verification is viewport emulation with mouse/keyboard and target geometry, not a physical touch device. Import crash recovery and save failures were primarily exercised through automated integration tests rather than a real browser process crash. These limits are not substituted with claims of full deployed-host certification.

No real credential or user preset was used in the security reproduction. This review changes only this report and disposable browser artifacts.
