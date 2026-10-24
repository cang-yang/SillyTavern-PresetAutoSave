# Optimization Delivery Traceability

Date: 2026-10-24. This is the implementer's completion audit, not an independent
scorecard. Original findings and red probes remain historical evidence; their
statements about the original checkout are not current release status.

## Original Findings

| Finding | Implemented boundary | Executable acceptance evidence |
| --- | --- | --- |
| A01 save completion swallowing newer edits | Captured request completion and mutation generation | `tests/integration/save-completion-runtime.test.mjs` |
| A02 strict archive enumeration swallowing failures | Strict archive reads fail closed | `tests/archive-store.test.mjs` |
| A03 legitimate base names omitted from recovery | Stable-target snapshot writeback, no name heuristic | `tests/snapshot-writeback.test.mjs` |
| A04 restore racing active writes / false success | Shared save coordinator and detailed restore outcome | `tests/integration/restore-runtime.test.mjs` |
| A05 initialization surviving disable | Runtime lifecycle generation and owner teardown | `tests/core/runtime-lifecycle.test.mjs`, `tests/integration/lifecycle-stop-runtime.test.mjs` |
| A06 aliases changing group membership | Canonical group membership commands | `tests/core/group-membership.test.mjs`, `tests/grouping-canonical-projection.test.mjs` |
| A07 label collision merging group identity | Canonical projection keys, independent labels | `tests/grouping-canonical-projection.test.mjs` |
| A08 genuine differences reported unchanged | Shared canonical comparison and generic fallback | `tests/diff-semantic-coverage.test.mjs`, `tests/core/preset-contract-parity.test.mjs` |
| A09 menus outside native modal | Menu owner root inside mounted dialog | `tests/context-menu-owner.test.mjs`, browser group-manager report |
| A10 late migration resurrecting deletion | Serialized repository mutation and migration | `tests/core/history-repository.test.mjs` |
| A11 imported duplicate global IDs | Whole-plan ID ownership validation | `tests/core/history-backup.test.mjs` |
| A12 orphan history displayed under another target | Stable history group projection | `tests/core/history-group-projection.test.mjs` |
| A13 keyboard-inaccessible move/diff controls | Native controls, focus and resource ownership | Browser group-manager and integration reports |
| A14 expansion keys disagreeing with render keys | Shared series/expansion projection | `tests/group-expansion-projection.test.mjs` |
| A15 destructive rollback under persistent failure | Durable verified before-image journal | `tests/core/history-import-recovery.test.mjs` |
| A16 catalog clone/materialization amplification | Cheap state reads and generation-bound summary index | `tests/core/history-catalog.test.mjs`, `tests/benchmarks/history-catalog.mjs` |
| A17 source-only integration coverage | Runtime host fixture, barriers, native dialog harness | Runtime integration suites and `tests/harness/app.mjs` |
| R01 failed host deletion losing history | Shared immutable deletion command and writer barrier | `tests/integration/preset-deletion.test.mjs`, `tests/integration/delete-writer-runtime.test.mjs` |
| R02 capture/export canonical disagreement | Shared schema for capture, history, backup and export | `tests/core/preset-contract-parity.test.mjs` |
| R03 prior save/recovery risks | A01-A05, A10-A11 above | Same executable scenarios, not a separate rewrite |
| R04 name-only batch selection | Captured API/name targets and API-switch reset | Harness `exerciseBatchTargets`, deletion suites |
| R05 contradictory summaries | Shared semantic changes including all order groups | `tests/core/preset-contract-parity.test.mjs`, `tests/summary-readability.test.mjs` |
| R06 timers and event-source ownership | Mounted settings resources, captured emitter, logger cancellation | `tests/settings-controller-ownership.test.mjs`, `tests/host-event-ownership.test.mjs`, `tests/logger-lifecycle.test.mjs` |

## Additional Scope

- Inventory and history seeding no longer depend on the dropdown controller.
  Runtime seeding tests verify captured input and cancellation boundaries.
- Dropdown fingerprint checks all options; shared keyboard ownership is covered
  by controller, fingerprint and style tests plus the browser matrix.
- Settings expose cloned/frozen values and suppress equivalent writes. Clearing
  history preserves organization. The unenforced capacity setting is no longer
  presented as an active safety guarantee.
