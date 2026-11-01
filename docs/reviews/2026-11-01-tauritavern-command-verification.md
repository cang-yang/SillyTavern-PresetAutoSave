# Actual TauriTavern Command Verification

## Environment and Root Cause

- Windows desktop TauriTavern 2.4.0 main fff9af0333be, existing user profile.
- Installed PresetAutoSave dev 8f419ea matched the repository before changes
  (only checkout line endings differed).
- ST-BaiBai-Tools 1.1.5 remained enabled throughout.
- Attached Playwright to the actual WebView2, not a standalone SillyTavern
  server or recreated DOM. Backed up presets, settings, extension and WebView
  storage before testing. Only a disposable PAS-QA-* preset was edited.

Before the fix, a real mouse toggle changed live prompt_order while the
plugin recorded zero DOM edits and zero saves. A temporary propagation probe
showed window click capture, then document stopPropagation and
stopImmediatePropagation from BaiBai's r7 handler. Its i7 handler similarly
consumes prompt Save. This explains both missing actions and missing logs.

Keyboard testing exposed TauriTavern scripts/legacy-controls.js translating
trusted Enter keydown and Space keyup to synchronous element.click(). Those
untrusted forwarded clicks needed focused, task-bounded keyboard evidence,
not removal of the trusted-input requirement.

## Red-Green Evidence

- Baseline `npm test`: 592 passed.
- Document-interception regressions before gateway: 29 passed, 2 failed,
  with expected edit count 1 and actual 0.
- After command gateway: 31 passed.
- Keyboard regression before keyboard gate: 32 passed, 1 failed, expected
  Enter edit count 1 and actual 0.
- Final focused adapter suite: 33 passed.

## Actual-Host Acceptance

Command:

```text
playwright-cli -s=tauri-live run-code --filename=tests/harness/tauritavern-command-acceptance.mjs
```

All six cases verified an increased completed-save count and matching
`saveStatus=committed`, `trigger=auto` history content:

| Operation | Result |
| --- | --- |
| Mouse toggle | Passed |
| Enter activation | Passed |
| Space activation | Passed |
| Touch toggle, 390x844 | Passed |
| Touch toggle, 360x800 | Passed |
| Touch editor submission | Passed |

Opening the editor, submitting unchanged text, and 20 ambient
SETTINGS_UPDATED notifications produced zero additional saves.
The JSON preset file on disk contained both the expected toggle and unique
test text. Reloading the actual app retained the text, toggle and committed
history content. A local screenshot captured the expanded automatic history
record; user data/screenshots/backups are not committed.

The initial acceptance attempt returned to an already persisted state after
an earlier failed keyboard experiment and correctly deduplicated it. After
that state converged, the full six-case sequence passed. This was not counted
as a successful commit.

Original preset files: 58 checked against backup, zero differences.
The disposable preset and its three unpinned test snapshots were removed
after verification; original preset selection was restored. Backups retained.
Final cleanup found host-added compatibility fields in two original files
after switching presets (plus BaiBai metadata in one). Their prompt content
and order were unchanged. The post-test versions were backed up separately,
the two original files restored, and all 58 original file hashes verified
against the initial backup again.

Production fix pushed and remote-verified as dev 5c711e3. The installed
extension was fast-forwarded to that commit with a clean worktree, rather
than left with experimental file replacements. The application was restarted
without the temporary debugging arguments and port 9227 was confirmed closed.

## Verification and Review

- `npm test`: 597 passed, 0 failed.
- `npm run check`: passed, 94 production modules linked, 577 matching i18n keys.
- `node --check`: all selected production JS/MJS files passed.
- `git diff --check`: passed.
- Independent narrowly scoped reviewer: no actionable findings, focused
  tests and syntax checks independently passed. No broad product score claimed.

## Limits and Preexisting Errors

This is real desktop TauriTavern with Chromium touch emulation, not an Android
device execution. Existing host/third-party errors include duplicate SPreset
declarations, a plugin client endpoint returning HTML, and tokenizer fallback.
No claim is made that every error in this user profile is fixed.

The fix does not authorize arbitrary script mutation or unknown editor
commands, and cannot guarantee observation before an earlier window-level
stopImmediatePropagation handler. The existing canonical history, transaction
format, single writer and ambient-noise restrictions remain unchanged.
