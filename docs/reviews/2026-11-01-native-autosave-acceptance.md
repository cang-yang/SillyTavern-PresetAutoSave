# Native Autosave Regression Acceptance

## Scope And Environment

- Baseline: ec41459d273f1b44fecbc257903b34673780daff; fix developed on dev.
- Windows, Node v24.14.1, Playwright CLI and Chromium.
- Real SillyTavern 1.18.0, revision 51ad27fb86d39a3daca3adaa970375c9670c12df.
- Host: `http://127.0.0.1:4185/`, separate config and data under
  `output/host-autosave-2026-11-01/`. No production account or preset touched.
- Test extension: `PASRegression1101`. An older globally installed
  `PresetAutoSave` was disabled only in the isolated account. Early observations
  from that older extension were discarded. The served observer and control
  contract were compared byte-for-byte with the working checkout.

## Root Cause And Red Evidence

The previous observer inferred preset keys from DOM IDs. Native controls such
as `stream_toggle` and `newchat_prompt_textarea` do not follow that inference.
Trusted user edits changed host memory but never authorized a save.

The baseline suite passed all 584 tests despite this failure. In the real host,
both controls produced zero accepted edits and zero completed autosaves, with
the on-disk preset unchanged. Native prompt-popup submission still worked.

Before changing production code, this command failed all three matching tests:

```text
node --test --test-name-pattern="native utility|native stream" tests/host-preset-edit-events.test.mjs tests/integration/save-intent-runtime.test.mjs
```

Failures asserted a missing accepted edit and missing preset/history writes.
Tests exercise the observer path instead of bypassing it with manual save.

## Green Evidence

The host adapter now owns an explicit native-control-to-canonical-field
contract. Canonical storage, edit scopes, trusted-event requirements and the
serialized writer are unchanged.

```text
node --test tests/host-preset-edit-events.test.mjs tests/integration/save-intent-runtime.test.mjs
playwright-cli -s=autosave-host run-code --filename=tests/harness/real-host-autosave.mjs
npm test
npm run check
git diff --check
```

- Focused tests: 40 passed.
- Full suite: 587 passed, zero failed/skipped.
- Static module checks: 92 production modules; identical 577-key i18n sets.
- `node --check` passed separately for all 92 production JavaScript files.
- Whitespace check passed; only an existing unrelated `.gitignore` line-ending
  warning was emitted.
- The browser harness compared 99 native selectors with the actual host's
  `settingsToUpdate` contract, including exclusions.
- Actual checkbox, numeric input, utility textarea and prompt-popup submission
  each produced a successful `/api/presets/save` response and matching history.
- Twenty ambient extension-state mutations with settings events produced no
  additional save.
- The isolated `OpenAI Settings/Default.json` was read independently from disk:
  `stream_openai=true`, `openai_max_tokens=413`, and both utility/main prompt
  markers matched the browser test. All four remained correct after page reload.
- Screenshot: `output/playwright/native-autosave-real-host.png`.
- Final browser console: zero errors and warnings. The host server separately
  logged an external AI Horde metadata connection reset; this did not prevent
  the tested preset requests and is not claimed to have been repaired.

## Focused Review And Cleanup

A separate read-only reviewer inspected the six changed production/test files
against the baseline, compared native selectors with the host source and ran
the focused suites: 40 passed. It independently loaded the old observer in
memory against the new observer tests: 22 passed and the native-control
regression failed at `stream_toggle`. No actionable finding was reported.
The reviewer did not independently repeat the browser or full verification gate.

The test browser was closed and the isolated Node server was stopped after
checking its command line and data root. Port 4185 no longer had a listener.
Generated disposable data was retained locally for diagnosis.

## Repeating The Browser Check

Use a disposable host data root on port 4185. Install the current production
files as `PASRegression1101`, without another enabled Preset Auto Save version.
Open the default Chat Completion preset and its AI configuration drawer. Run
the harness above. It deliberately edits the disposable Default preset.
Never point this scenario at a real user account.

The fixture data, screenshot and local host source are not shipped in the
repository. The harness requires a separately available real host; it is not
part of the dependency-free Node suite.

## Limits

This verifies the named native paths on the stated host revision, not every
third-party editor or host fork. The user's exact failing editor and installed
host/extension revision remain unconfirmed. No claim is made that the user's
unspecified reproduction or every autosave issue is resolved. Non-OpenAI
behavior retains existing unit/integration coverage but was not re-exercised
in this real-host session. No UI layout changes were made.
