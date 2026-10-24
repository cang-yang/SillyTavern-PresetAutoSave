import { createHistorySeeding } from './core/history-seeding.js';
import { readPresetInventory } from './host/preset-inventory.js';
import { getCurrentApiId, getPresetSnapshot, toast, t } from './compatibility.js';
import { getSnapshots, addSnapshot, TRIGGER } from './history-store.js';
import { getSettings, updateSetting } from './settings.js';
import { logger } from './logger.js';
import { requireCanonicalPreset } from './core/preset-schema.js';

function createController() {
    return createHistorySeeding({
        capturePreset: target => getPresetSnapshot(target.presetName, { apiId: target.apiId }),
        validatePreset: (preset, target) => requireCanonicalPreset(preset, { apiId: target.apiId }),
        readHistory: target => getSnapshots(target.apiId, target.presetName),
        writeSnapshot: (target, preset) => addSnapshot(target.presetName, target.apiId, preset, TRIGGER.MANUAL),
    });
}

let controller = createController();
let bulkOperation = null;

export function initHistorySeeding() {
    if (controller.isClosed()) controller = createController();
}

export async function teardownHistorySeeding() {
    await controller.close();
    if (bulkOperation) await bulkOperation;
}

export function cancelPresetSeeding(target) { return controller.cancelTarget(target); }
export function allowPresetSeeding(target) { controller.allowTarget(target); }

export async function seedSnapshotForPreset(presetName, apiId, options = {}) {
    try {
        return await controller.seed({ apiId: apiId || getCurrentApiId(), presetName }, options);
    } catch (error) {
        try { logger.debug('Initial snapshot failed:', { apiId, presetName, code: error?.name }); } catch (_) {}
        return { seeded: false, reason: 'failed' };
    }
}

export function seedSnapshotsIfNeeded({ force = false, silent = false } = {}) {
    if (bulkOperation) return Promise.resolve({ skipped: true });
    const settings = getSettings();
    if (controller.isClosed() || !settings.enabled || !settings.groupingEnabled
        || (!force && (!settings.groupingFirstScanDone || !settings.autoSeedOnTakeover))) {
        return Promise.resolve({ skipped: true });
    }
    const owner = controller;
    const targets = readPresetInventory({ apiId: getCurrentApiId() });
    const operation = (async () => {
        const result = { added: 0, skipped: 0, failed: 0, total: targets.length };
        if (!silent) {
            try { toast.info(t('Seed Snapshots Start', { count: targets.length })); } catch (_) {}
        }
        for (const target of targets) {
            if (owner.isClosed()) break;
            try {
                const seeded = await owner.seed(target);
                if (seeded.seeded) result.added++;
                else if (seeded.reason === 'existing') result.skipped++;
                else if (seeded.reason !== 'closed') result.failed++;
            } catch (_) { result.failed++; }
            if ((result.added + result.skipped + result.failed) % 5 === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        if (!owner.isClosed() && result.failed === 0 && targets.length > 0) {
            updateSetting('seedSnapshotsDone', true);
        }
        if (!silent && result.added > 0) {
            try { toast.success(t('Seed Snapshots Done', result)); } catch (_) {}
        }
        return result;
    })();
    bulkOperation = operation;
    operation.finally(() => {
        if (bulkOperation === operation) bulkOperation = null;
    }).catch(() => {});
    return operation;
}

export function forceReseedSnapshots() {
    return seedSnapshotsIfNeeded({ force: true, silent: false });
}
