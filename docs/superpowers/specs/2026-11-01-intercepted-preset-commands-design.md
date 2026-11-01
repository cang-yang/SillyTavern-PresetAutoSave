# Intercepted Preset Commands

## Evidence and Scope

Actual TauriTavern 2.4.0 (fff9af0333be), PresetAutoSave dev
8f419ea, ST-BaiBai-Tools 1.1.5: a trusted toggle click reaches window
capture, then BaiBai's document capture handler calls stopPropagation and
stopImmediatePropagation, mutates prompt order, and never reaches the
plugin's bounded root listener. The same extension intercepts prompt Save.
The installed plugin matches dev; this is not a branch or mobile-only issue.

## Decision

Add a window capture gateway for recognized prompt command clicks only.
Filter by existing preset root and promptAction before invoking the existing
observer. Keep normal typing, sliders, drag, and touch-start listeners bounded
to their roots. The same Event is handled once by the existing WeakSet.
Trusted clicks and proven same-gesture forwarded touch clicks retain their
existing validation. The gateway observes; it never prevents propagation,
rewrites another extension, or calls its private functions.

Window capture precedes document capture irrespective of registration order.
A document listener is insufficient; broad SETTINGS_UPDATED authorization or
polling would reintroduce ambient saves. A BaiBai-specific monkey patch would
couple persistence to private minified functions and is rejected.

Real-host keyboard acceptance also exposed TauriTavern legacy-controls.js
forwarding trusted Enter keydown / Space keyup through element.click().
A small keyboard-command gate accepts only that synchronous, focused,
unmodified activation of a recognized command; the permission expires at the
next task and is consumed once. Keyboard capture filters to known commands;
typing remains bounded. Switch, root removal and disposal clear this evidence.

## Invariants and Limits

- No storage/schema/canonicalization/write-path changes.
- No new package, build step, telemetry, UI or translation.
- No global input listener or snapshot capture for unrelated clicks.
- Root membership, recognized scope, trusted intent and actual scoped change
  are all required; ambient notifications still grant no authority.
- Dispose removes gateway, root listeners, timers and touch evidence.
- This does not promise support for arbitrary editors/private commands or
  earlier window-level stopImmediatePropagation interceptors.
- User preset data remains untouched; real-host tests use a disposable copy
  with backups and restore the original selected preset.

## Acceptance

Reproduce red then green for a document interceptor registered before the
observer: toggle and popup Save each create one scoped edit. Unchanged,
untrusted, out-of-root and ambient changes create none. Touch forwarding
retains the existing gesture restrictions. Verify actual TauriTavern mouse,
keyboard and emulated touch actions, committed history and the saved preset
file, plus unchanged/background activity and reload persistence.
