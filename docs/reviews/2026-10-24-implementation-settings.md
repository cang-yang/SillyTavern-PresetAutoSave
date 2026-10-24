# Settings And Panel Resource Ownership: 2026-10-24

## Design Supplement

Keep the existing settings validators, storage layout and equivalent-update
suppression. Public reads expose one deeply frozen snapshot cached until a
settings mutation, rather than a mutable reference into host storage or a deep
clone on every hot-path read. Listener notifications expose immutable detached
values. Nested defaults cannot be modified through exported references.

The settings tab controller owns every bound handler and delayed numeric write.
Rendering a replacement, resetting settings, or disposing its owning panel
cancels pending writes and removes handlers. `disposeSettingsMount(root)` accepts
either the settings surface or its owning panel. The panel coordinator invokes
it during teardown. Async destructive actions recheck controller lifetime after
confirmation and before starting work; committed persistence is not cancelled.

History import file pickers belong to their panel. Picker cancel and panel
disposal remove the input and invalidate late reads before preview/import starts.
The history-only clear action keeps manual groups, aliases, tree and defaults.
The unenforced capacity-threshold control is removed, but the stored setting is
retained for compatibility. No new strings or runtime dependencies are needed.

## Sequence And Evidence

1. Shared baseline: 341 tests passed before implementation began.
2. Add behavioral regressions for immutable reads, listener isolation,
   debounce/reset/disposal, cancellation and history-only scope.
3. Implement the smallest owning controller and update existing entry points.
4. Focused, full gate and browser verification recorded below as completed.

At initial focused baseline attempt, shared compatibility.js was undergoing a
parallel extraction and briefly contained a duplicate declaration. This is not
regression red evidence; repeat after the owner finishes.

Focused regression runs observed five expected failures for mutable public reads,
mutable listener payloads, reset timer overwrite, duplicate binding and uncancelled
picker input. The clear-history test then reproduced organization loss against the
actual history repository and controller (manual overrides became an empty object).
The corrected implementation preserves all organization values while clearing
history. Panel close also cancels pending numeric work and invalidates a pending
file read. The 18-test focused command covering settings, controller ownership,
history scope, aliases, import preview and bounded log rendering passes.
