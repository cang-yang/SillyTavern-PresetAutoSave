# Native Edit Coverage Implementation Plan

**Goal:** Restore automatic persistence for the confirmed native control paths.
**Architecture:** A host-owned control-to-canonical-field table replaces ID
guessing; the existing event observer and serialized save path stay in place.
**Tech Stack:** Browser ES modules, node:test, Playwright CLI, real local
SillyTavern with an isolated data root.

## Constraints

No ambient save authorization, changes to user data, new runtime dependency,
storage migration or unrelated refactor. Work on dev. Do not update main.
The precise user's editor remains a separate unverified reproduction.

## Steps

- [x] Baseline `npm test`: 584 passed; confirm current checkout and preserve dirt.
- [x] Real-host red: stream toggle and new-chat prompt produce zero autosaves;
  native popup prompt submission succeeds. Verify actual loaded source.
- [x] Add native selector coverage to `tests/host-preset-edit-events.test.mjs`,
  and persistence assertions in `tests/integration/save-intent-runtime.test.mjs`.
  Run both and observe the expected missing edit/write failures.
- [x] Extract host field resolution to `modules/host/preset-control-contract.js`;
  import it into `modules/host/preset-edit-events.js`. Map every owned scalar
  native selector plus counters and native radio choices, while preserving
  non-OpenAI behavior and ignoring connection/global-only settings.
- [x] Run focused tests, then real-host browser edits and disk readback.
  Check popup prompt edits, numeric input, checkbox, utility text, background
  settings noise, reload persistence and cleanup.
- [x] Run `npm test`, `npm run check`, production `node --check`, `git diff --check`.
  Review only this functional change; document real-host evidence and limits.
- [x] Complete the focused read-only review and stop isolated test services.
- [ ] Commit scoped files and push authorized dev; verify remote SHA.

## Test Pattern

```js
controls.change('new_chat_prompt', 'user edit', {
    id: 'newchat_prompt_textarea', tagName: 'TEXTAREA', type: 'textarea',
});
await wait(200);
assert.equal(host.writes.at(-1).preset.new_chat_prompt, 'user edit');
assert.equal((await history.getSnapshots('openai', 'race'))[0].preset.new_chat_prompt, 'user edit');
```

Acceptance uses the production observer and real host-shaped events, not a
direct call to `saveNow` that would bypass the broken authorization boundary.
