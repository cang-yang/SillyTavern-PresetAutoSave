# History Metadata Readability

## Design And Plan

Address blind review 2 P2 only: history counts, sizes and timestamps must remain
normal readable text in both themes and all required widths. Preserve the existing
row layout, controls, filtering and data contracts. Add a feature-owned metadata
color token and a 12px minimum size, without modifying legacy host-wide variables.

Extend the maintained browser audit beyond footer text. Collect visible series
and version metadata text leaves against the actual composited chain of computed
background colors and element/ancestor opacity. Unsupported exposed background
images fail measurement instead of inventing a passing contrast. Audit each text
sample for at least 4.5:1 and 12px; hidden nodes are excluded, icons are not normal
text samples. Test alpha blending and audit thresholds with deterministic cases.

Sequence: establish unit and browser red evidence, implement feature-scoped CSS,
rerun four widths in both themes, inspect screenshots, then full automated gate.

## Red-Green Evidence

The existing four token contrast tests passed before changes, demonstrating the
coverage gap. Two new layout-audit tests then failed: the audit accepted 9.88px
metadata at 2.52:1 and accepted unmeasurable contrast. Implementing per-sample
thresholds makes both pass. Three additional tests validate translucent text,
nested translucent backgrounds, subtree opacity, ancestor traversal, and failure
on exposed unsupported background images.

Before changing product CSS, Chromium session `pas-metadata` at light 360x800
reproduced actual series text at 9.88px and 2.516498:1, and version size text at
9.62px and 2.503227:1. The enhanced production-controller audit rejected them.
Expanded snapshot testing subsequently exposed the legacy hash opacity of .55:
contrast was 3.441042:1 dark and 2.567879:1 light. Removing that feature-scoped
opacity restores readable metadata rather than merely assigning a darker token.

The main feature layer now owns `--pas-v4-metadata-text`, 12px metadata typography
and full opacity for text. Series/version counts, sizes/timestamps and snapshot
time/size/hash are covered. The light current-row background uses a solid 7%
amber tint consistent with the dark implementation, replacing the gradient so
normal text has a predictable contrast background. No host-global tokens changed.

## Browser Matrix

Expanded first-version snapshots were inspected in the maintained harness:

| Theme | Width/height | Samples | Minimum px | Minimum contrast | Version header |
| --- | --- | ---: | ---: | ---: | ---: |
| Dark | 1280x900 | 48 | 12 | 7.4304:1 | 54px |
| Dark | 768x900 | 48 | 12 | 7.4304:1 | 52.67px |
| Dark | 390x844 | 39 | 12 | 8.0102:1 | 44px |
| Dark | 360x800 | 39 | 12 | 8.0102:1 | 44px |
| Light | 1280x900 | 48 | 12 | 7.3585:1 | 54px |
| Light | 768x900 | 48 | 12 | 7.3585:1 | 52.67px |
| Light | 390x844 | 39 | 12 | 7.3585:1 | 44px |
| Light | 360x800 | 39 | 12 | 7.3585:1 | 44px |

All eight audits pass with zero findings: overflow, touch targets, row bounds,
focus state, console errors and composited metadata text are included.
Screenshots: `output/playwright/metadata-{theme}-{width}.png`. Light 360 and dark
1280 screenshots were visually inspected for text fit, row layout and hierarchy.
This is a simulated SillyTavern host in real Chromium, not an installed-host test.

The coordinator separately added diff metadata/toolbar styling. At its request,
the shared collector also includes diff side time/extra and native diff command,
section and summary controls; its eight-case diff matrix passed the same audit.

Focused audit/compositor/token tests: 30/30 pass. Coordinator's fresh complete
gate at this checkpoint: 460/460 tests, import/link check and diff whitespace
check pass. This implementation does not replace the required independent review.
