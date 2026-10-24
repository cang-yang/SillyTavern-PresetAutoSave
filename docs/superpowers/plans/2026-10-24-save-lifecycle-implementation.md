# Save And Lifecycle Batch Plan

This is the concrete ownership supplement to the accepted reliability plan.
No storage schema, framework, network dependency or preset identity changes.

1. Reproduce old-save completion and disable-during-init races in executable host
   mocks; introduce completion and runtime-generation helpers; retain the writer.
2. Introduce restore as an immutable explicit writer barrier, replace the timed
   restore protocol through root-owned panel actions, and test partial outcomes.
3. Make save status observable independently of UI injection; preserve partial
   state and test subscription teardown.
4. Capture native preset inventory in a host adapter; extract serialized initial
   snapshot capture and cancellation; wire runtime shutdown before recovery.
5. Replace sampled dropdown fingerprints and duplicated delegation. Add real
   keyboard focus, group disclosures, exact name identity and lifecycle tests.
6. Move native fetch observation to the host seam. Test failure isolation, request
   epoch capture, stale click rejection and teardown.
7. Add serialized deletion with target protection, queued save cancellation, retry
   invalidation, seeding drain and an afterDelete cleanup callback under the same
   barrier. Root adapts the deletion domain command and UI.
8. Run focused tests, mounted flat/nested browser matrix and complete repository
   gates. Root owns remaining touch CSS, final independent review and scoped git
   operations; implementation agents do not commit or push.

Completed behavior and red-green observations are recorded in
`docs/reviews/2026-10-24-implementation-save-lifecycle.md`.
