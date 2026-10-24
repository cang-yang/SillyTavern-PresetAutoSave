import { SerialTaskQueue } from './serial-task-queue.js';

export function createPresetDeletionCommand({
    runHostDeletion, clearHistory, removeArchive, isCurrentTarget, notifyHost = () => {},
}) {
    const queue = new SerialTaskQueue();
    return target => {
        const captured = { apiId: target?.apiId, presetName: target?.presetName };
        if (!captured.apiId || !captured.presetName) {
            return Promise.resolve({ status: 'failed', target: captured, stage: 'target' });
        }
        return queue.run(async () => {
            let stage = 'host';
            let hostDeleted = false;
            try {
                if (isCurrentTarget(captured)) return { status: 'protected', target: captured };
                const result = await runHostDeletion(captured, async () => {
                    hostDeleted = true;
                    // Cleanup remains inside the writer barrier so a recreated target is not erased.
                    try { await notifyHost(captured); } catch (_) {}
                    stage = 'history';
                    await clearHistory(captured);
                    stage = 'archive';
                    await removeArchive(captured);
                });
                if (result.status === 'committed' && result.deleted === true) {
                    return { status: 'committed', target: captured };
                }
                return {
                    status: result.deleted ? 'partial' : result.status === 'protected' ? 'protected' : 'failed',
                    target: captured, stage, error: result.error,
                };
            } catch (error) {
                return { status: hostDeleted ? 'partial' : 'failed', target: captured, stage, error };
            }
        });
    };
}
