# Save Content Identity Implementation Evidence

Date: 2026-10-24

This is implementation evidence, not an independent scorecard.

## Scope

- `modules/auto-save.js`: exact canonical baseline for save, DOM switch capture,
  switch-before protection, and polling; captured request baseline at completion;
  switch sample captures its raw fingerprint; baseline and suspension teardown.
- `modules/core/save-completion.js`: fallback completion compares exact canonical
  content when a raw host JSON fingerprint is unavailable.
- `modules/core/preset-switch-convergence.js`: exact stored/live evidence and
  exact consecutive sample identity; hashes remain metadata.
- Existing core fixtures migrated to the exact internal content contract.
- New real-runtime collision suite exercises all save entry paths.

No storage representation, hash algorithm, history IDs, public diagnostic hash,
UI, localization, dependency, or timer/subscription structure changed.

## Red-Green Evidence

Baseline command:

```text
node --test tests/integration/save-completion-runtime.test.mjs tests/core/save-completion.test.mjs tests/core/preset-switch-convergence.test.mjs
```

Result: 12 passing before changes.

The collision fixture is the real canonical OpenAI object with temperature
0.1, top_p 0.9, both penalties 0, openai_max_tokens 1024, prompts [], and
send_if_empty values `collision-17327` / `collision-28051`. Both hash to
`19x4r5g`; the regression asserts this precondition.

1. Initial runtime regression failed before implementation: expected committed,
   actual unavailable. No host write occurred. It now verifies a write and
   history snapshot in both directions between the colliding values.
2. Three new core regressions failed before implementation: completion lost
   pending intent with no raw fingerprint; switch convergence incorrectly
   verified different contents; consecutive colliding states counted as stable.
   All pass with exact serialization.
3. Expanded runtime event/polling/switch regressions were checked by temporarily
   restoring just the old hash-only guard predicates. Four failures reproduced:
   switch-before, DOM capture, and polling made no write; switch convergence
   prematurely ended protection while stored and live content disagreed.
   Exact predicates were restored and all five runtime tests pass.
4. The combined lifecycle sequence initially exposed a separate existing state
   leak: DOM capture set a four-second suspension, teardown preserved it, and
   a reinitialized polling callback skipped the edit. Clearing the old lifecycle
   suspension in teardown fixes that observed failure.

## Final Verification

- `npm test`: 478 passed, 0 failed.
- `npm run check`: 85 production modules parse/link; no import/export or cycle
  failures; 573 identical English/Chinese key sets.
- `node --check` for `index.js` and every `.js` / `.mjs` under `modules`: 85 passed.
- `git diff --check`: passed. Git reports a pre-existing `.gitignore` LF/CRLF
  advisory only; that file was not edited by this task.

No UI files changed, so this task does not claim new browser or visual evidence.
Root retains responsibility for the full program's browser and independent
review gates.

## Cost and Remaining Scope

One complete canonical string is retained for the active baseline and each
queued immutable request. The full save path and polling/switch verification
perform additional stable serialization. Repeated unchanged settings events
retain their exact raw JSON quick precheck. There are no measured performance
improvement claims from this correctness fix.

The oversized auto-save orchestrator receives an invariant replacement only.
History deduplication is owned and verified separately. No commits or pushes
were performed by this task.
