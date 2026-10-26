# Save Intent Repair Plan

Status: implementation and verification complete; delivery follows through the
scoped dev commit and remote SHA verification. Main is not included.

- [x] Inspect current checkout and user evidence; baseline498/498 tests pass.
- [x] Reproduce automatic host/history writes with no user editing.
- [x] Document root causes, compatibility constraints and explicit limitations.
- [x] Host capture boundary: focused failing cases, implementation, strict-import parity.
- [x] Pure target/scope/revision edit authorization and trusted host event adapter.
- [x] Replace ambient-event write permission; freeze accepted edits through debounce.
- [x] Correct completion, switching, retry, initialization and slow-write ownership.
- [x] Focused runtime/browser acceptance for manual, automatic, drag, edit, switch,
      ambient changes, failure recovery and teardown; no full-product review loop.
- [x] Complete tests, module/i18n check, all production syntax and whitespace check.
- [x] Update behavior documentation and targeted findings; prepare exact-path
      commit and verify remote divergence (0 ahead/0 behind before commit).

Delivery command sequence: inspect staged diff, commit, push dev, verify remote
SHA. Completion is reported only after that sequence succeeds.

Ownership: capture_boundary agent owns host capture/schema helpers and its new
tests/report. Root owns save authorization, state integration and shared fixture
updates. intent_audit owns the native edit adapter and its focused tests after
its initial read-only host-contract investigation.
Existing large auto-save module should lose DOM event interpretation rather
than gain another parallel collection of heuristic handlers.

Regression requirements: synthetic settings/prompt redraw/polling never write;
trusted parameter/prompt changes do; no-op clicks do not; background changes
during debounce/host save cannot cause a second write; newer real edits survive;
switch guards retain original target; manual capture keeps extensions; invalid
capture does not commit or overwrite data; slow writes retain ownership; disabled
and torn-down handlers cannot create work. Changed old tests must reflect the
explicit new source contract, not merely remove failure assertions.

The existing auto-save module remains above800 lines because it still owns
serialized save, restore, switch and deletion orchestration. This change removes
its DOM interpretation responsibility and hundreds of legacy observation lines;
moving unrelated transaction code is deliberately deferred.
