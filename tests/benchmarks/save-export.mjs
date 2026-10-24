import assert from 'node:assert/strict';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import { requireCanonicalPreset, hashCanonicalPreset } from '../../modules/core/preset-schema.js';
import { stableStringify } from '../../modules/core/value-utils.js';
import { createHistoryBackup } from '../../modules/core/history-backup.js';
import { enrichSnapshotList } from '../../modules/core/history-schema.js';
import { SaveCoordinator } from '../../modules/core/save-coordinator.js';
import { commitPresetSave } from '../../modules/core/save-transaction.js';
import { createPresetSwitchConvergence } from '../../modules/core/preset-switch-convergence.js';

const samples = 20;
const warmup = 3;
const round = number => Number(number.toFixed(3));
const summary = values => {
    const ordered = [...values].sort((left, right) => left - right);
    return {
        p50: round(ordered[Math.ceil(ordered.length * 0.5) - 1]),
        p95: round(ordered[Math.ceil(ordered.length * 0.95) - 1]),
        max: round(ordered.at(-1)),
    };
};
const output = value => console.log(JSON.stringify(value));
const presetFixture = bytes => ({
    temperature: 0.7, top_p: 0.9, frequency_penalty: 0, presence_penalty: 0,
    openai_max_tokens: 1024,
    prompts: [{ identifier: 'main', name: 'Main', role: 'system', enabled: true,
        content: 'synthetic benchmark text '.repeat(Math.ceil(bytes / 25)).slice(0, bytes) }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
});
const capture = preset => {
    const canonical = requireCanonicalPreset(structuredClone(preset), { apiId: 'openai' });
    return {
        apiId: 'openai', presetName: 'Synthetic', preset: canonical,
        canonicalContent: stableStringify(canonical),
        newHash: hashCanonicalPreset(canonical, { apiId: 'openai' }),
        quickFingerprint: JSON.stringify(preset), coalesce: false,
    };
};

async function measure(name, operation, dimensions = {}) {
    for (let index = 0; index < warmup; index++) await operation();
    const values = { wallMs: [], processCpuMs: [], heapDeltaMiB: [] };
    for (let index = 0; index < samples; index++) {
        await yieldTurn();
        globalThis.gc?.();
        const heapBefore = process.memoryUsage().heapUsed;
        const cpuBefore = process.cpuUsage();
        const start = performance.now();
        await operation();
        values.wallMs.push(performance.now() - start);
        const cpu = process.cpuUsage(cpuBefore);
        values.processCpuMs.push((cpu.user + cpu.system) / 1000);
        values.heapDeltaMiB.push((process.memoryUsage().heapUsed - heapBefore) / 1024 ** 2);
    }
    output({ name, ...dimensions, ...Object.fromEntries(Object.entries(values)
        .map(([key, value]) => [key, summary(value)])) });
}

output({ environment: {
    node: process.version, platform: `${process.platform} ${os.release()}`, arch: process.arch,
    cpu: os.cpus()[0].model, logicalCpus: os.cpus().length,
    totalMemoryGiB: round(os.totalmem() / 1024 ** 3), samples, warmup,
    gcBeforeSamples: typeof globalThis.gc === 'function',
    storage: 'synthetic structuredClone memory adapter; no user data or host I/O',
    timing: 'wall includes await; CPU is process-wide; heap delta is not peak or retained memory',
} });

for (const promptBytes of [4096, 1024 ** 2]) {
    const source = presetFixture(promptBytes);
    const request = capture(source);
    await measure('canonical-capture', () => {
        const captured = capture(source);
        assert.equal(captured.preset.prompts[0].content.length, promptBytes);
    }, { promptBytes });
    await measure('serialized-memory-commit', async () => {
        let persisted = null;
        let history = null;
        const coordinator = new SaveCoordinator({
            worker: item => commitPresetSave(item, {
                persistPreset: async value => { persisted = structuredClone(value.preset); },
                syncMemory: async value => { structuredClone(value.preset); return true; },
                commitHistory: async value => {
                    history = enrichSnapshotList([{
                        id: 'synthetic-commit', apiId: value.apiId, presetName: value.presetName,
                        timestamp: 1, hash: value.newHash, trigger: 'auto', pinned: false,
                        preset: structuredClone(value.preset),
                    }]);
                    return history[0];
                },
            }),
        });
        assert.equal((await coordinator.enqueue(request)).status, 'committed');
        assert.equal(persisted.prompts[0].content.length, promptBytes);
        assert.equal(history.length, 1);
        coordinator.close();
    }, { promptBytes });
}

const queueWait = [];
const hostDelayMs = 15;
await measure('queue-with-controlled-host-latency', async () => {
    const request = capture(presetFixture(4096));
    const submitted = new Map();
    const batchWaits = [];
    const coordinator = new SaveCoordinator({ worker: async item => {
        batchWaits.push(performance.now() - submitted.get(item.revision));
        await delay(hostDelayMs);
        return { id: item.revision };
    } });
    const promises = [];
    for (let revision = 0; revision < 8; revision++) {
        submitted.set(revision, performance.now());
        promises.push(coordinator.enqueue({ ...request, revision }));
    }
    assert.ok((await Promise.all(promises)).every(result => result.status === 'committed'));
    queueWait.push(batchWaits);
    coordinator.close();
}, { queuedRequests: 8, controlledHostDelayPerRequestMs: hostDelayMs });
output({ name: 'queue-wait-only', queuedRequests: 8,
    waitMs: summary(queueWait.slice(warmup).flat()),
    note: 'Wait is enqueue-to-worker-start; deliberate host latency is not CPU work.' });

const switchCallbacks = [];
await measure('unsettled-switch-timeout', async () => {
    let clock = 0;
    let pending = null;
    let timeoutCount = 0;
    let sampled = 0;
    const source = presetFixture(4096);
    const stored = capture({ ...source, temperature: 0.8 });
    const callbacks = [];
    const controller = createPresetSwitchConvergence({
        readCandidate: () => {
            sampled++;
            const live = capture(source);
            return { ...live, liveHash: live.newHash, storedHash: stored.newHash,
                storedCanonicalContent: stored.canonicalContent };
        },
        onSettled: () => assert.fail('Unsettled candidate must not converge'),
        onTimeout: () => { timeoutCount++; },
        now: () => clock,
        schedule: fn => { pending = fn; return 1; },
        cancel: () => { pending = null; },
        intervalMs: 80, timeoutMs: 10000,
    });
    controller.begin();
    while (pending) {
        clock += 80;
        const callback = pending;
        pending = null;
        const start = performance.now();
        await callback();
        callbacks.push(performance.now() - start);
    }
    assert.equal(sampled, 125);
    assert.equal(timeoutCount, 1);
    assert.equal(controller.isActive(), false);
    switchCallbacks.push(callbacks);
}, { promptBytes: 4096, virtualTimeoutMs: 10000, samplesPerSwitch: 125 });
output({ name: 'unsettled-switch-callback', callbackMs: summary(switchCallbacks.slice(warmup).flat()),
    note: 'Each actual callback measured; ten-second waiting is virtual, not wall elapsed.' });

for (const [snapshotCount, promptBytes] of [[500, 2048], [500, 10240], [5, 1024 ** 2]]) {
    const source = presetFixture(promptBytes);
    const data = { 'openai::Synthetic': Array.from({ length: snapshotCount }, (_, index) => ({
        id: `synthetic-export-${index}`, apiId: 'openai', presetName: 'Synthetic',
        timestamp: 1700000000000 + index, pinned: index % 25 === 0, trigger: 'auto',
        preset: { ...source, temperature: index / 1000 },
    })) };
    const blocks = [];
    let bytes = 0;
    await measure('history-backup-export', async () => {
        const probeStart = performance.now();
        const probe = yieldTurn().then(() => performance.now() - probeStart);
        const backup = createHistoryBackup(data, {}, () => 1700000000000);
        const serialized = JSON.stringify(backup);
        bytes = Buffer.byteLength(serialized);
        assert.equal(backup.data['openai::Synthetic'].length, snapshotCount);
        blocks.push(await probe);
    }, { snapshotCount, promptBytes });
    output({ name: 'history-backup-export-blocking', snapshotCount, promptBytes, outputBytes: bytes,
        nextTurnDelayMs: summary(blocks.slice(warmup)),
        note: 'Explicit export synchronous work plus scheduler delay; not a browser Long Tasks observation.' });
}
