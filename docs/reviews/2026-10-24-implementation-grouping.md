# Grouping Implementation: 2026-10-24

## Design Supplement

This batch implements the accepted reliability design's canonical organization
contract. It does not change storage schemas, preset names, snapshot contents,
or existing override meanings. Existing overrides remain canonical automatic
group names; aliases are never inferred as membership during compatibility reads.

The resolved projection owns canonical keys, automatic names, alias labels,
collision resolution and exact preset membership. `groupSnapshotsBySeries`
returns a map indexed by canonical keys; `series` remains a display-label
compatibility field. History, native inventory and archived inventory are joined
by exact `(apiId, presetName)`. Missing native targets remain distinct history
targets. Renderers may filter/project these results but never relocate snapshots.

The existing parser and public grouping APIs remain. A small pure projection
module removes grouping/label resolution from the oversized grouping module,
and supplies canonical target lookup to manager commands. Search and current
filters consume the same projection, including manual membership and aliases.

Move destinations retain their CSS hook but become native buttons with canonical
data attributes. Menus mount inside their initiating native dialog (body fallback
outside a dialog), and restore focus only when an action has not deliberately
focused another control. No framework or package is added.

## Sequence

1. Preserve baseline results and add failing identity/filter/orphan regressions.
2. Extract the projection, fix canonical joins and manager mutations.
3. Add native control/menu ownership and focus regressions.
4. Run focused tests and report integration contracts to the coordinating agent.
5. Run the full shared gate and browser matrix after integration.

## Baseline

- Shared baseline reported by coordinator: 341 passing tests.
- Local focused baseline: 28/28 passing grouping, manager and menu tests.

## Red-Green Evidence

- `node --test tests/grouping-canonical-projection.test.mjs`: all five tests
  failed before implementation (display map keys, alias cascade, current filter,
  alias/manual membership search and orphan reassignment); all five pass after.
- Membership commands were first extracted preserving existing behavior.
  `node --test tests/core/group-membership.test.mjs` then failed both assertions
  (saved `Creative` instead of `Story`, retained override after group removal).
  Canonical command lookup makes both pass.
- `node --test tests/context-menu-owner.test.mjs`: both owner and action-focus
  assertions failed against the original controller, then passed after the menu
  moved inside its initiating dialog and gained conditional focus restoration.
- Combined grouping/manager/menu focused run: 27/27 passing.
- `npm run check`: passed at this intermediate shared checkout.
- Replaced the old display-key resolver and its tests with canonical history
  projection coverage; no production caller remains on the old representation.

## Non-Goals And Remaining Work

The coordinator owns batch integration and i18n. Follow-on work by this implementer
completed canonical native/tree expansion and group-manager CSS ownership; see
the popup-ownership and group-styles supplements for evidence.
No commits or pushes are performed by this implementer. Full browser and
independent review results must be recorded by the coordinating workflow.
