# Foundation Iteration Plan

- [x] Inspect status, rules, product/design documents and remote; baseline545/545.
- [x] Start isolated review using only checkout and repository rubric.
- [x] Reproduce and centralize recovery-safe retention across save/import/cleanup.
- [x] Reproduce lifecycle failed-stop retry and distinct-stop sequencing.
- [x] Check strict canonical/import property ownership and settings map identity.
- [x] Reproduce accepted-history-write teardown race and drain before shutdown.
- [x] Reproduce disable overwriting native content; recover only missing presets.
- [x] Add verified archive recovery; preserve conflicting/unverified backups.
- [x] Reject incomplete/malformed recovery result counts before destructive cleanup.
- [x] Remove full-preset captures from native quick-edit draft hot path.
- [x] Run focused red-green coverage for each changed boundary; full568/568 passes.
- [x] Run complete tests, module/i18n checks, production syntax and whitespace
  after the review-driven corrections:584/584;91 modules;577 i18n keys.
- [x] Browser acceptance and fresh isolated review of the resulting checkout:
  report13 passed, 93/94/92/90/92/90, mean91.8; no release blocker reproduced.
- [x] Resolve independently reproduced subgroup-label contrast failure, extend
  metadata audit coverage, and reverify both themes at all four viewports.
- [x] Record results and stage exact files, excluding unrelated user work.
- [x] Reproduce review-discovered null/undefined existence confusion and prove
  failed recovery cannot clear snapshots; make inventory authoritative.
- [x] Replace provider-enumerated credential filtering with shared semantic
  rules, prove canonical/host/import/export parity and preserve literal text.
- [x] Verify old derived summaries cannot leak credentials after payload filtering.

Root owns implementation. The independent reviewer does not implement changes
and receives no author summary or target score. Reports are evidence, not a
reason to initiate unrelated redesign.

Delivery procedure: commit the scoped checkout, push dev, and verify the remote
SHA before reporting completion. Never update main as part of this iteration.

Existing history-store is above800 lines: retention logic is moved into the
existing deterministic policy module; no extra store responsibility is added.
Changes to other oversized files must similarly reduce or preserve scope.
# Review Findings Resolved

- [x] Reproduce literal `__proto__` manual-group inline rename in the production
  browser controller before changing it; retain undo/redo and membership checks.
- [x] Extract alias/default/parent-map commands, replace controller dynamic writes
  and ignore inherited parent links; cover ordinary and prototype-shaped keys.
- [x] Add failing settings description/unit contrast coverage, then move those
  text roles to the readable theme surface and check all eight viewport/theme
  combinations including settings scrolling and keyboard focus.
