# Semantic History Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and integrate one canonical preset/change-set core so snapshot hashing and displayed changes can never disagree.

**Architecture:** Add browser-compatible pure ES modules under `modules/core/`. `canonicalizePreset` produces the only representation allowed for hashing and comparison; `createChangeSet` recursively explains every canonical difference. The first integration replaces history-store summary inputs while preserving v1 snapshot shape and all existing IndexedDB data.

**Tech Stack:** Browser ES modules, Node.js built-in test runner, SillyTavern 1.18 PresetManager data, IndexedDB via existing LocalForage wrapper.

---

## File Map

- Create `package.json`: deterministic local test commands; no runtime dependencies.
- Create `modules/core/value-utils.js`: stable serialization, cloning-safe scalar normalization and path helpers.
- Create `modules/core/preset-schema.js`: canonicalization policy and ignored-path reasons.
- Create `modules/core/change-set.js`: exhaustive recursive semantic diff and summary projection.
- Create `tests/core/preset-schema.test.mjs`: canonicalization regression tests.
- Create `tests/core/change-set.test.mjs`: “hash changed but summary empty” invariant tests.
- Create `tests/integration/history-store-change-set.test.mjs`: history-store compatibility tests with mocked SillyTavern storage.
- Modify `modules/history-store.js`: use canonical data/change-set for hash and summary.
- Modify `modules/compatibility.js`: delegate snapshot canonicalization to the new schema adapter.
- Modify `modules/panel-summary.js`: show concrete fallback paths, never unexplained “minor changes”.
- Modify `_check.cjs`: include new modules in import/export verification.

### Task 1: Establish the test baseline

**Files:**
- Create: `package.json`
- Create: `tests/core/preset-schema.test.mjs`

- [ ] **Step 1: Add a dependency-free test command**

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/**/*.test.mjs",
    "check": "node _check.cjs"
  }
}
```

- [ ] **Step 2: Write the first failing schema test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizePreset } from '../../modules/core/preset-schema.js';

test('canonicalization preserves user preset fields and explains ignored connection fields', () => {
    const result = canonicalizePreset({
        temperature: '1.0',
        tool_call_recurse_limit: '5',
        reverse_proxy: 'https://secret.example',
    }, { apiId: 'openai' });

    assert.deepEqual(result.canonical, {
        temperature: 1,
        tool_call_recurse_limit: 5,
    });
    assert.deepEqual(result.ignored, [
        { path: 'reverse_proxy', reason: 'connection-setting' },
    ]);
});
```

- [ ] **Step 3: Run the test and verify the module-not-found failure**

Run: `npm test`

Expected: FAIL because `modules/core/preset-schema.js` does not exist.

- [ ] **Step 4: Run the existing structural check before implementation**

Run: `node _check.cjs`

Expected: all existing import/export, cycle and i18n checks pass.

### Task 2: Implement canonical preset representation

**Files:**
- Create: `modules/core/value-utils.js`
- Create: `modules/core/preset-schema.js`
- Modify: `tests/core/preset-schema.test.mjs`

- [ ] **Step 1: Add failing cases for recursive normalization and stable key order**

Tests must assert:

```js
assert.deepEqual(canonicalizePreset({ b: 'true', a: '02', nested: { z: '3.5', a: '' } }).canonical, {
    a: '02',
    b: true,
    nested: { a: '', z: 3.5 },
});
```

Also assert that input objects are not mutated and prompt array order is preserved.

- [ ] **Step 2: Run focused tests and observe failures**

Run: `node --test tests/core/preset-schema.test.mjs`

Expected: FAIL for recursive normalization and missing implementation.

- [ ] **Step 3: Implement value utilities**

`normalizeValue(value)` must recursively:

- preserve array order;
- sort object keys;
- convert exact decimal strings without ambiguous leading zeroes;
- convert `true` and `false` strings;
- preserve empty strings and non-plain objects as serializable values.

Export `stableStringify(value)` as `JSON.stringify(normalizeValue(value))`.

- [ ] **Step 4: Implement schema policy**

Export:

```js
canonicalizePreset(preset, { apiId = 'openai' } = {})
```

It returns `{ canonical, ignored }`. For OpenAI, classify existing `EXPORT_EXCLUDED_FIELDS` connection/environment keys as ignored, preserve `tool_call_recurse_limit`, and preserve `extensions` as canonical structured data. Reject arrays/null as the root.

- [ ] **Step 5: Run schema tests**

Run: `node --test tests/core/preset-schema.test.mjs`

Expected: PASS.

### Task 3: Build exhaustive semantic ChangeSet

**Files:**
- Create: `modules/core/change-set.js`
- Create: `tests/core/change-set.test.mjs`

- [ ] **Step 1: Write failing regression tests**

Cover these exact cases:

