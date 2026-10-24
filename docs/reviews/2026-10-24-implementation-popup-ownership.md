# Popup Ownership And Group Expansion: 2026-10-24

Snapshot viewer openings own their delayed binding, copy listener and popup handle.
A later opening or panel disposal invalidates an earlier in-flight snapshot read.
Instance-specific DOM attributes prevent late work from binding another popup.
Settling an old popup never clears the active popup reference.

Import choices remain independent concurrent instances. Each has unique root and
radio-group identity, cancellable bounded mount polling and a disposed controller.
An optional abort signal lets the settings-panel owner close an outstanding
preview; existing callers and the pure renderer keep their existing interfaces.
Fallback confirmation remains merge-only and cancellation is checked afterward.
No stored data or host preset format changes.

Expand-all and default current/all expansion consume the same resolved current-API
projection as list rendering, including zero-snapshot native presets and canonical
tree ancestors. Display aliases never become expansion keys.

Add failing behavioral regressions first for overlapping import choices, stale
viewer copy binding and canonical native/tree expansion. Then implement scoped
ownership, run focused tests and rerun complete verification with the coordinator.

## Red-Green Results

- Reopening a viewer originally copied `{temperature: 0.3}` from the closed
  viewer instead of the new `{temperature: 0.9}` payload. The integration test now
  verifies correct clipboard content and zero remaining listeners after close.
- Overlapping import choices originally left the first root with zero listeners,
  binding both choices to the newest root. Unique instance and radio identities
  now produce one controller each; aborting one removes only its handlers/popup.
- Expansion originally returned no keys for a native-only fixture. Both all and
  current modes now include canonical empty ancestors and native targets.
- Additional focused red cases verified that search/current views omitted native
  presets with zero history and that max-depth tree rendering dropped a flattened
  descendant when its parent also owned a preset. The common projection now
  preserves both targets and history-only filters still exclude empty versions.
- Maintained Chromium harness red: adding native `Unseen V1`, then searching
  `Unseen`, produced "No matching results". After the panel empty-state guard
  changed, the same workflow finds canonical `unseen`; expand-all reveals
  `openai::Unseen V1`, with zero console errors.
- The prior bounded-render source matcher was replaced with actual flat/nested
  renderer calls: collapsed groups emit no version markup; expanded groups
  produce five snapshot cards plus continuation, even with twenty source records.
- Fresh shared `npm test`: 449/449 passing. `npm run check` and `git diff --check`
  pass at this checkpoint (the latter only warns about pre-existing .gitignore
  line endings). The coordinator runs final production syntax and review gates.

The snapshot-viewer implementation moved out of oversized panel-actions into a
focused module owning its payload read, markup and lifetime. No other action
ownership changed. The group list model now owns the shared native/history/tree
projection; rendering and expansion consume it instead of rebuilding membership.
