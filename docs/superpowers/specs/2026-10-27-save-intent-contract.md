# Save Intent And Host Capture

## Evidence And Scope

The supplied log contains328 non-JSON capture failures on October26-27,26 older
switch convergence warnings,6 older timeout warnings and4 obsolete restore
ReferenceErrors. The current restore command no longer contains that obsolete
code. The screenshot shows extension changes but not their full paths; it does
not identify a particular extension or prove equal-length prompt text is equal.

A production-runtime probe reproduces a host write and history entry with zero
user input: mutate one extension flag and emit settings_updated.

Root causes:

- Observation of mutable host state is treated as permission to persist it.
- Whole-object fingerprint drift during persistence creates fresh automatic work.
- Live JavaScript state is confused with a strict persisted JSON document.
- A watchdog clears the busy flag while the serialized host write is unresolved.
- Switch verification requires complete live/stored equality, including runtime
  extension changes; timeout is not evidence of a user edit.

## Contract

1. Host capture owns conversion of absent JavaScript values to JSON-compatible
   data. External imports remain strict. Invalid owned values fail with safe
   path/type diagnostics; never fall back to an old stored preset on such errors.
2. Trusted native editing begins a target-bound, scope-bound observation.
   The before/after value in that scope must differ before it creates an
   immutable automatic save request. Merely opening an editor is not an edit.
3. Settings events, DOM rendering and polling may complete an existing editing
   observation, but cannot create permission, extend its lifetime or turn
   arbitrary live changes into automatic writes.
4. An accepted edit freezes the complete canonical payload. Later ambient
   changes do not replace its payload while debounce or persistence is pending.
   Valid extension data remains in snapshots; no field/name blacklist is added.
5. Completion acknowledges only the submitted edit revision. A later trusted
   edit remains pending; raw background drift never schedules another save.
6. Explicit manual snapshots, native save observations and restores retain
   full canonical data and their existing serialized write/recovery semantics.
7. Switch guards protect captured edits to their original target. Unverified
   switch observations neither seed history nor authorize writes.
8. A slow host write remains busy until it settles. The timeout reports a slow
   operation without releasing ownership or pretending cancellation succeeded.

## Limits And Non-goals

This cannot infer arbitrary third-party script intent from a shared mutable
object. Background-only script edits require an explicit manual snapshot/native
save or a future verified adapter. A real edit's full snapshot may also contain
extension state already present when it was captured; this is preservation,
not a claim of per-field authorship. No storage migration, historical deletion,
prompt blacklist, UI redesign, new dependency or full-product scoring loop.

Exact native editing coverage and asynchronous confirmation/drag behavior must
be exercised with runtime tests and the maintained browser harness. Unsupported
third-party controls must not silently acquire a broad save authorization.