```js
test('explains tool recurse limit changes', () => {
    const result = createChangeSet({ tool_call_recurse_limit: 3 }, { tool_call_recurse_limit: 5 });
    assert.deepEqual(result.changed.map(x => x.path), ['tool_call_recurse_limit']);
    assert.equal(result.meaningful, true);
});

test('explains extension changes instead of producing minor change', () => {
    const result = createChangeSet(
        { extensions: { foo: { enabled: false } } },
        { extensions: { foo: { enabled: true } } },
    );
    assert.deepEqual(result.changed.map(x => x.path), ['extensions.foo.enabled']);
});

test('hash inequality implies a non-empty change set', () => {
    for (const [before, after] of regressionPairs) {
        if (stableStringify(before) !== stableStringify(after)) {
            assert.notEqual(createChangeSet(before, after).changed.length, 0);
        }
    }
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/core/change-set.test.mjs`

Expected: FAIL because `createChangeSet` is missing.

- [ ] **Step 3: Implement recursive diff**

Export `createChangeSet(before, after, options)` returning:

```js
{
  meaningful: boolean,
  changed: [{ path, kind, before, after }],
  counts: { added, removed, modified }
}
```

Object keys are compared in sorted order; arrays use identifier-aware matching for `prompts`, order-aware comparison for `prompt_order`, and index comparison elsewhere. Long strings expose lengths plus bounded previews, not unrestricted content.

- [ ] **Step 4: Add invariant enforcement**

Export `assertExplainableChange(before, after, changeSet)`. It throws when stable canonical strings differ but `changed` is empty.

- [ ] **Step 5: Run core tests**

Run: `node --test tests/core/*.test.mjs`

Expected: PASS.

### Task 4: Integrate canonical hashing and summaries

**Files:**
- Modify: `modules/history-store.js`
- Modify: `modules/compatibility.js`
- Create: `tests/integration/history-store-change-set.test.mjs`

- [ ] **Step 1: Write a failing history regression test**

Mock LocalForage, settings and `window.SillyTavern`, initialize HistoryStore, then add snapshots differing only in `tool_call_recurse_limit` and `extensions.foo.enabled`. Assert each returned snapshot has non-empty `summary.sections` containing the concrete paths.

- [ ] **Step 2: Run the integration test and verify the old behavior fails**

Run: `node --test tests/integration/history-store-change-set.test.mjs`

Expected: FAIL because current canonical whitelist omits the paths.

- [ ] **Step 3: Route snapshot capture through canonicalization**

Change `sanitizePresetForExport` to call `canonicalizePreset(...).canonical` after existing sensitive-field defenses. Preserve its public signature.

- [ ] **Step 4: Replace scalar whitelist comparison**

Use `createChangeSet` inside `computeChangeSummary`; project prompt changes to existing section kinds and project remaining paths to `field` items. Attach `rawChangedPaths` and `ignoredPaths` as additive fields so old UI/data remain compatible.

- [ ] **Step 5: Use the same canonical value for hash and summary**

In `addSnapshot`, canonicalize once, then use that object for serialization, hash, summary and stored `preset`. Call `assertExplainableChange` before committing a non-initial snapshot.

- [ ] **Step 6: Run integration and existing checks**

Run: `npm test && npm run check`

Expected: all tests and structural checks pass.

### Task 5: Make unexplained changes impossible in the UI

**Files:**
- Modify: `modules/panel-summary.js`
- Modify: `i18n/en-us.json`
- Modify: `i18n/zh-cn.json`
- Modify: `_check.cjs`

- [ ] **Step 1: Write a failing rendering test**

Given a summary with `rawChangedPaths: ['extensions.foo.enabled']` and no legacy sections, assert rendered HTML contains `extensions.foo.enabled` and does not contain the `Summary Minor` translation.

- [ ] **Step 2: Implement the diagnostic fallback**

Render bounded changed-path chips when legacy sections are empty. Reserve a new “unexplained invariant error” translation for corrupted legacy records only; never label a new record as a minor change.

- [ ] **Step 3: Register new modules in structural checks**

Add the new core files to `_check.cjs` so import/export and dependency-cycle checks cover them.

- [ ] **Step 4: Run full phase verification**

Run: `npm test && npm run check`, followed by syntax checking all `.js/.cjs/.mjs` files.

Expected: zero failed tests, zero syntax failures, identical i18n key sets and no circular dependencies.

### Task 6: Shadow validation against real preset samples

**Files:**
- Create: `tests/fixtures/README.md`
- Create: `tests/core/real-samples.test.mjs`
- Modify: `docs/superpowers/specs/2026-06-19-reliability-refactor-design.md`

- [ ] **Step 1: Add sanitized fixtures from repository samples**

Copy only preset structure required for tests; remove Prompt text and any connection data. Document each fixture’s origin and sanitization.

- [ ] **Step 2: Add mutation-matrix tests**

For every top-level canonical path in each fixture, mutate one safe value and assert either:

- the canonical hash remains identical with an explicit ignored reason; or
- the hash changes and ChangeSet contains that path.

- [ ] **Step 3: Run the matrix repeatedly**

Run: `node --test --test-rerun-failures=3 tests/core/real-samples.test.mjs`

Expected: PASS on every run with no order-dependent output.

- [ ] **Step 4: Record actual contract changes**

Update the design document only with verified deviations discovered during implementation; do not add speculative future features.

- [ ] **Step 5: Commit the completed phase**

Stage only files listed in this plan and commit with:

```text
refactor: unify preset hashing and semantic change tracking
```

Do not push the branch.
