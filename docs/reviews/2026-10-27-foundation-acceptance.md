# Foundation Integrity Acceptance

Date: 2026-10-27. Baseline: dev at 5a8a7f9.
This is the implementation acceptance record, not an independent review.

## Reproduced Failures and Corrections

Every added regression below was run against the relevant pre-fix behavior and
observed failing before implementing its correction.

| Boundary | Observed failure | Correction and regression |
| --- | --- | --- |
| Retention | Partial/pending snapshots were trimmed, age-deleted or coalesced; equal partial content suppressed a new committed record | Shared recovery-aware retention and committed-only dedupe; history-store-manual-retention and history-backup tests |
| Stop lifecycle | Rejected/incomplete stops were cached; different concurrent stop operations were dropped | Coalesce identical pending calls, serialize distinct calls, cache only success; runtime-lifecycle tests |
| Disable retry | Recovery could not resume after history storage had been torn down | Reopen history after quiescing autosave; lifecycle-retry-runtime test |
| History shutdown | Teardown detached storage while an accepted mutation was pending | Reject new mutations, drain accepted queue, then detach; history-drain-runtime test |
| Disable writeback | Existing newer native preset content was overwritten by an old snapshot | Only fill missing presets; lifecycle-retry-runtime test |
| Archive recovery | A save promise resolving without host registration allowed cleanup; conflicting existing content could be overwritten | Lifecycle-only adapter verifies canonical host inventory and preserves conflicts/unverified backups; preset-recovery-runtime tests |
| Recovery existence | Null/stale selector results overrode missing native inventory, permitting cleanup without writing; unknown content could be counted as present | Shared deterministic inventory lookup, authoritative presence/absence, fail-closed unknowns; snapshot-writeback and lifecycle-retry-runtime regressions |
| Delete readiness | Missing/coerced failure counts could permit destructive cleanup | Require explicit zero failure counts; lifecycle-recovery test |
| Canonical JSON | Root/import getters executed; symbol properties, sparse/decorated arrays could disappear | Descriptor-first validation before cloning/reading; preset-schema and history-import-validation tests |
| Settings identity | A literal __proto__ preset name vanished; reset of defaults persisted and notified again | Own data-property definitions and equivalent-value reset guard; settings-ownership and group-membership tests |
| Edit capture | 20 beforeinput/input pairs on a 500,000-character native draft caused 60 full captures; popup drafts/untouched blur caused 40 unnecessary captures | Reject drafts before capture; native draft has zero captures while typing, two at commit; host-preset-edit-events tests |
| Theme metadata | Independent review found subgroup-count labels with 1.55-1.63:1 light-theme contrast and sub-10px text; metadata audit omitted this class | Existing theme metadata tokens and 12px text; panel-contrast regression plus expanded browser sampling |
| Credential boundary | Unlisted-provider credentials survived canonicalization/import/export; nested non-OpenAI settings, metadata and old from/to summaries also retained synthetic secrets | Provider-independent semantic field rules across host/canonical/backup boundaries; regenerate derived comparisons from sanitized presets; four production-path history-backup regressions |

The capture result is an operation-count regression, not a device-independent
latency or speedup claim.

## Automated Verification

- Baseline: npm test, 545/545 passed.
- Foundation data-path implementation: npm test, 568/568 passed.
- After review-driven theme correction: npm test, 569/569 passed.
- After review-driven recovery correction: npm test, 576/576 passed.
- After review-driven credential correction: npm test, 580/580 passed.
- After literal group command and settings contrast correction: 584/584 passed.
- npm run check: 91 production modules parse/link, no circular dependencies,
  matching English/Chinese key sets (577 keys).
- node --check: all 91 production JavaScript files passed.
- git diff --check: passed; existing Windows LF/CRLF notices are not failures.

## Changed-Behavior Browser Acceptance

Windows, Chromium through Playwright CLI, maintained host fixture at
http://127.0.0.1:4173/tests/harness/edit-intent.html.

- Desktop 1280x720: native quick-edit typing followed by a debounce wait produced
  zero writes. Focus transfer committed the draft; immediately selecting B
  produced exactly one write to A containing the edited text.
- Twenty subsequent background extension mutations plus settings events and
  DOM noise produced no additional writes. No runtime error was recorded.
- Touch context 390x844: native draft typing produced zero writes, tapping away
  committed exactly once. Popup draft typing did not save; tapping Save prompt
  committed the changed content exactly once more. No runtime error was recorded.
- Screenshots inspected: output/playwright/foundation-quick-edit-switch.png
  and output/playwright/foundation-mobile-edit.png. These show the host fixture,
  not a claim about the user's installed SillyTavern theme.
- An initial automation attempt used selectOption without transferring focus,
  so the host blur handler never ran. Repeating with actual focus transfer
  exercised the intended commit/switch sequence successfully.