- Snapshot, import and diff popups own their pending work and listeners;
  reopening cannot bind another popup or use a closed viewer's payload.
- Group-manager styles moved to a feature layer with verified cascade and
  native-modal/compact interaction evidence. Legacy hooks remain where used.
- Logger restores bounded validated records; disabled debug mutation commands
  cannot bypass runtime state.
- Module verification uses native parse/link with negative fixtures for missing
  imports and exports. No runtime package, framework, network dependency,
  telemetry or storage-format replacement was added.
- README and usage/install docs describe actual host writes, partial outcomes
  and safe export scope without promising untested compatibility.

## Independent Review Corrections

Reviews 2-4 identified nested connection fields, low-contrast metadata and the
selected comparison shelf. Red-green tests and browser matrices are recorded in
the data, metadata-contrast, comparison-shelf and empty-state reports.

Review 5 identified imported hash trust. Exact canonical history comparison now
passes five new runtime cases, preserving old IDs/hashes/pins. The same-root
auto-save baseline and switch-convergence collision checks now also pass their
red-green runtime/core tests. Teardown clears the old suspension window before
reinitialization. Root reran 478/478 tests, module linking, all 85 production
syntax checks, whitespace, and browser convergence/dirty-guard scenarios.
At that stage, a fresh review and verified remote push remained pending; the
final acceptance decision below supersedes the earlier review-loop requirement.

Review 6 found a malformed external import could replace useful history with
an empty canonical payload. Import-only validation now rejects non-restorable
content, malformed recognized fields and metadata before enrichment or any
storage write. Existing storage reads and rescue exports remain unchanged.
Actual repository and facade merge/replace regressions prove old pinned data,
markers and catalog unchanged on a malformed late entry; a real generated
snapshot/export/JSON/import roundtrip proves positive compatibility.
Root's latest complete gate is 487/487 tests and 86 production modules.

The supplementary save/export benchmark runs twice with twenty samples and
three warmups per case. `2026-10-24-performance-final.md` records capture,
commit, queue waiting, unsettled switch callbacks, explicit export blocking
and heap deltas, with synthetic/environment limits stated.

Review 7 rejected color-only compact prompt comparison. Explicit visible and
accessible A/B and change labels now cover content lines and blank values;
actual pointer swapping also exposed and fixed a decorative-arrow hit area.
The new acceptance audit rejects missing side labels and occluded controls.
Four-size/two-theme actual comparison and synthetic edge cases, English 360px,
and 32 ordinary/empty/loading/error cases pass. Root reran 494/494 tests,
86 module syntax/link checks and 577-key bilingual parity. Review 8 followed.

Review 8 passed the arithmetic mean but failed the frontend and mobile
dimensions: compact settings switches measured 38x20 and were absent from the
audit's effective-target set. The correction is complete: native inputs and
switch labels provide 44x44 targets; all 21 settings controls pass the
four-size/two-theme matrix. Corner clicks, Space, focus, canceled destructive
commands, and numeric/select update-and-restore checks pass without changing
fixture history. See `2026-10-24-implementation-settings-targets.md`.

## Final Acceptance Decision

The user's latest explicit instruction on 2026-10-24 stops repeated full-product
independent scoring and requests focused functional closeout. No ninth blind
review is commissioned. This replaces the previous score-loop exit condition,
not the safety or verification requirements. The historical eighth review did
not pass every dimension; no contrary claim is made.

The final functional gate passes 498 tests, 86 production-module contracts and
577 matching bilingual keys. Planned findings are mapped above to regression
evidence, with the settings correction verified separately. Commit/push and
remote-SHA verification are the remaining delivery step.

## Evidence Limits

The maintained browser harness runs production modules and styles with a
simulated SillyTavern host and isolated IndexedDB. It does not certify a live
installation or every host theme/version. Browser performance observations are
environment-specific samples, not universal p95 input-to-paint guarantees.
The repository journal is per instance, not a cross-tab lock; the documented
5,000-snapshot full-document update remains outside the 500-snapshot budget.
Neither limitation is hidden by the passing tests.
Review 8 also observed one initial ordinary opening around 355 ms with a 164 ms
long task, not reproduced in its subsequent remounts or large-history samples.
Cold initialization must remain separate from warmed interaction claims.

User-owned dirty/untracked files are outside the delivery. Development and the
authorized final push target `dev`; `main` is not modified.
