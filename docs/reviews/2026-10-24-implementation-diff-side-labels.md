# Prompt Diff Side And Change Labels

## Design And Plan

Review 7 identified a color-only distinction after the two-column prompt diff
stacks on compact screens. Every populated side cell will contain a real visible
label: `A - Removed`, `B + Added`, or `A/B = Unchanged`. These describe the selected
A-to-B comparison, not chronological old/new states. A localized accessible group
name also identifies side, line number, status and comparison direction.

One small renderer helper owns side labels, cell structure and empty content.
Alignment placeholders are explicitly hidden from assistive technology and may
collapse on compact screens. An actual blank content line remains a labeled
value with the existing no-content text, never an alignment placeholder.

Non-goals: no diff algorithm, canonicalization, storage, selection, chronology,
export, popup lifecycle or dependency changes. Preserve existing CSS hooks and
desktop alignment. Feature-scoped CSS belongs in styles/dialogs.css.

The real pointer swap check also exposed a legacy rotated decorative arrow with
a full-width grid box overlapping the toolbar. Constrain that decoration to
22px and disable pointer interception; no interaction or layout redesign.

Sequence: add failing markup and audit tests; capture the existing real compact
failure; implement helper and bilingual labels; run focused tests; exercise
reversed-date selections, swaps, whole-prompt additions/deletions, blank and
hostile content at four sizes in both themes; inspect screenshots; run full gate.

## Red-Green Record

- Baseline reported by independent review 7: 487 tests passed. New line-label
  regression: 4 failed as expected against the original renderer. New audit
  case: 1 failed / 23 passed because the audit accepted missing side labels.
- Enhanced browser audit before renderer/CSS edits: two
  `diff-side-label-missing` errors on actual B-revision-4/A-revision-5 content.
  Screenshot: `output/playwright/diff-side-labels-red-360.png`.
- Renderer helper now emits real text plus localized role/group names. Blank
  content is labeled `(no content)`; empty alignment placeholders are
  `aria-hidden`. HTML and translated labels remain escaped.
- New pointer-audit regression failed before audit implementation. Actual
  390px click timed out because the rotated arrow measured 22x359px and covered
  swap. After the scoped fix, pointer swap passes at every required size/theme.

## Browser Acceptance

Windows Chromium through installed playwright-cli, production-code harness on
port 4173, 1280x900 / 768x900 / 390x844 / 360x800, dark and light:

- `showDiffLabelScenario()` opens an explicit newer-A/older-B fixture. Before
  and after actual keyboard swap, all eight audits have zero findings. The
  fixture covers unchanged lines, replacement, whole additions/removals,
  unchanged whole prompt under show-all, blank values and hostile literal text.
- Swapping moves newer A content to B-added and older B content to A-removed,
  with metadata swapping identically. No timestamp sorting or old/new inference.
- Actual `prepareComparisonSelection()` plus keyboard launch, pointer swap and
  Escape: all eight before/after audits pass; focus returns to launch each time.
- English 360px in both themes also passes before/after pointer swap. The widest
  `A = Unchanged` label leaves at least 172px for content; no cell overflow.
- Labels measure 12px. Actual composited contrast is 8.23:1 dark and 6.99:1 light.
  Labels use a neutral opaque backing so gradient card decoration cannot make
  their contrast unknowable or inconsistent.
- Screenshots: `diff-side-labels-{theme}-{width}.png`,
  `diff-side-selected-{theme}-{width}.png`,
  `diff-side-labels-en-{theme}-360.png` in `output/playwright/`.
  Inspected dark 1280, light 360 and English light 360. Side/state is understandable
  without color; no overlapping labels/content; original desktop alignment held.
- Ordinary, empty, loading and storage-error fixture audits pass all 32
  viewport/theme combinations. No unexpected console errors; the fault fixture
  deliberately logs its injected storage failure.

Final gate: `npm test` 494/494 passed; `npm run check` passed with 86 native module
links and 577 matching translation keys; explicit production `node --check`
loop (index/modules/scripts) passed; `git diff --check` passed.
No staging, commit or push performed; files frozen for independent review.

The harness uses simulated host contracts, not a deployed SillyTavern instance.
Browser DOM/accessibility semantics and keyboard behavior were verified; no
screen-reader application was run.
