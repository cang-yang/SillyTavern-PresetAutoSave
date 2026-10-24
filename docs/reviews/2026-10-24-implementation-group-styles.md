# Group Manager Style Ownership: 2026-10-24

## Design Supplement

Move the existing group-manager feature blocks out of the legacy stylesheet
without changing their relative cascade. Shared host tokens and popup adapters
remain in the legacy compatibility layer. The extracted feature layer initially
exceeds 600 lines because it preserves the existing foundation, light-theme,
modern workspace and nested-group rules together; splitting these by line count
would obscure the cascade being verified. This is a feature ownership extraction,
not a visual rewrite. Subsequent consolidation must be supported by computed-style
and interaction evidence.

The intentional behavior changes are native move-destination button resets,
44px compact preset-menu targets, explicit focus outlines, restrained accent
ownership for detached menus, and an unavailable-history label. Preserve existing
hooks and data attributes. Remove only obsolete group-manager selectors with no
production markup references. Do not change the host's close button adapters,
history/diff/batch layers or user-untracked browser scripts.

## Sequence And Acceptance

1. Assert the group feature layer is imported and active rules are absent from
   legacy style.css; observe failure before moving rules.
2. Mechanically relocate exact feature sections in original cascade order.
3. Add narrowly scoped interaction fixes and update markup-contract fixtures to
   consume the production feature layer.
4. Exercise native dialog menu ownership, keyboard dismissal, move destinations,
   and dark/light 1280x900, 768x900, 390x844, 360x800 layouts in a separate browser.
5. Run focused tests and report browser limitations without overstating coverage.

## Verification

The ownership test failed on the missing feature import before extraction and
passes afterward. Fifteen focused group-controller/style contract tests pass.
`npm run check` passes with 83 production modules and 573 matching i18n keys at
this checkpoint. The shared full suite was 427/428 during another owner's active
diff-popup lifecycle red-green work; no grouping/settings failure occurred.

Chromium Playwright CLI session `pas-group-css` exercised the maintained harness
at dark/light 1280x900, 768x900, 390x844 and 360x800. All eight layout audits passed,
with no page overflow or console errors. At 390/360 every visible preset menu
target measures 44x44. Screenshots are in `output/playwright/group-{theme}-{width}.png`;
360 light and 1280 dark were visually inspected. The supplied scenario value
`nested` normalizes to the ordinary fixture, which itself includes nested groups
and hostile long mixed-language names.

A real `dialog.showModal()` wrapper around the production mounted group manager
verified menu parent ownership, actual item focus, elementFromPoint hit-testing,
Escape dismissal, trigger focus restoration, and the native dialog remaining
open. All six checks passed. This verifies native-modal behavior, not an installed
SillyTavern host version. Existing harness menu navigation also passed all seven
checks (semantic open, arrows, Escape, Tab, outside click, action, disposal).

The real move dialog also exposed a native BUTTON measuring 44px high, accepted
keyboard focus, completed its move on Enter and closed without console errors.
