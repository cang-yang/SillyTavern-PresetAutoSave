# Host Accessor Capture Plan

- [x] Inspect capture, strict schema, switch candidate and edit observer call sites.
- [x] Baseline: npm test, 597 passed.
- [x] Add compatibility regressions for root getters, receiver/read count,
  exclusions, failures, isolation and unchanged strict document validation.
- [x] Add real engine regression for automatic writes/history and switch
  convergence using getter-backed live settings. Observe expected failures.
- [x] Materialize admitted root getters only in captureHostPreset and re-run
  focused tests; keep nested data and all persisted JSON strict.
- [x] Run npm test, npm run check, production syntax checks and git diff --check.
- [x] Review scoped diff and document verification evidence.

Delivery: commit only the six scoped files, push dev, verify the remote SHA,
and fast-forward the clean installed extension checkout. Report the delivery
commit in the user-facing result; do not modify main or user preset data.
