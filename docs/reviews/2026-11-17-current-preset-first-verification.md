# Current Preset First: Focused Verification

Scope: dropdown and history presentation order and opening focus. This is a focused regression review, not a blind product-wide scorecard.

## Root Causes and Fixes

- Dropdown opening explicitly focused the first/last visible row, regardless of active selection. Opening now chooses the active visible item or active containing header; normal arrow and Home/End navigation remains intact.
- Alphabetical/version/recency ordering did not prioritize the active target. A pure stable partition and copied-tree projection now prioritize the exact target, containing group, and ancestor path. Other ordering remains unchanged.
- Nested renderers always put parent-owned versions before children. The active child branch now precedes unrelated parent versions without changing canonical ownership.
- A switch updates active CSS before the delayed takeover refresh. A separately tracked rendered selection now forces ordering refresh on immediate reopening rather than trusting the newer CSS marker.

## Red-Green Evidence

- Baseline: 603 passing tests.
- Before implementation, three history ordering assertions and two dropdown opening-focus assertions failed. The new pure ordering module was absent. After implementation, all focused tests passed.
- Browser acceptance initially failed with `Reopening after a switch must immediately reprioritize the new current preset`. After tracking the rendered selection independently of active CSS, the same scenario passed.
- Final automated gate: `npm test` (610/610), `npm run check` (95 linked modules; 577 matching translation keys), `node --check` on all 95 production modules, and `git diff --check` passed. Only an existing user-owned `.gitignore` line-ending warning was reported by Git.

## Browser Evidence

Maintained production-panel harness, Chromium via Playwright CLI:

```text
npm run harness
playwright-cli -s=current-order open http://127.0.0.1:4173/tests/harness/ --headed
playwright-cli -s=current-order run-code --filename tests/harness/current-order-browser-check.mjs
```

- Viewports: 1280x900, 768x900, 390x844, 360x800; each in dark and light themes.
- All eight layout audits passed with zero errors and zero warnings in the final run. Captured console error arrays were empty.
- Each viewport/theme exercised three dropdown variants: flat groups, nested groups, and nested groups with default expansion (24 passing cases).
- Verified an older active version first, active ancestor/group first, active child before parent-owned presets, immediate switch/reopen ordering, native option identity/order unchanged, opening keyboard focus, Escape return, 44px visible touch targets, and no horizontal page overflow.
- History used an active native option other than the first one, verified current ancestor/path/version first, switched to flat view and back, and verified the current target remained first.
- Existing takeover acceptance scenarios also passed in flat and nested modes: selection, keyboard disclosure, Escape, renamed native options, exact names, teardown, and remount.
- Screenshots saved locally as `output/playwright/current-first-{theme}-{width}.png` and `current-first-dropdown-{theme}-{width}.png`. History screenshots at all eight combinations and representative compact dropdown screenshots were visually inspected.

## Invariant Review and Limits

Ordering produces fresh arrays/tree nodes. No native option mutation, history write, identity migration, alias change, nesting-edge change, new listener/timer, new dependency, or new translated copy is introduced. Exact history target matching includes the active API; dropdown priority derives from its own select. Filters retain membership authority.

No unresolved finding within this change's scope. Browser coverage is the maintained host harness, not a claim of execution on the user's physical phone or running TauriTavern instance.
