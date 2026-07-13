import test from 'node:test';
import assert from 'node:assert/strict';

import { OrganizationCommandHistory } from '../../modules/core/organization-command-history.js';

function state(overrides = {}) {
    return {
        groupingManualOverrides: {},
        groupingTree: {},
        pendingCustomGroups: [],
        ...overrides,
    };
}

test('undo and redo return independent organization snapshots', () => {
    const history = new OrganizationCommandHistory();
    const before = state();
    const after = state({ groupingManualOverrides: { Preset: 'Writing' } });

    assert.equal(history.record({ label: 'move-preset', before, after }), true);
    assert.deepEqual(history.getStatus(), {
        canUndo: true,
        canRedo: false,
        undoLabel: 'move-preset',
        redoLabel: null,
    });

    const undo = history.undo(after);
    assert.equal(undo.ok, true);
    assert.deepEqual(undo.state, before);
    undo.state.groupingManualOverrides.changed = true;
    assert.deepEqual(history.redo(before).state, after, 'callers cannot mutate stored command snapshots');
});

test('new commands clear redo and no-op commands are ignored', () => {
    const history = new OrganizationCommandHistory();
    const before = state();
    const moved = state({ groupingTree: { child: 'parent' } });
    history.record({ label: 'move', before, after: moved });
    history.undo(moved);

    assert.equal(history.record({ label: 'no-op', before, after: structuredClone(before) }), false);
    assert.equal(history.getStatus().canRedo, true);

    const renamed = state({ groupingSeriesAliases: { child: 'Friendly' } });
    history.record({ label: 'rename', before, after: renamed });
    assert.equal(history.getStatus().canRedo, false);
    assert.equal(history.getStatus().undoLabel, 'rename');
});

test('conflicting external changes fail closed and clear stale commands', () => {
    const history = new OrganizationCommandHistory();
    const before = state({ groupingTree: { child: 'parent' } });
    const after = state({ groupingTree: { child: 'other-parent' } });
    history.record({ label: 'move-group', before, after });

    const conflict = history.undo(state({ groupingTree: { child: 'external-parent' } }));
    assert.deepEqual(conflict, { ok: false, reason: 'conflict' });
    assert.deepEqual(history.getStatus(), {
        canUndo: false,
        canRedo: false,
        undoLabel: null,
        redoLabel: null,
    });
});

test('unrelated organization fields do not invalidate a focused command', () => {
    const history = new OrganizationCommandHistory();
    const before = { groupingTree: { child: 'parent' } };
    const after = { groupingTree: { child: 'other-parent' } };
    history.record({ label: 'move-group', before, after });

    const current = {
        ...after,
        groupingSeriesAliases: { child: 'Changed elsewhere but unrelated' },
    };
    assert.equal(history.undo(current).ok, true);
});

test('history is bounded to the newest commands', () => {
    const history = new OrganizationCommandHistory({ limit: 2 });
    const a = state();
    const b = state({ groupingTree: { b: 'a' } });
    const c = state({ groupingTree: { c: 'b' } });
    const d = state({ groupingTree: { d: 'c' } });
    history.record({ label: 'one', before: a, after: b });
    history.record({ label: 'two', before: b, after: c });
    history.record({ label: 'three', before: c, after: d });

    assert.equal(history.undo(d).label, 'three');
    assert.equal(history.undo(c).label, 'two');
    assert.deepEqual(history.undo(b), { ok: false, reason: 'empty' });
});
