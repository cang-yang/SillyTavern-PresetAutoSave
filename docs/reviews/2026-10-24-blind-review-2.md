# Independent Blind Review 2

Date: 2026-10-24

## Scope and Isolation

Reviewed the current working checkout on `dev`, base commit
`186301d17d17d404976051143f8b2d987583923c`, including its uncommitted production
and test files. Read `AGENTS.md` and `PRODUCT.md`. No prior review, implementation
summary, defended design decisions, or target scores were supplied or consulted.
The implementation remained frozen during this review. No production files were
changed by the reviewer.

The maintained harness was exercised in Chromium through Playwright CLI against
the existing server at `http://127.0.0.1:4173/tests/harness/`. This is a real
browser running production panel/controller modules with a simulated SillyTavern
host, not a verification against a separately installed live SillyTavern instance.

## Verdict

**FAIL: one reproducible credential-exposure release blocker remains.**

The automated gate passes, and the tested primary operations are functional.
However, exporting a preset containing nested, explicitly connection-related
extension fields still includes credential values. The light-theme history
metadata also fails a direct contrast check that the current layout audit does
not perform.

| Dimension | Score | Evidence |
| --- | ---: | --- |
| Core functionality and correctness | 92.0 | 452 passing tests; browser snapshot creation preserved the existing recovery point; switch convergence and dirty-switch persistence checks passed; semantic disclosures and grouping operations passed. |
| Data safety and fault tolerance | 78.0 | Durable import journal, verified repository writes, serialized save coordination, and partial-transaction tests are substantial protections. Nested connection credentials nevertheless survive the actual backup export function, violating a non-negotiable invariant. |
| Operation logic and learnability | 92.0 | Readable save state and one dominant snapshot action; clear history/log/settings navigation; rename, undo, redo, IME cancellation, scoped batch target capture, empty/loading/error states all exercised successfully. |
| Frontend engineering quality | 89.0 | Production-controller harness, native semantic controls, lifecycle tests, and escaping tests are strong. Legacy metadata styles bypass the newer readable text tokens, while the browser audit only checks footer contrast and incorrectly leaves these rendered rows unexamined. |
| Mobile, responsive, and accessible UX | 86.0 | Required viewport matrix passes overflow/touch/hidden-focusable audits; keyboard tabs, disclosures, menu focus return, and one mobile scroll owner verified. Light-theme essential history metadata is approximately 2.5:1 contrast at 9.62-9.88px. |
| Performance and maintainability | 91.0 | 46 MiB IndexedDB harness opens with zero authoritative payload reads/writes and no recorded long tasks in sampled runs; warmed view switches below 3ms. Pure catalog benchmark performs well at 500 records. Several 1,000+ line legacy modules remain a maintenance cost, without a newly demonstrated correctness failure. |

Overall arithmetic mean: **88.0 / 100**.

The security blocker independently prevents a passing result. The overall mean
is not being used to average away the weak data-safety or accessibility dimension.

## Prioritized Findings

### P1: Nested connection credentials remain in history exports

Evidence: `modules/core/preset-schema.js:9`, `:15`, `:23`, and `:260`;
`modules/core/history-backup.js:44`; `modules/compatibility.js:377`;
`modules/panel-actions.js:442`; `modules/history-store.js:1124`.

`removeExtensionCredentials` recursively applies only the small
`isCredentialKey` vocabulary. It does not apply the known connection-field
exclusions. Consequently `extensions.provider.api_key_openai` and
`extensions.provider.custom_include_headers` are retained, although the same
field names are expressly excluded at the preset root. The latter can contain an
Authorization bearer header. This is not merely diagnostic display: the
production backup export function serializes both values.

Reproduction executed from the repository root:

```js
import { createHistoryBackup } from './modules/core/history-backup.js';
const backup = createHistoryBackup({
    'openai::Example': [{
        id: 'credential-repro',
        timestamp: 1,
        preset: {
            temperature: 1,
            extensions: {
                provider: {
                    api_key_openai: 'REVIEW_SENTINEL',
                    custom_include_headers: 'Authorization: Bearer REVIEW_HEADER',
                },
            },
        },
    }],
});
console.log(JSON.stringify(backup.data));
```

Observed: the exported JSON includes both `REVIEW_SENTINEL` and `REVIEW_HEADER`
under their original nested fields.

Required resolution: make known credential and connection-field exclusions
consistent for extension metadata, without removing ordinary prompt strings or
numeric token counters. Add a failing regression using the production backup
export and individual-preset export sanitization before changing the filter.
Include nested objects/arrays and provider-specific key spellings. Do not print
real secrets in regression output or diagnostics.

This is a release blocker under AGENTS sections 3, 7, and 13.

### P2: Light-theme history metadata is too faint, and the audit misses it

Evidence: `style.css:825` and `:1026`, with the light-theme faint token at
`style.css:3409`; `tests/harness/app.mjs:1165`;
`tests/harness/layout-audit.mjs:209`.

At 360x800 with `?theme=light`, the series metadata row computes to
`rgba(0, 0, 0, 0.36)` and 9.88px over white. Alpha compositing yields
approximately **2.52:1**. The version metadata row computes to the same
foreground and 9.62px over `rgb(248, 249, 253)`, approximately **2.50:1**.
These rows include counts, sizes, and timestamps, not disabled decoration.

