# Custom Group Display Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add comfortable inline editing and stable display aliases for preset groups without changing preset membership or canonical group identity.

**Architecture:** Store aliases separately from per-preset manual overrides. Resolve canonical identity and display name in pure grouping helpers, then pass the alias map through every user-facing grouping consumer. The group manager owns transient inline-edit state while settings remains the persistence boundary.

**Tech Stack:** Browser-native JavaScript ES modules, SillyTavern extension settings, HTML/CSS, Node.js built-in test runner.

## Global Constraints

- Do not modify real SillyTavern preset names.
- Do not add runtime dependencies or a new popup framework.
- Alias values are trimmed, non-empty, and at most 120 Unicode code points.
- Enter saves, Escape cancels, IME composition Enter does not save, and valid blur saves.
- Touch controls are at least 44px; keyboard focus remains visible.
- Canonical keys continue to drive nesting, drag/drop, defaults, and membership.

---

### Task 1: Alias domain model and settings

**Files:**
- Modify: `modules/settings.js`
- Modify: `modules/preset-grouping.js`
- Create: `tests/grouping-series-aliases.test.mjs`

**Interfaces:**
- Produces: `resolveSeriesDisplayName(automaticName, aliases) -> { canonicalKey, automaticName, displayName, customized }`
- Produces: `validateSeriesAlias(name, groups, currentCanonicalKey) -> { ok, value?, reason? }`
- Extends: `groupNamesBySeries(names, overrides, aliases)` while preserving two-argument callers.

- [ ] **Step 1: Write failing pure-function tests**

Cover alias resolution, new-version inheritance, canonical membership stability, Unicode length, blank values, and duplicate normalized display names.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/grouping-series-aliases.test.mjs`

Expected: FAIL because alias exports and the settings field do not exist.

- [ ] **Step 3: Implement minimal model support**

Add `groupingSeriesAliases: {}` plus a dedicated sanitizer. Add pure alias resolution/validation helpers and enrich group results with:

```js
{
  key: canonicalKey,
  canonicalKey,
  automaticName,
  displayName,
  series: displayName,
  customized,
  items,
}
```

- [ ] **Step 4: Verify GREEN and existing grouping tests**

Run: `node --test tests/grouping-series-aliases.test.mjs tests/group-manager-view-model.test.mjs tests/preset-canonicalization.test.mjs`

Expected: all pass.

- [ ] **Step 5: Commit the domain slice**

```bash
git add modules/settings.js modules/preset-grouping.js tests/grouping-series-aliases.test.mjs
git commit -m "feat: add stable preset group aliases"
```

### Task 2: Propagate aliases through grouping consumers

**Files:**
- Modify: `modules/preset-takeover.js`
- Modify: `modules/history-panel.js`
- Modify: `modules/panel-list-render.js`
- Modify: `modules/panel-actions.js`
- Modify: `modules/panel-group-manager.js`
- Modify: `modules/panel-settings-log.js`
- Create: `tests/grouping-alias-integration.test.mjs`

**Interfaces:**
- Consumes: `groupNamesBySeries(names, overrides, aliases)` from Task 1.
- Consumes: `groupingSeriesAliases` from settings.
- Keeps canonical keys for `groupingTree` and `seriesDefaultApply` lookups.

- [ ] **Step 1: Write failing source/integration tests**

Assert that takeover, history rendering, group management, move dialogs, reset settings, and first-scan grouping pass the alias map and do not replace canonical keys with display names.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/grouping-alias-integration.test.mjs`

Expected: FAIL because consumers only pass manual overrides.

- [ ] **Step 3: Update consumers**

At each grouping boundary, read both maps:

```js
const overrides = settings.groupingManualOverrides || {};
const aliases = settings.groupingSeriesAliases || {};
const groups = groupNamesBySeries(names, overrides, aliases);
```

Use `group.canonicalKey` for structural operations and `group.displayName`/`group.series` for text.

- [ ] **Step 4: Verify GREEN and integration regressions**

