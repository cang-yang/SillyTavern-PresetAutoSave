# Compact Comparison Shelf And Command Names

## Design And Plan

Address blind review 3's active-comparison findings. At compact widths the A/B
shelf sits below the scrolling history. Search, view switches and filters remain
available throughout selection so choosing A never prevents finding another
preset for B. The original proposed toolbar replacement was rejected during
implementation because it obstructed that workflow. The bottom shelf keeps the
190px chrome budget. A/B occupy two short rows on the left; the visible labeled
launch action and clear control remain 44px targets on the right. Full selection
labels remain available as native titles. Larger widths keep the shelf above
history. The same DOM controls retain their listeners and stable selection keys.

All mini commands whose text may be hidden by legacy compact styles receive
translated explicit accessible names and titles, including batch selection and
log actions. The primary comparison-launch label remains visible at every width.
Do not change diff calculation, data persistence, selection identity or routing.

Add failing rendered shell tests, accessible-name audit cases and real browser
A/B selection evidence before product changes. Extend maintained acceptance to
select two real rendered snapshots and audit the active shelf, then keyboard
launch/close comparison at four widths in each theme. Check batch/log command
names, target dimensions, focus, overflow and restored toolbar state.

## Red-Green Evidence

- Before product edits, focused shell/audit tests: 29 passed, 2 failed. The
  shell lacked an explicit start name; the audit ignored glyph-only commands.
- Actual 360x800 light A/B selection produced five errors: unnamed launch,
  hidden launch label, launch 285x23px, clear 33x23px, history starting at 315px.
- Keyboard clear originally moved focus to the body. `updateDiffBar` now returns
  focus to search only when hiding a shelf that owned focus. A focused regression
  also checks that unrelated focus is not stolen and full labels remain literal.
- Batch acceptance exposed a 76px compact version header from a 44px checkbox
  occupying the title row. The checkbox now spans the header beside its text;
  both header and checkbox measure 44px. No target was reduced.

Chromium through playwright-cli, harness port 4173, Windows, four viewports
(1280x900, 768x900, 390x844, 360x800) in both themes:

- Eight actual A/B selections pass the enhanced layout audit with zero findings.
  The maintained `prepareComparisonSelection()` selects A, focuses search,
  searches for no results, searches the target preset again, confirms A survives,
  then selects B. This exercises real panel handlers and filtering.
- Compact history starts at 188px; launch and clear are 44px tall. Search,
  filters and view switches remain visible throughout the selection.
- Eight keyboard Enter launches open the actual diff popup; Escape closes it
  and returns focus to launch. Keyboard clear returns focus to search, preserves
  its query, and leaves no hidden focused control. Keyboard A/B rerenders retain
  their initiating control focus in every viewport/theme combination.
- Batch and log states pass all eight layout audits, including explicit names
  for select-all, deselect-all, clear-log, copy-log and export-log.
- Screenshots: `output/playwright/comparison-{dark,light}-{1280,768,390,360}.png`.
  Inspected the 360px light and 1280px dark selected states: no overlapping shelf,
  controls or text; history retains its own scroll region above the shelf.

No storage schema, selection identity, host persistence, diff computation or
translation key changes. No new runtime dependency.

Final local gate: `npm test` 464/464 passed; `npm run check` passed (85 native
module links, 573 matching translation keys); explicit production `node --check`
loop passed; `git diff --check` passed. Browser audits reported no console errors.
Files frozen for the independent review; no commit or push performed here.
