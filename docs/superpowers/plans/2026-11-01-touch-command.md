# Touch Command Implementation Plan

**Goal:** Preserve real mobile commands forwarded by the host touch adapter.
**Architecture:** A bounded gesture gate owns temporary document listeners and
one-use evidence. The preset observer still resolves actions, captures data and
submits scoped deltas through the existing writer.
**Tech Stack:** Browser ES modules, node:test, Playwright CLI, isolated real host.

## Constraints

Work on dev, preserve all user data and unrelated changes. No new main update
without authorization. No broad synthetic-event or ambient-write permission.

## Steps

- [x] Reproduce with `hasTouch: true`, `isMobile: true`, `locator.tap()`.
- [x] Run baseline `npm test`; add observer regressions and observe red.
- [x] Add `modules/host/touch-command-gate.js` exporting
  `createTouchCommandGate({documentObject, schedule, cancel})`.
  Its `begin(event, context)` stores a recognized command's identity;
  `consume(event)` returns context once for the matching forwarded click;
  `clear()` removes timers, listeners and evidence.
- [x] Integrate the gate in `modules/host/preset-edit-events.js`, checking
  current action and preset identity before creating a proposal.
- [x] Run `node --test tests/host-preset-edit-events.test.mjs` green.
- [x] Add/run `tests/harness/real-host-touch-autosave.mjs` against the isolated
  host for toggles, popup text submission and no-op/background exclusions.
  Independently inspect disk and reload state.
- [x] Run full verification, scoped independent review, and test-service cleanup.
- [ ] Commit only scoped files, push authorized dev and verify remote SHA.

## Regression Shape

```js
root.dispatch('touchstart', toggle, { touches: [point] });
documentObject.dispatch('touchend', toggle, { touches: [], changedTouches: [point] });
root.dispatch('click', toggle, { isTrusted: false });
state.preset.prompt_order[0].order[0].enabled = false;
tick();
assert.equal(edits.length, 1);
```

Repeat with cancel, movement or a different clicked target and require zero
edits; dispose and require zero owned timers/document listeners.