Run: `node --test tests/grouping-alias-integration.test.mjs tests/integration/panel-summary.test.mjs tests/visual-scenarios.test.mjs`

Expected: all pass.

- [ ] **Step 5: Commit the integration slice**

```bash
git add modules/preset-takeover.js modules/history-panel.js modules/panel-list-render.js modules/panel-actions.js modules/panel-group-manager.js modules/panel-settings-log.js tests/grouping-alias-integration.test.mjs
git commit -m "feat: show group aliases across preset views"
```

### Task 3: Comfortable inline rename interaction

**Files:**
- Modify: `modules/panel-group-manager.js`
- Modify: `styles/panel-v4.css`
- Modify: `style.css`
- Modify: `i18n/zh-cn.json`
- Modify: `i18n/en-us.json`
- Create: `modules/core/group-alias-editor.js`
- Create: `tests/group-alias-editor.test.mjs`
- Modify: `tests/group-manager-interaction.test.mjs`

**Interfaces:**
- Produces: `createGroupAliasEditor({ validate, save, cancel })` for IME-safe edit-state transitions.
- Consumes: alias validation from Task 1 and `updateSetting('groupingSeriesAliases', nextAliases)`.

- [ ] **Step 1: Write failing editor and markup tests**

Cover Enter save, Escape cancel, composing Enter ignore, valid blur save, invalid blur retention, accessible error linkage, pencil entry point, reset menu item, and mobile 44px target.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/group-alias-editor.test.mjs tests/group-manager-interaction.test.mjs`

Expected: FAIL because the editor module and inline controls do not exist.

- [ ] **Step 3: Implement editor state and inline markup**

Render a button next to the group name and switch the title region to:

```html
<span class="pas-gm-name-editor">
  <input class="pas-gm-name-input" maxlength="120" aria-describedby="...">
  <span class="pas-gm-name-error" role="alert"></span>
</span>
```

Prevent header toggling when the event originates from editor controls. Restore focus to the rename trigger after cancel and to the renamed header after save.

- [ ] **Step 4: Add reset and i18n**

For customized groups add a menu action labeled with the automatic name. Delete only the current canonical alias key and refresh without confirmation or success Toast.

- [ ] **Step 5: Add responsive, theme-aware styles**

Use existing PAS tokens, visible `:focus-visible`, unobtrusive desktop reveal, always-visible coarse-pointer control, 44px coarse-pointer size, and reduced-motion fallback.

- [ ] **Step 6: Verify GREEN**

Run: `node --test tests/group-alias-editor.test.mjs tests/group-manager-interaction.test.mjs tests/panel-shell.test.mjs`

Expected: all pass.

- [ ] **Step 7: Commit the interaction slice**

```bash
git add modules/core/group-alias-editor.js modules/panel-group-manager.js styles/panel-v4.css style.css i18n/zh-cn.json i18n/en-us.json tests/group-alias-editor.test.mjs tests/group-manager-interaction.test.mjs
git commit -m "feat: add inline preset group renaming"
```

### Task 4: Full regression and delivery verification

**Files:**
- Modify only if verification exposes a regression in feature-owned files.

**Interfaces:**
- Verifies all interfaces produced in Tasks 1–3.

- [ ] **Step 1: Run import, dependency, and i18n checks**

Run: `npm run check`

Expected: import/export completeness, circular dependency, residual reference, and i18n checks pass.

- [ ] **Step 2: Run every tracked test**

```powershell
$tests = @(git ls-files | Where-Object { $_ -match '^tests/.+\.test\.mjs$' })
node --test $tests
```

Expected: zero failures. Do not use bare `npm test`, because this working tree contains unrelated untracked browser/database experiments that Node auto-discovers.

- [ ] **Step 3: Inspect the final diff and worktree scope**

Run: `git status --short` and `git diff HEAD~3 --check`.

Expected: no whitespace errors; unrelated pre-existing files remain untouched.

- [ ] **Step 4: Report the interaction and verification evidence**

Summarize the user path, persistence behavior, tests passed, and any pre-existing dirty files left untouched.
