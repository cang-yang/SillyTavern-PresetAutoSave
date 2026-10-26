# Scoped Host Editing Events

## Boundary

`modules/host/preset-edit-events.js` implements
`observePresetEdits({capture,onEdit,onError,documentObject,schedule,cancel})`.
It emits immutable target/before/after/scope/source records only after a trusted
host editing event produces a change in its declared scope. The pure
`core/edit-intent.js` verifies the scope again before granting a request.

`flush()` only services existing event-turn proposals. Ambient settings
notifications, DOM mutations and polling cannot mint or extend permission.
The dedicated `flush({beforeSwitch:target})` path synchronously finishes only
that old target's pending proposals using `capture(targetOverride)`. Its caller
must prove that the selected UI has advanced but host live memory is still the
old preset; it is not available as an ambient reattribution mechanism.
`dispose()` cancels proposals, confirmation/drag ownership, timers, observers,
native listeners and optional existing-host jQuery sortable listeners.

The body observer is a capability-binding observer, not a save observer. It
filters added/removed subtrees for known roots before rebinding; input listeners
live on narrow preset roots and the PromptManager popup. Document pointer/touch
listeners exist only during an active trusted drag.

## Host Contract Checks

The official release `public/scripts/PromptManager.js`, `openai.js`,
`textgen-settings.js`, `kai-settings.js`, and local `preset_code_lite.md` were
inspected. No host module is imported at runtime and no dependency is added.

- OpenAI native field IDs use the shared canonical fields/synonyms, including
  counter forms and known prefix/suffix variants.
- Other APIs match native IDs to existing canonical scalar fields. Textgen and
  Novel suffixes and Novel's documented sampling aliases are explicit.
- Range controls retain only their trusted gesture/first-input baseline and
  capture the final value at change/release. A500,000-character fixture with20
  input ticks performs two captures and emits one edit. Keyboard input/change
  is supported; text edits carry `control-text` for the engine's text debounce.
  `rangeReleaseOnly()` defaults true; the existing sliderReleaseSave=false
  setting opts into scoped input proposals before release instead.
- Quick edit IDs end in `_prompt_quick_edit_textarea`; trusted blur captures the
  actual host commit, not just a textarea's local typing state.
- Popup save/reset scope the affected prompt identifier. Merely opening an
  editor, creating an unsubmitted draft, selecting a footer option or exporting
  grants nothing.
- Toggle/detach/append scope the selected identifier's order entries.
- Delete/reset-order await a newly opened unique confirmation dialog and its
  final trusted affirmative action. Cancellation, close, Escape, ambiguity,
  target change and timeout invalidate ownership.
- jQuery UI `sortupdate` requires a preceding trusted pointer/touch gesture,
  actual movement and completion, plus a real order difference. Scroll-like
  movement alone grants nothing. The marker can arrive after pointerup in the
  same task; the completion check runs in the next task.

## Red-Green Evidence

Initial no-op adapter: six of eight behavior tests failed with expected missing
edit emissions (not an import/setup failure). The implemented adapter passed.
Further failing regressions were run and then fixed for native counter aliases,
real quick-edit IDs, non-OpenAI scalar IDs, scroll movement without sortupdate,
ambiguous dialog reassignment, and popup reset.

Final focused command:
`node --test tests/host-preset-edit-events.test.mjs` passes20/20.
`node --check modules/host/preset-edit-events.js` passes.
Tests also cover synthetic events, unknown/connection controls, passive flush,
capture failures followed by recovery, dynamic root replacement, target switch,
touch cancellation and idempotent teardown.
The same-turn edit followed by native preset selection was separately red-green:
the dedicated old-live flush preserves the editing request before target change.
Range batching was red with20 interim emissions and became green with zero
interim emissions, two total captures and one final scoped edit.
The disabled release-only branch was separately red with zero early edits;
after implementation a trusted input emits one edit before change as requested.

## Explicit Limits

The host's prompt-list import creates a detached file input and performs
FileReader work asynchronously. The initial import click is not treated as
permission for arbitrary later mutations. Without a reliable host semantic
completion hook this path needs an explicit manual snapshot. Legacy hidden
dialog reuse is not the verified native-dialog confirmation path.

The Context API does not expose PromptManager. Its delete/reset/import handlers
do not return their actual asynchronous confirmation completion; wrapping
`await handleDeletePrompt()` would incorrectly appear complete immediately.
The adapter therefore does not patch private host methods or global dialogs.

Unique-new-dialog association is an observable UI association, not cryptographic
provenance. A third-party script replacing the expected dialog with a different
one in the same event cannot be identified with certainty from DOM alone.
Likewise, a background mutation inside the exact same scoped field during a
trusted event cannot be distinguished from the user's edit. Full canonical
payload preservation remains separate from the trigger decision.
