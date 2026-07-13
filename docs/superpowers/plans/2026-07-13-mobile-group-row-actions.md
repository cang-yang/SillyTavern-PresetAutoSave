# Mobile Group Row Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give mobile group names more room by moving infrequent group actions out of the header and into the expanded group body.

**Architecture:** Keep desktop behavior unchanged. Render a mobile-only action row from the same node state already used by the desktop overflow menu, bind those buttons to the existing subgroup/restore/delete operations, and use the existing compact breakpoint to swap the desktop overflow trigger for the mobile row.

**Tech Stack:** Browser ES modules, semantic HTML buttons, responsive CSS, Node.js built-in test runner.

## Global Constraints

- Compact header keeps inline rename, preset count, and disclosure chevron.
- Mobile secondary actions have readable labels and at least 44px touch targets.
- Desktop overflow menu remains available and the mobile action row stays hidden.
- Existing group identity, aliases, nesting rules, deletion semantics, and preset-row actions do not change.
- Do not modify or stage unrelated dirty or untracked workspace files.

---

### Task 1: Render and bind mobile group actions

**Files:**
- Modify: `tests/group-manager-interaction.test.mjs`
- Modify: `modules/panel-group-manager.js:411-443, 1493-1518`

**Interfaces:**
- Consumes: existing node properties `key`, `customized`, `depth`, and settings `nestingEnabled`, `nestingMaxDepth`.
- Produces: `.pas-gm-mobile-actions` containing buttons with `data-action="subgroup"`, `data-action="restore-name"`, or `data-action="delete"`; `bindMobileGroupActions(container)` routes them to existing operations.

- [ ] **Step 1: Write the failing markup and wiring tests**

Add tests that require the mobile action container, the three applicable action identifiers, and bindings to existing operations:

```js
test('expanded groups expose applicable secondary actions outside the compact header', () => {
    assert.match(source, /pas-gm-mobile-actions/);
    assert.match(source, /data-action="subgroup"/);
    assert.match(source, /data-action="restore-name"/);
    assert.match(source, /data-action="delete"/);
    assert.doesNotMatch(source, /pas-gm-mobile-actions[\s\S]*data-action="rename"/);
});

test('mobile group actions reuse existing group operations', () => {
    assert.match(source, /bindMobileGroupActions/);
    assert.match(source, /action === 'subgroup'[\s\S]*onCreateSubGroup/);
    assert.match(source, /action === 'restore-name'[\s\S]*restoreGroupAlias/);
    assert.match(source, /action === 'delete'[\s\S]*onDeleteCustomGroup/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tests/group-manager-interaction.test.mjs`

Expected: FAIL because `.pas-gm-mobile-actions` and `bindMobileGroupActions` do not exist.

- [ ] **Step 3: Render only applicable mobile actions**

In `renderModernGroupingHTML`, derive `depthExceeded` from `indent` and `settings.nestingMaxDepth`, render subgroup only when allowed, restore only for customized names, and always retain the existing delete action. Append the row after `.pas-gm-series-body`, outside `.pas-gm-series-header`:

```js
const mobileActions = [
    nestingEnabled && !depthExceeded
        ? `<button type="button" data-action="subgroup"><i class="fa-solid fa-plus"></i><span>${escapeHtml(t('Grouping Series Menu New Subgroup'))}</span></button>`
        : '',
    node.customized
        ? `<button type="button" data-action="restore-name"><i class="fa-solid fa-arrow-rotate-left"></i><span>${escapeHtml(t('Grouping Restore Automatic Name', { name: automaticName }))}</span></button>`
        : '',
    `<button type="button" class="pas-gm-mobile-delete" data-action="delete"><i class="fa-solid fa-trash"></i><span>${escapeHtml(t('Grouping Series Menu Delete'))}</span></button>`,
].filter(Boolean).join('');
```

Set `data-depth-exceeded` on the series section so desktop and mobile actions use the same limit state.

- [ ] **Step 4: Bind mobile buttons to existing operations**

