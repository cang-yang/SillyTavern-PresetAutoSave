import { stableStringify } from './value-utils.js';

function clone(value) {
    return structuredClone(value);
}

function keysFor(command) {
    return [...new Set([
        ...Object.keys(command.before || {}),
        ...Object.keys(command.after || {}),
    ])].sort();
}

function project(state, keys) {
    const projected = {};
    for (const key of keys) projected[key] = state?.[key];
    return projected;
}

function same(left, right) {
    return stableStringify(left) === stableStringify(right);
}

export class OrganizationCommandHistory {
    constructor({ limit = 25 } = {}) {
        if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Organization history limit must be positive');
        this.limit = limit;
        this.undoStack = [];
        this.redoStack = [];
    }

    record({ label, before, after } = {}) {
        if (typeof label !== 'string' || label.trim() === '') throw new TypeError('Organization command label is required');
        if (!before || typeof before !== 'object' || !after || typeof after !== 'object') {
            throw new TypeError('Organization command snapshots are required');
        }
        const command = { label, before: clone(before), after: clone(after) };
        const keys = keysFor(command);
        if (keys.length === 0 || same(project(command.before, keys), project(command.after, keys))) return false;
        command.keys = keys;
        this.undoStack.push(command);
        if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
        this.redoStack.length = 0;
        return true;
    }

    undo(currentState) {
        const command = this.undoStack.at(-1);
        if (!command) return { ok: false, reason: 'empty' };
        if (!same(project(currentState, command.keys), project(command.after, command.keys))) {
            this.clear();
            return { ok: false, reason: 'conflict' };
        }
        this.undoStack.pop();
        this.redoStack.push(command);
        return { ok: true, label: command.label, state: clone(command.before) };
    }

    redo(currentState) {
        const command = this.redoStack.at(-1);
        if (!command) return { ok: false, reason: 'empty' };
        if (!same(project(currentState, command.keys), project(command.before, command.keys))) {
            this.clear();
            return { ok: false, reason: 'conflict' };
        }
        this.redoStack.pop();
        this.undoStack.push(command);
        return { ok: true, label: command.label, state: clone(command.after) };
    }

    getStatus() {
        return {
            canUndo: this.undoStack.length > 0,
            canRedo: this.redoStack.length > 0,
            undoLabel: this.undoStack.at(-1)?.label || null,
            redoLabel: this.redoStack.at(-1)?.label || null,
        };
    }

    clear() {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
    }
}
