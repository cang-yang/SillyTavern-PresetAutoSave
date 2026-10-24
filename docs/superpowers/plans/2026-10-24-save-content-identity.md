# Exact Save Content Identity Implementation

1. Run the existing save-completion and switch-convergence focused baseline.
2. Add an integration regression using the actual colliding OpenAI presets:
   initialize on the first, edit to the second, require host and history writes.
   Observe failure before implementation.
3. Cover post-commit baseline changes, completion without a raw fingerprint,
   and switch verification/stability under equal hashes.
4. Add exact canonical baseline state in the existing save orchestrator and
   capture canonical serialization before requests enter the writer.
5. Update deterministic completion/convergence contracts and all hash-only
   unchanged guards. Preserve hash metadata and immutable captured values.
6. Run focused tests, full npm test/check, production syntax, and diff checks.
7. Record red-green evidence and limitations, then return ownership to root.

The oversized legacy auto-save module is touched only to replace an existing
equality invariant across its current lifecycle. No new orchestration
responsibility or UI dependency is added.
