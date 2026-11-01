# Touch-Forwarded Preset Commands

## Confirmed Failure

Real SillyTavern 1.18.0 (51ad27fb8), current extension f97f518, Chromium
context `isMobile: true, hasTouch: true`, 390x844, actual `locator.tap()`:
the disabled/enabled state changes and SETTINGS_UPDATED increments, but
accepted edits and saved counts remain zero. The command click is untrusted.

The host's bundled jQuery UI Touch Punch converts touchend into a synchronous
synthetic click on sortable prompt rows. The observer rejects every untrusted
event before looking at its origin. Desktop click/viewport-only tests miss
this path. The user's mobile log matches this failure, although their specific
client version is not available.

## Decision

Keep trusted-event gating for ordinary input and arbitrary script events.
Introduce a bounded touch-click gate in the host adapter: a trusted single
touch on a recognized command can authorize exactly one forwarded click on
the same DOM target during the matching touchend task. Reject movement,
cancellation, multitouch, target replacement, delayed replay and changed
preset/action identity. A touch alone never creates an editing proposal.
The existing scope-delta comparison and serialized writer remain authoritative.

Alternatives rejected: allowing all synthetic clicks reintroduces script-driven
false saves; treating every touchstart as an edit grants intent to scrolling
and abandoned gestures; global settings-change saving loses user provenance.

No storage migration, data deletion, new dependency, logger policy change or
UI redesign. This fixes the reproduced touch-forwarding boundary, not every
unknown client issue. Native text input and popup commit require real-touch
acceptance alongside toggles.

## Verification

Red-green observer tests plus actual Touch Punch browser replay must pass.
Tests cover synthetic-only clicks, one-shot use, no mutation, movement, cancel,
multitouch, different targets/actions/presets, expiration and teardown.
Real-host acceptance checks save response, history, independent disk readback,
reload and background-noise exclusion. Preserve unrelated workspace files.
