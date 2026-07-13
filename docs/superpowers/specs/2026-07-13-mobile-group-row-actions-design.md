# Mobile Group Row Actions Design

## Goal

Make group names substantially easier to read on phones without removing access to infrequent group-management actions.

## Problem

The current compact group header contains a folder icon, optional nesting handle, group name, rename button, preset count, overflow menu, and disclosure chevron. On a narrow touch viewport, the fixed-width controls and their gaps consume most of the row, so the group name truncates prematurely.

The overflow button also produces no useful visible feedback in the reported mobile environment. Although its implementation contains real actions—create subgroup, rename, restore automatic name, and delete group—leaving it in the header wastes scarce space and makes those actions feel broken.

## Approved Interaction

### Compact/mobile layouts

- Remove the overflow button from the group header.
- Keep the inline rename button because its pencil affordance is direct and familiar.
- Keep the preset count and disclosure chevron so users can understand and open the group.
- When a group is expanded, show a compact action row after its preset list.
- Put only applicable secondary actions in that row:
  - Create subgroup when nesting is enabled and the depth limit permits it.
  - Restore automatic name when the group has a custom display name.
  - Delete group when deletion is valid for that group.
- Do not duplicate rename in the mobile action row because the header pencil already provides it.
- Each action must have a readable label and a touch target of at least 44 pixels.

### Desktop/fine-pointer layouts

- Keep the existing overflow menu and its current actions.
- Do not show the mobile action row.
- Preserve existing inline rename, expand/collapse, drag-and-drop, and keyboard behavior.

## Responsive Layout

- Treat the group name as the primary flexible content: `min-width: 0` and `flex: 1 1 auto`.
- Keep only essential controls fixed-width in the compact header.
- Reduce compact-only gaps and padding where this does not reduce touch target size.
- Hide the overflow button through a compact viewport rule; the mobile action row uses the inverse rule.
- Nested groups retain their indentation and relationship indicator, but the name still receives the remaining width first.

## Behavior and Accessibility

- The mobile actions call the same existing group-operation functions as the desktop menu, so behavior and validation stay consistent.
- Buttons use semantic `button` elements, visible text labels, icons as secondary cues, and existing translated strings.
- Destructive deletion retains its existing confirmation flow.
- Disabled depth-limit behavior remains understandable and cannot be activated.
- Header expansion ignores clicks originating from any action button or inline name editor.

## Testing

- Add a regression test that confirms compact CSS hides the group overflow button and exposes the mobile action row.
- Confirm the rendered group markup contains applicable mobile actions without duplicating rename.
- Confirm each mobile action is wired to the same handlers used by the desktop menu.
- Run the focused group-manager tests, all tracked tests, static checks, and whitespace validation.

## Non-goals

- Redesigning preset-row actions.
- Changing group data identity, aliases, nesting rules, or deletion semantics.
- Introducing swipe or long-press gestures, which would hide functionality and reduce discoverability.
