# Intercepted Preset Commands Implementation Plan

**Goal:** Preserve autosave when a coinstalled extension consumes native
preset commands at document capture.

**Architecture:** A filtered window click gateway feeds the existing
observePresetEdits state machine; persistence remains unchanged.

**Tech Stack:** Browser events, ES modules, node:test, actual Tauri WebView2.

## Constraints

Use dev, preserve unrelated dirty files, no main update. No runtime dependency,
schema migration, broad input listener, or ambient save permission.

## Steps

- [x] Back up real application presets/settings/IndexedDB and reproduce a
  trusted toggle changing live order while recognized edits/saves remain zero.
- [x] Run baseline `npm test`: 592 passed.
- [x] Extend `tests/host-preset-edit-events.test.mjs` fixture with capture-path
  propagation, a window EventTarget and an earlier document interceptor.
  Assert one edit for toggle and Save, no duplicates when propagation continues,
  no ambient/untrusted/out-of-root authorization, and complete disposal.
- [x] Run `node --test tests/host-preset-edit-events.test.mjs`; observe the new
  intercepted-command tests failing with zero edits.
- [x] In `modules/host/preset-edit-events.js`, bind a window capture click
  gateway that requires root membership and promptAction, delegates to handle,
  and unregisters on dispose. Do not move input/touch-start listeners.
- [x] Re-run focused tests then install the scoped file in the backed-up local
  plugin for actual application testing. Reload and operate only the QA preset.
- [x] Add a red-green keyboard forwarding case after real-host Enter reproduced
  a second failure. Implement `modules/host/keyboard-command-gate.js`, using
  focused trusted activation and a consumed same-task token. Keep the existing
  touch gate and canonical action/target checks.
- [x] Verify toggle and text commits, stored file and history, no ambient saves,
  touch/keyboard behavior and reload persistence in the actual application.
- [x] Run `npm test`, `npm run check`, syntax checks for every tracked production
  JS/MJS file, and `git diff --check`; obtain one narrowly scoped review.
- [x] Restore original selection, detach diagnostics, document results and
  limitations; commit exact files, push dev and verify remote SHA.