The screenshots make the readability issue apparent:
`output/playwright/blind2-light-360.png` and
`output/playwright/blind2-light-1280.png`.
The harness nevertheless reports a clean audit because its text-contrast
measurement is limited to the footer.

Required resolution: use readable feature-scoped metadata tokens and a legible
compact type size, preserving row sizing, long-name behavior, and 44px targets.
Add an acceptance test measuring actual row text against composited backgrounds
in both themes rather than only checking the footer.

## Verification Commands and Results

- `git status --short --branch`: `dev`, pre-existing extensive modified and
  untracked files; no staging, reset, or cleanup performed.
- `git rev-parse HEAD`: base commit recorded above.
- `npm test`: **452 passed, 0 failed, 0 skipped**, approximately 7.28 seconds.
  Expected error-path diagnostics occur in fault-injection tests.
- `npm run check`: **PASS**; 85 extension production files parse/link without
  evaluation; no circular dependencies or residual-symbol failures; both i18n
  files have identical sets of **573 keys**.
- `node --check` for `index.js` plus every `.js`/`.mjs` below `modules/` and
  `scripts/`: **87 files pass**.
- `git diff --check`: **PASS**, with only a Git line-ending advisory for
  `.gitignore`, not a whitespace error.
- `node tests/benchmarks/history-catalog.mjs`: **completed successfully**.
- Playwright CLI session `blind2`, using `open`, `snapshot`, `resize`, `goto`,
  and `run-code` to execute the maintained harness operations, collect computed
  styles/metrics, drive actual keyboard input, and capture screenshots.
- Standalone Node invocation of `createHistoryBackup`: reproduced P1.

## Browser and Viewport Evidence

| Theme / scenario | Viewports | Result |
| --- | --- | --- |
| Ordinary dark | 1280x900, 768x900, 390x844, 360x800 | Layout audits pass; no page overflow or hidden focusable findings; first cold ordinary render 313ms generated a warning, below the repository 500ms opening target. |
| Ordinary light | 1280x900, 768x900, 390x844, 360x800 | Layout audits pass; separate measured metadata-contrast failure described above. |
| Empty / loading / error | 360x800 | Audits pass; distinct readable states appear. Error fixture deliberately emits `HARNESS_EXPECTED_STORAGE_FAILURE`; this is not an unexpected production console error. |
| 500 snapshots, 46 MiB, warm/cold catalog | 1280x900 | Audits pass; no authoritative payload reads/writes or archive payload reads on open; warmed render callback maxima 2.2ms warm / 1.7ms cold. |
| 500 snapshots, 46 MiB, warm catalog | 390x844 | Audit passes; render 19.7ms, shell 0.4ms, no recorded long tasks or authoritative payload reads/writes. |

Screenshots captured under `output/playwright/blind2-{dark,light}-{1280,768,390,360}.png`
and `output/playwright/blind2-{empty,loading,error}-360.png`.
The 1280 and 360 ordinary screenshots were visually inspected directly.

Browser workflows exercised:

- Immediate snapshot: count 31 -> 32, new ID, previous ID/hash/timestamp/payload
  preserved.
- Group alias rename, undo, redo, IME composition protection, Escape cancel:
  all true.
- Grouping menu semantics, arrow navigation, Escape focus return, Tab
  continuation, outside dismissal, action dispatch, disposal: all true.
- Grouping search at 360px: 272.61x44px; grouping layout audit passes.
- Series/version disclosures: Enter, Space, and click each update state and
  controlled content consistently.
- Hostile translated HTML: rendered literally, no injected element or executed
  handler.
- Preset-switch convergence: mixed state rejected, correct target settles, no
  speculative snapshot.
- Dirty switch guard: source persisted with history, destination unchanged and
  correctly settled.
- Batch scope: stable captured target and accessible name verified.
- Native dropdown takeover, flat and nested: keyboard open/expand/select/Escape,
  exact numeric/whitespace names, renamed option refresh, teardown and remount
  all pass.
- Actual keyboard ArrowRight moves history -> logs -> settings; Home returns to
  history. Focused settings tab has a 2px purple outline.
- At 390x844 ordinary history, the only visible overflowing vertical scroll
  owner is `.pas-snapshot-list` (620px client height / 763px content).
- No unexpected console errors in ordinary or performance scenarios.

## Performance Environment and Residual Risk

Windows, Node v24.14.1, Intel Core i7-13650HX. Catalog benchmark uses a
structured-clone memory adapter, three warmups and 20 samples:

| Records | Cold build | Summary read p95 | Bucket update p95 |
| --- | ---: | ---: | ---: |
| 500 | 32.80ms | 3.17ms | 6.61ms |
| 5,000 | 179.00ms | 29.44ms | 56.42ms |

These are measured local results, not a claim about all host devices. The
5,000-record bucket update exceeds 50ms in this synthetic benchmark, outside the
specified 500-snapshot ordinary fixture; monitor it as a scaling limitation.
Legacy modules such as `auto-save.js` (1,724 lines), `panel-group-manager.js`
(1,629), and `preset-grouping.js` (1,524) still deserve incremental extraction,
but broad rewrites are not required to resolve the two findings.

A real installed-host integration run remains outside this review's evidence.
After fixing both findings, rerun the complete verification gate and request
another fresh-context review; this report does not certify a 90+ result.
