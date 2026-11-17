# Host Accessor Capture Verification

## Diagnosis

User log at 2026-11-17 15:00:55 reports PRESET_NON_JSON at root prompts
(accessor), from host capture invoked during a possible drag. The observer
captures before it can compare edits, so this failure blocks subsequent
editing as well. The switch candidate reader uses the same capture boundary;
rejection there can prevent convergence and skip baseline seeding. The two
timeout warnings alone do not prove that every timeout has this cause.

The code previously rejected every root accessor without reading its value.
That incorrectly applied a document-validation rule to a live settings object.
The installer of this particular getter is not identified by the log; no
specific extension is blamed. No real application process was running locally
during this repair, and no new desktop/mobile runtime verification is claimed.

## Change and Scope

captureHostPreset filters excluded fields first, reads an admitted root getter
once with the host object as receiver, then validates/copies the result into a
plain snapshot. Nested accessors, cycles, unsupported values and setter-only
fields still fail closed. Throwing getters produce path/type diagnostics that
do not expose their thrown message or cause. Strict canonicalization, imports,
export validation, serialization, identity and write coordination are unchanged.

## Evidence

- Baseline: npm test, 597 passed.
- Reproduced capture failure via compatibility APIs with root prompts getter.
- Before fix: getter-backed engine fixture reports the same prompts/accessor
  error and remains in ignoring state after a preset change. This was rerun
  red after aligning live and stored fixture content to isolate the accessor.
- After fix: switch converges and a trusted edit persists the getter-backed
  prompt content in the native writer request and committed history snapshot.
- Coverage checks original receiver, one read per field/capture, detached
  output, excluded getter nonexecution, thrown getter secrecy, invalid results,
  circular result, setter-only rejection and unchanged strict document/import
  validation without evaluating document getters.
- Focused capture tests: 16 passed.
- Full npm test: 603 passed, 0 failed.
- npm run check: passed; 94 production modules, 577 identical i18n keys.
- node --check: 94 production modules passed.
- git diff --check: passed (existing unrelated .gitignore line-ending warning).

An initial new import assertion expected the word accessor, while the existing
import validator intentionally returns a generic TypeError. Corrected the
assertion to check rejection and zero getter reads; production import behavior
was not changed.

Scoped diff reviewed for canonical data compatibility, failure behavior and
unrelated changes. No UI, observer, event/timer, i18n or storage migration changes.
This report is implementation verification, not a blind whole-product review.