Add `bindMobileGroupActions(container)` and call it from `bindGroupingEvents(container)`:

```js
function bindMobileGroupActions(container) {
    container.querySelectorAll('.pas-gm-mobile-actions button').forEach(button => {
        button.onclick = async event => {
            event.stopPropagation();
            const seriesKey = button.closest('.pas-gm-series')?.getAttribute('data-series-key');
            const action = button.getAttribute('data-action');
            if (!seriesKey) return;
            if (action === 'subgroup') await onCreateSubGroup(seriesKey, container);
            else if (action === 'restore-name') restoreGroupAlias(seriesKey, container);
            else if (action === 'delete') await onDeleteCustomGroup(seriesKey, container);
        };
    });
}
```

Also include `.pas-gm-mobile-actions` in the group-header toggle guard.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run: `node --test tests/group-manager-interaction.test.mjs`

Expected: all tests PASS.

### Task 2: Swap controls and release name width on compact layouts

**Files:**
- Modify: `tests/group-manager-interaction.test.mjs`
- Modify: `style.css:4605-4713, 4825-4845`

**Interfaces:**
- Consumes: `.pas-gm-series-menu-btn`, `.pas-gm-mobile-actions`, `.pas-gm-series-name`, and the existing `@media (max-width: 640px)` breakpoint.
- Produces: desktop-hidden action row; compact-hidden overflow button; compact touch-safe labeled actions and tighter header spacing.

- [ ] **Step 1: Write the failing responsive CSS test**

```js
test('compact layout trades the overflow trigger for touch-safe labeled actions', () => {
    assert.match(css, /\.pas-gm-mobile-actions\s*\{[^}]*display:\s*none/s);
    assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.pas-gm-series-menu-btn\s*\{[^}]*display:\s*none/s);
    assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.pas-gm-mobile-actions\s*\{[^}]*display:\s*flex/s);
    assert.match(css, /\.pas-gm-mobile-actions button\s*\{[^}]*min-height:\s*44px/s);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tests/group-manager-interaction.test.mjs`

Expected: FAIL because the responsive swap styles do not exist.

- [ ] **Step 3: Add desktop-hidden and compact-visible action styles**

Add base styles:

```css
.pas-gm-mobile-actions { display: none; }
.pas-gm-mobile-actions button {
    min-height: 44px;
}
```

Inside the existing compact breakpoint, hide `.pas-gm-series-menu-btn`, display the action row as a wrapping flex row, and set compact button spacing, readable text, focus-visible treatment, and a danger color for delete. Tighten only the header gap/padding while keeping the pencil at 44px under coarse-pointer rules.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `node --test tests/group-manager-interaction.test.mjs`

Expected: all tests PASS.

### Task 3: Verify and commit the implementation

**Files:**
- Verify: `modules/panel-group-manager.js`
- Verify: `style.css`
- Verify: `tests/group-manager-interaction.test.mjs`

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: a verified commit on `dev` without unrelated workspace files.

- [ ] **Step 1: Run all tracked tests**

Run in PowerShell:

```powershell
$tests = @(git ls-files | Where-Object { $_ -match '^tests/.+\.test\.mjs$' })
node --test $tests
```

Expected: exit code 0 and zero failing tests.

- [ ] **Step 2: Run project static checks**

Run: `npm run check`

Expected: import/export, cycles, residual references, and i18n checks all PASS.

- [ ] **Step 3: Validate the final diff**

Run: `git diff --check` and `git diff -- modules/panel-group-manager.js style.css tests/group-manager-interaction.test.mjs`.

Expected: no whitespace errors and only the approved mobile group-row changes.

- [ ] **Step 4: Commit only implementation files**

```powershell
git add -- modules/panel-group-manager.js style.css tests/group-manager-interaction.test.mjs
git commit -m "fix: improve mobile group name layout"
```

Expected: one implementation commit; user-owned `.gitignore` and unrelated untracked files remain untouched.
