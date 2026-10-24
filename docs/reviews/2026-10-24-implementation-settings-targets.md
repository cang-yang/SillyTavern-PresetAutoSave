# Settings Touch Targets

## Design And Plan

Review 8 identifies small switch hit areas and an audit that omits their effective
clickable labels. Add a feature-scoped settings style layer. Native checkbox
inputs and switch wrappers become 44x44px while the visual track remains 38x20px,
centered within that area. Toggle text remains beside the switch on compact
screens. Number/select fields and action buttons also receive 44px minimums.

The audit must enumerate all 21 settings controls, including associated labels,
names, descriptions and actual effective target dimensions, not only visible
native inputs. Browser acceptance scrolls every control into view, checks pointer
hit tests and keyboard focus, toggles by Space and target corners, and verifies
numeric/select operation. Reset and clear are exercised only through canceled
confirmations against the harness fixture. Reseed has no confirmation in the
existing controller, so verify its hit area, focus and name without invoking it.

Non-goals: no settings schema, defaults, persistence, controller, translation,
debounce or lifecycle changes; no broad legacy CSS migration. Preserve existing
hooks and host integration. No new dependency.

Sequence: failing audit/source tests, real browser red screenshot and metrics,
scoped CSS, focused green tests, eight viewport/theme settings matrices, screenshot
inspection, ordinary-surface regression checks and complete automated gate.

## Red-Green Evidence

Baseline review 8 ran 494 tests successfully. Three new settings-target tests
failed before implementation: the audit ignored undersized labels, omitted
field name/description checks, and the settings feature layer did not exist.
A fourth regression ensures dimensions from separate labels cannot be combined
into an imaginary 44px target.

The enhanced audit against original CSS at 360x800 light found 16 undersized
controls: all 13 switches plus reseed, reset and clear. The latter three also
failed the general control audit (19 errors total). Inputs measured 0x0, switch
labels 38x20, text labels about 17px tall, reseed 40x33, reset/clear about23px tall.
Screenshot: `output/playwright/settings-targets-red-360.png`.

The new stylesheet makes native input targets and switch wrappers 44x44 while
centering the unchanged 38x20 track. It adds visible focus outlines and 44px
minimum fields/actions. No production JavaScript or translation changed.

## Browser Acceptance

Windows Chromium using playwright-cli and the production-code harness at4173.
For each of 1280x900,768x900,390x844,360x800 in dark/light:

- All 21 controls have a qualifying44px target and meaningful names; all18
  settings fields resolve their associated descriptions.
- Scrolled each of13 switches into view, clicked all four inset target corners,
  and used Space twice. Every change was observed and original values restored:
  416 pointer-corner activations and208 Space activations across the matrix.
- Every switch showed a2px visible track focus outline. Switch wrappers stayed
 44x44, with38x20 tracks. Text and switches remain side by side on compact screens.
- Canceled reset and clear via their actual buttons: two confirmation calls per
  case; complete settings values and snapshot IDs unchanged afterward.
- Reseed was measured and keyboard-focused without invoking its existing
  non-confirmed storage operation. This is intentionally not a reseed behavior
  regression test.

Screenshots `settings-targets-{theme}-{width}.png` in `output/playwright/`.
Inspected360light and1280dark: no text/control overlap or horizontal overflow;
the settings surface remains its own scroll region.

## Focused Closeout

The root implementer independently reran all eight settings viewport/theme
cases on the final checkout. All21 controls passed size, center hit testing and
focus checks; each layout audit had zero findings. Screenshots:
`output/playwright/closeout-settings-{theme}-{width}.png`; the360px light
capture was inspected directly.

At360px light, all four number settings were changed by their allowed step,
committed with Tab, observed through the real settings store, and restored.
The grouping-expansion select was changed and restored through the same store.
All five update/restore checks passed; complete settings and snapshot IDs
matched the initial state afterward. No console errors were recorded.

Complete tests:498/498 pass. Module check:86 production modules,577 matching
English/Chinese keys, no dependency cycles. The user's latest instruction
requests this focused acceptance rather than another full-product blind review.
