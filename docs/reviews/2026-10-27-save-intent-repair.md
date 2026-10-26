# Root-Cause Repair Acceptance

Scope: the supplied capture-error log and unsolicited preset saves. This is a
targeted repair review, not another full-product score or an assertion that
every third-party extension has been tested.

## Findings And Replacement

1. Background settings events, prompt DOM redraws and polling previously created
   automatic write permission. A runtime probe changed an extension flag and
   emitted settings_updated with no input: one host write and one history entry.
   The new host adapter requires a trusted editing action and a scoped delta.
2. Completion compared mutable whole-object state and scheduled another save.
   Requests now retain their canonical payload, target and edit revision from
   acceptance through debounce, retries and switch guards.
3. Host JavaScript undefined values were rejected as malformed persisted JSON.
   Host capture now implements omission/null semantics without relaxing import
   validation. Functions, non-finite numbers, cycles and accessors fail closed.
   Invalid current state cannot silently fall back to an older stored preset.
4. Timeout reporting released the visible busy flag despite an unresolved host
   write. The watchdog now reports the delay but retains writer ownership.
5. Full live/stored equality prevented switch convergence when runtime extension
   state differed. Stable hinted targets can settle unverified without asserting
   a committed baseline, seeding history or granting write permission.

The log contained328 non-JSON failures on October26-27,26 older convergence
warnings,6 older watchdog warnings and4 August restore ReferenceErrors.
The obsolete restore ReferenceError path is absent from this checkout. The
screenshot alone does not identify the four extension paths or their writer;
equal prompt lengths are not evidence of equal prompt text.

## Focused Review And Red-Green

Baseline:498 tests passed before implementation. Actual production-runtime
tests failed for background writes, completion drift and unowned scheduling
before the replacement. Capture adapter and event adapter red-green details
are recorded in the accompanying capture plan and edit-events report.

Targeted independent code review identified further reproducible edges:

- A second edit reverting to the committed value while an older write is active
  was deduplicated incorrectly. The regression failed with the older edit left
  persisted; deduplication now waits until no writer is active.
- Manual/native recovery of a failed submitted edit left permanent dirty state.
  Recovery captures the applicable edit revision and acknowledges only it.
  Removing native capture's revision reproduced true instead of false for dirty.
- A same-turn preset selection could run before the edit's scheduled capture.
  Pre-switch flush finalizes only the proven old live target before replacement.
- Disable could leave a queued automatic write. Queued automatic requests are
  cancelled; an active writer retains ownership until its promise settles.
- Retrying by recapturing live state persisted0.11 instead of the failed edit's
  0.92. The explicit negative-control run failed; immutable retry passed.

Regression suites also cover synthetic events, scoped prompt actions, dialog
cancellation, drag vs scrolling, teardown, invalid initialization recovery,
newer edits during writes, slow writes, and stable unverified switching.

## Browser Evidence

Windows, Chromium via Playwright CLI, local npm run harness server. The dedicated
tests/harness/edit-intent.html loads production capture/adapter/save/history
modules with an isolated memory host fixture; it is not the user's live Tavern.

- Actual keyboard range edit, number input, quick-edit blur, popup draft then
  submit, toggle, cancel/confirm delete and pointer drag were exercised.
- Background extension flips and DOM redraws alone produced zero new saves.
- Held write2048 followed by a real3072 edit and ambient mutation committed2048
  then3072; the ambient flag was excluded from those already captured requests.
- Editing4096 then switching A to B wrote4096 to A, settled on B, and left no
  dirty/pending state.
- At1280x900,768x900,390x844 and360x800, input produced one automatic save;
  ten subsequent ambient flips produced none. No page overflow or runtime error.
- Mobile touch context: toggle wrote once; background change did not write;
  explicit snapshot wrote a second time and preserved that extension state.
  After teardown another touch caused no write.
- Production panel settings were exercised at all four sizes in dark and light
  themes. All eight layout audits passed, with no horizontal overflow or console
  errors. One cold desktop render was392ms, above the harness250ms warning target
  but below the product500ms opening target. No broad performance score claimed.

Screenshots inspected locally:
output/playwright/edit-intent-{1280,768,390,360}.png and
output/playwright/save-settings-{dark,light}-390.png.
The legacy browser function that fabricated synthetic user input was removed;
dedicated real-control fixture contracts replace it.

At360px, keyboard ArrowRight navigation reached Settings and the updated polling
description was visible, wrapped within its248px text column and reachable via
the panel scroll owner.

## Final Verification

- npm test:545/545 passed, zero failed/skipped/cancelled.
- npm run check:88 production modules link; no circular dependency or residual
  reference errors; both language files have identical577-key sets.
- node --check:all88 production JavaScript modules passed.
- git diff --check:passed; unrelated user .gitignore retains its pre-existing
  line-ending warning and is not staged.
- git fetch origin dev main succeeded; pre-commit HEAD...origin/dev was0/0.

## Compatibility And Limits

No schema migration, historical deletion, new runtime dependency, secret/prompt
logging or extension blacklist was added. Valid extension payloads remain intact.
Background data already present when a real edit is captured can be included in
that full snapshot; trigger ownership is not per-field authorship.

Third-party script-only edits, detached file-picker imports and legacy reused
confirmation dialogs without a verified adapter need manual snapshot/native
save. A background mutation inside the same scoped field during a trusted edit
cannot be attributed perfectly from shared host state. These limitations are
documented rather than hidden by heuristic field suppression.

The user's actual installed host/plugins have not been exercised. Old history
entries are deliberately retained. Deployment of dev is separate from main.
