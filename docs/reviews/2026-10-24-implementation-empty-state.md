# Empty-State Readability

Blind review 4 found that the legacy empty-version ancestor opacity reduced
otherwise readable metadata to 4.254:1 in the light theme. Preserve the zero
history state, its explicit label and expandable hint; remove only the legacy
whole-header opacity and keep the feature layer responsible for readable text.
No data, identity, interaction routing or layout budget changes are intended.

## Red-Green Evidence

Before removing the rule, the new ancestor-composition regression in
`tests/panel-contrast.test.mjs` failed at 4.397:1 on its deterministic surface.
The actual browser audit at light 360x800 independently failed count and size
text at 4.253917:1. Removing the legacy 0.78 opacity made both pass.

Visual inspection of the empty-state screenshot exposed related status text
outside the existing metadata collection. The collector now also includes
`.pas-tag-empty` and `.pas-version-empty-hint`. Before the feature-style fix,
the expanded empty version produced four audit errors: 9px / 2.485:1 label and
11.44px / 2.472:1 hint. Scoped metadata color and 12px typography now cover both.
An initial rule was insufficient against legacy light-theme and compact tag
selectors; the final rule is scoped through the owning panel/version header.
No `!important` exception was introduced.

## Browser Evidence

Chromium, Playwright CLI session `refactor`, Windows, maintained harness with
production modules and a simulated host. After the ancestor fix, all five
scenarios (ordinary, empty, loading, error, performance) at four widths in both
themes passed: 40 audits, zero findings. Performance cases use the 500-snapshot,
46 MiB cold-catalog fixture.

After extending empty status-text coverage, all eight **expanded** empty cases
pass at 1280x900, 768x900, 390x844 and 360x800, dark and light.
Screenshots: `output/playwright/final-empty-{theme}-{width}.png`.
The light 360px state was visually inspected. Empty presets remain visible,
identified as having zero snapshots, and do not expose unavailable history
actions. The injected error scenario intentionally reports a synthetic storage
failure; ordinary/empty/performance pages have no unexpected console errors.

This implementation resolves the finding but does not replace the next
fresh-context independent review.

Final recheck after status-text changes: all 40 scenarios pass again, with the
empty scenario expanded in each of its eight cases. `npm test`: 465/465 pass.
`npm run check`, production/script syntax (87 files), and `git diff --check`
pass. Fifth independent review started on the frozen checkout.
