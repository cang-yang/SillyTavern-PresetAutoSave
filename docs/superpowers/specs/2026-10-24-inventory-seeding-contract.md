# Inventory And Seeding Extraction

This supplements the authorized reliability/refactoring plan.

## Interfaces

- Host inventory returns immutable plain `{apiId,presetName,hostValue,detached}`
  records read from native options. Selection values remain separate from names.
- A deterministic seeding controller captures target and preset synchronously when
  requested, then serializes existence checks and writes. A supplied preset must
  be explicitly verified. Cancel/close rejects new work, prevents queued writes,
  and drains any already-started write before resolving.
- A runtime seeding service binds this controller to host capture, settings, and
  history storage. Lifecycle ownership belongs to the runtime, not the dropdown.
- Existing takeover exports remain temporary compatibility re-exports; autosave
  imports seeding directly so the save engine does not depend on dropdown UI.

## Compatibility

Preserve exact native option names, including numeric and whitespace-bearing
names; these are identities, not placeholders inferred by a heuristic.
Keep `(apiId,presetName)` keys. No schema,
history trigger, alias/tree, or dropdown renderer changes. Automatic bulk seeding
continues to respect enabled/grouping/first-scan settings. UI scheduling remains
unchanged. Batch targets are captured once, never rediscovered after an await.

## Tests And Acceptance

First reproduce mutation of an externally supplied seed payload while its history
read is pending. Verify capture ownership, duplicate seed serialization, stop
during read, stop during write, target/API switch, and restart semantics. Exercise
inventory text/value separation, multiple APIs, duplicate entries, disconnected
selects and empty/missing host DOM. Dropdown parity remains the browser gate.
