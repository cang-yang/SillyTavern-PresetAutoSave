import { SerialTaskQueue } from './serial-task-queue.js';

export function createHistorySeeding({ capturePreset, validatePreset = value => value, readHistory, writeSnapshot }) {
    const queue = new SerialTaskQueue();
    let closed = false;
    const blocked = new Set();
    const keyOf = target => JSON.stringify([target.apiId, target.presetName]);

    function seed(target, options = {}) {
        if (!target?.apiId || !target?.presetName) return Promise.resolve({ seeded: false });
        if (closed || blocked.has(keyOf(target))) return Promise.resolve({ seeded: false, reason: 'closed' });
        const identity = Object.freeze({ apiId: target.apiId, presetName: target.presetName });
        const supplied = Object.hasOwn(options, 'preset');
        if (supplied && options.verified !== true) {
            return Promise.resolve({ seeded: false, reason: 'unverified' });
        }
        const source = supplied ? options.preset : capturePreset(identity);
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
            return Promise.resolve({ seeded: false, reason: 'unavailable' });
        }
        const preset = structuredClone(validatePreset(source, identity));
        return queue.run(async () => {
            if (closed || blocked.has(keyOf(identity))) return { seeded: false, reason: 'closed' };
            const existing = await readHistory(identity);
            if (closed || blocked.has(keyOf(identity))) return { seeded: false, reason: 'closed' };
            if (existing?.length > 0) return { seeded: false, reason: 'existing' };
            const snapshot = await writeSnapshot(identity, preset);
            return { seeded: Boolean(snapshot) };
        });
    }

    return Object.freeze({
        seed,
        isClosed: () => closed,
        close: async () => { closed = true; await queue.whenIdle(); },
        cancelTarget: async target => { blocked.add(keyOf(target)); await queue.whenIdle(); },
        allowTarget: target => blocked.delete(keyOf(target)),
    });
}
