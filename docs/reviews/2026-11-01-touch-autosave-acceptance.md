# Mobile Touch Autosave Acceptance

## Reproduction And Root Cause

The user reported mobile prompt toggles and edits never saving. Their debug
log showed SETTINGS_UPDATED, but no save scheduling or result.
Earlier desktop and narrow-viewport mouse tests did not cover real touch.

On extension f97f518 and SillyTavern 1.18.0 (51ad27fb8), an isolated Chromium
context with `hasTouch: true`, `isMobile: true`, 390x844 and `locator.tap()`
reproduced:

```text
before: enabled=true,  SETTINGS_UPDATED=0, accepted DOM edits=0, saved=0
after:  enabled=false, SETTINGS_UPDATED=1, accepted DOM edits=0, saved=0
click:  isTrusted=false, target=.prompt-manager-toggle-action
```

The host's bundled `jquery.ui.touch-punch.min.js` synthesizes the click during
trusted touchend. The observer's blanket trusted-event check rejected it.
This is a demonstrated compatibility defect, not an inferred storage failure.

## Fix Boundary

The host adapter accepts one forwarded command click only after a matching
trusted single-touch start/end, on the identical connected target, with no
movement above 10 CSS pixels Manhattan distance. Evidence expires at the next
task and on cancellation, second touch, different target/action/preset or
teardown. The existing scoped before/after delta must still change.

No global synthetic-click permission, no ambient save fallback, no persistence
or history schema change. Logger policy is unchanged: without debug mode,
normal startup/success messages do not enter the log panel.

## Verification

Environment: Windows, Node v24.14.1, Chromium/Playwright CLI, real local host
on port 4185 with isolated config/data at
`output/host-autosave-2026-11-01/`. Only `PASRegression1101` is active as PAS
in the isolated account. No actual user preset or installation was modified.

- Baseline: 587 tests passed.
- Red: `node --test --test-name-pattern=touch-forwarded tests/host-preset-edit-events.test.mjs`
  failed both legitimate toggle and popup-command assertions (0 edits vs 1);
  rejection cases passed.
- Green: observer suite 28 passed; full `npm test` 592 passed, zero failures.
- `npm run check`: 93 production modules, identical 577-key translations.
- `node --check` separately passed all 93 production JS files.
- `git diff --check` passed (unrelated existing `.gitignore` EOL warning).

Browser command:

```text
playwright-cli -s=touch-host run-code --filename=tests/harness/real-host-touch-autosave.mjs
```

Results: both actual tap toggles yielded untrusted forwarded clicks and
successful native save responses plus matching committed history. Opening the
editor alone did not save. Filling the prompt and tapping native submit saved.
Three completed saves; 20 ambient mutations caused zero extra writes; no page
errors. Reload preserved the expected toggle and prompt content.

The served observer and new gate were compared byte-for-byte with the working
checkout. An independent PowerShell read of the isolated Default preset file
confirmed `enhanceDefinitions.enabled=false` and main content
`PAS touch acceptance 1793542825738`, matching the final browser result.

## Focused Review And Cleanup

A separate read-only reviewer found that switching A -> B -> A during a
gesture retained stale evidence. A regression first failed (one edit versus
zero), then passed after clearing the gate at every beforeSwitch boundary.
The reviewer rechecked the change and ran all 28 observer tests; no unresolved
actionable findings remained. The browser acceptance and full gate were rerun
after that correction. The reviewer did not independently repeat the browser
acceptance or full test suite.

The temporary browser and isolated server were closed. The pre-existing
port-8000 host and other browser sessions were not changed.

## Limits

The test uses actual browser touch dispatch and the real host Touch Punch
adapter, not a physical phone or the user's unknown client version. Prompt
text is entered through Playwright fill, not a particular mobile IME.
It proves the reproduced forwarding failure is repaired; it does not claim
all possible mobile-client issues are resolved. There are no UI layout changes.
