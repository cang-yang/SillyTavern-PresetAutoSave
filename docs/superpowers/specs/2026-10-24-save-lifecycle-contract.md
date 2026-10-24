# Save And Lifecycle Contract Supplement

Status: implementing the user-authorized reliability proposal.

## Save Completion

A request owns its canonical payload, target, content hash, raw quick fingerprint
(when captured from the active target), and user-mutation generation before it
enters asynchronous persistence. Completion may advance the committed hash but
must not adopt an unrelated live fingerprint. A newer mutation or queued revision
keeps the current target pending. Observer notifications are secondary to the
transaction result.

## Explicit Restore

`restoreSnapshotDetailed({ apiId, presetName, preset })` returns a detailed
coordinator outcome: committed, unchanged, partial, failed, cancelled, unavailable.
It works with automatic saving disabled when the runtime itself is initialized.
The caller owns scope confirmation and revalidation after the confirmation.

Restore captures the payload before awaiting. It cancels the debounce and queued
automatic/retry requests for its target, preserves the active write and other
targets, and enters the same coordinator as a non-coalescible command barrier.
Later coalescible requests cannot replace it or coalesce across it. It writes the
host preset with UI update, synchronizes host memory, then commits restore history.
The gate suppresses host-generated mutation events until the command finishes.
Restore failure is not automatically replayed: a delayed retry must not overwrite
newer user intent. History failure after host persistence remains partial.

The previous standalone atomic-restore timer interface is removed once its only
UI caller adopts this command. There is no timer that silently releases an active
restore after a fixed delay.

## Lifecycle

A small controller serializes enable and stop operations. Stop immediately
invalidates the current initialization generation, then waits for any already
started asynchronous phase to settle before cleanup and recovery. Every phase
boundary checks the generation; an invalidated start cannot begin another phase.
An enable requested during stop starts only after stop has completed.

Because host/storage operations are not cancellable, resources acquired by an
already-running phase can briefly exist while stop is pending. Stop does not
resolve until they have been cleaned up. No abandoned initialization may create
resources after stop resolves. Duplicate enable requests share readiness work.
Failed initialization cleans up acquired runtime resources and can be retried.

## Compatibility And Non-Goals

No storage schema, canonical target, history format, or host preset name changes.
Keep SaveCoordinator and transaction primitives; do not create a parallel writer.
No UI redesign, runtime dependencies, network traffic, or broad module rewrite.
The oversized autosave module loses its standalone restore protocol while the new
lifecycle state machine lives in core, keeping responsibility changes bounded.

## Verification Plan

1. Run existing save/lifecycle tests.
2. Add executable production-module tests for in-flight new edits and stop during
   archive initialization; observe red before changing production.
3. Add coordinator barrier tests and restore serialization/partial tests.
4. Implement immutable completion, command barriers, and lifecycle serialization.
5. Run focused tests, then repository verification and record results separately.
# Serialized Deletion Supplement

`deleteHostPresetDetailed({apiId,presetName})` requires an initialized runtime,
but not enabled automatic saving. It protects the selected/tracked target,
captures immutable identity, invalidates retries, cancels queued target writes,
and submits a non-coalescible deletion on the same writer. Initial-history
seeding for the target is stopped and drained before host deletion.

Only a true host delete result returns `committed` with `deleted:true`. The optional
`{afterDelete}` callback runs recovery-aware history/archive cleanup inside the
same writer barrier before it is released. A cleanup exception returns `partial`
and `deleted:true`, preserving its original error. A failed/protected host delete
releases the target block. Successful deletion blocks stale writes until a new
explicit native save for the selected recreated target starts after the deletion
epoch. The host observer captures that epoch before awaiting fetch, so a late
pre-deletion response cannot remove the block.
