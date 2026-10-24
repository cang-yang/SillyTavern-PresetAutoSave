# Commands and UI Integration Progress

Status: command implementation verified; independent release approval remains
pending. This is an implementer report, not a blind review.

## Deletion

- Red: `node --test tests/integration/preset-deletion.test.mjs`, five failed behavioral assertions on the original action code. False/throw host results removed history and archives; successful deletion removed global organization shared with another API.
- Green: same five tests pass after `createPresetDeletionCommand` integration.
- Core command captures target before queuing, checks active target immediately before deletion, gates cleanup on explicit host success, isolates notification failure, and reports partial cleanup separately.
- Single and batch UI consume the same command. Global name-based organization survives scoped deletion because it can belong to another API.
- Added core cases for partial cleanup, observer failure, and queued immutable target protection.
- Compatibility: existing single boolean and batch success-count results remain. Batch additionally accepts explicit target records; old `(names, apiId)` callers remain supported.
- Final integration uses `deleteHostPresetDetailed(target, { afterDelete })`.
  Host deletion and history/archive cleanup retain the same writer barrier.
  Queued restores are cancelled before deleting; a newly recreated preset
  cannot commit its history until the prior cleanup finishes. Callback failure
  reports `partial` with its original stage and preserves remaining recovery.

## Batch Selection

- Browser baseline: selected one openai row, switched context to kobold and emitted main_api_changed; delete control still said one selected while no selected checkbox remained visible.
- Implemented canonical `apiId::presetName` selection, immutable target batch submission, and scope reset on API change. Both flat and version rows receive named checkboxes; repeated updates preserve checkbox nodes and focus.
- Added maintained harness `exerciseBatchTargets`. Executed against current checkout: targetCaptured=true, scopeCleared=true, accessibleName=true, zero console errors.
- Initial harness runs during parallel module changes encountered transient missing exports/imports. Those were resolved before recording the green behavior; they are not a passing final gate.

## Restore

- Panel now invokes save owner's `restoreSnapshotDetailed` through the shared coordinator, not direct host save/history calls.
- Rechecks target after confirmation. Partial outcome reports history failure and source snapshot retention; success only for committed/unchanged.
- Removed field-count heuristic in panel; shared canonical payload validation
  accepts compact valid presets and rejects empty canonical content.

Integration restore-failure, writer-race, lifecycle and deletion tests pass.
The fresh full gate before blind review 2 passed 452 tests, module linking,
production syntax and whitespace checks. Browser evidence is in the integration
report. Blind review 2 identified unrelated canonical export and metadata
contrast findings that must be fixed before the release gate can pass.