- Subgroup contrast regression was observed failing in both a focused Node test
  and an explicit browser assertion before the style correction. After correction,
  all four required viewports (1280x900, 768x900, 390x844, 360x800) passed in both
  light and dark themes with no audit errors/warnings. Labels measured 12px,
  light contrast 7.38:1 and dark contrast 8.18:1. Screenshots
  output/playwright/foundation-label-{light,dark}-{1280,768,390,360}.png were
  captured; desktop light, mobile light and smallest dark were visually inspected.
- After the credential correction, the edit-intent browser fixture was rerun:
  Tokens=2048 saved once; quick-edit draft containing the literal text
  `api_key_custom` did not save until blur, then immediately switching to B
  wrote the unchanged literal prompt text to A exactly once. No browser/runtime
  error occurred, and teardown completed before closing the browser.
- A real Playwright click/fill/Enter on a manually assigned `__proto__` group
  reproduced an empty alias map before correction. The same interaction now
  saves an own alias property; actual Undo and Redo restore/reapply it while
  preserving `Demo -> __proto__` membership. The maintained harness exposes
  `exerciseLiteralGroupIdentity()` for repeatable controller coverage. Pure
  commands cover alias reset, normalized duplicates, parent promotion/deletion,
  default-version toggles and inherited-edge rejection.
- The settings contrast regression failed before the style change. Descriptions
  and units now use 12px metadata text on an explicit theme surface; audit
  sampling includes both classes. All eight required viewport/theme settings
  scenarios passed with actual visible text samples (dark minimum 8.89:1).
  Screenshots `output/playwright/foundation-settings-{light,dark}-{1280,768,390,360}.png`
  were captured; compact light and desktop dark were visually inspected.

## Compatibility and Limits

No storage migration, history deletion, runtime package, CSS redesign or new
settings key is introduced. Legacy records without saveStatus remain readable
as committed. Explicit user deletion and manual snapshot restore are unchanged.
Protected recovery records may keep a bucket above its ordinary retention cap.

The actual runtime deletion regression first reproduced complete=true and
history cleanup without attempting a deliberately failing recovery write. After
the fix, the first delete attempt reports incomplete and preserves the exact
snapshot ID. Retrying after restoring the host writer registers and verifies
the missing preset before clearing history. Additional red-green cases cover
null/undefined/stale selector results, selector-only unknown inventory, listed
names without content, unsupported inventory containers and malformed snapshot
enumeration. Recovery no longer mistakes any of these for verified empty work.

Recovery verifies successful host save plus inventory content, not independent
server-disk durability. Unknown inventory capability and content conflicts fail
closed with recovery data retained. This can require explicit resolution rather
than automatic overwrite. Existing trusted-edit coverage does not expand to
every third-party extension's custom editor.

Structured credential filtering is provider-independent and shared by native
capture, canonical data, import and export. Token budgets and literal prompt,
template and label strings are preserved; this is not a secret scanner for
arbitrary user prose. Export/import regenerate derived summaries and change sets
from sanitized canonical presets, rather than trusting old from/to caches.
Existing stored histories are not migrated or mutated by exporting them.
Valid legacy summary shapes remain accepted, but are no longer authoritative
export/import caches. The existing serialized generated-summary roundtrip test
also passes, including absent from/to members.

The harness uses real DOM/browser events with a simulated SillyTavern adapter;
the user's live installation, server storage and complete extension mix were not
available for end-to-end verification.

## Independent Review and Delivery

The preliminary blind review (report 8) evaluated the baseline and explicitly
does not certify the later edits. Report 9 evaluated the frozen data-path
implementation: 94/94/92/91/88/90, mean91.5. It failed the per-dimension gate due
to the subgroup readability issue above. That finding was reproduced and fixed.
Report10 scored88/82/92/91/91/90, mean89.0, and exposed the recovery existence
blocker described above. It was reproduced through the real lifecycle entrypoint
and corrected with a shared inventory contract. Report11 scored92/78/93/91/93/90,
mean89.5, and exposed provider-enumerated credential filtering. Four failing
regressions reproduced that and adjacent export paths before the coherent
credential-boundary correction. Report12 scored91/94/90/89/87/90, mean90.2;
the special-key alias and settings readability issues were reproduced and fixed
as described above. Fresh-context report13 evaluated the frozen revised checkout
without an author change summary or prior report supplied and passed:
93/94/92/90/92/90, mean91.8, no reproduced release blocker. It independently
reran all584 tests, all91 production syntax checks and the module/i18n gate,
plus required browser scenarios. Performance fixture500 records/46MiB:
35.1ms warm,75.2ms cold, no payload reads; repeated view-switch callbacks<=2.6ms.
These are measured local harness results, not real-host or mobile-device claims.

Remaining non-blocking work is gradual extraction from oversized controllers
when their responsibilities change, and a smoke run in an actual supported
SillyTavern installation. Neither is represented as already completed.
Delivery is the scoped dev commit containing this report; main is unchanged.
