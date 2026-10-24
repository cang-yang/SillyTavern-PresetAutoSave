import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHistoryCatalog } from '../../modules/core/history-catalog.js';

const samples = 20;
const summary = values => {
    const ordered = [...values].sort((a, b) => a - b);
    return { p50: ordered[Math.floor(ordered.length * 0.5)],
        p95: ordered[Math.ceil(ordered.length * 0.95) - 1], max: ordered.at(-1) };
};
async function measure(operation) {
    for (let index = 0; index < 3; index++) await operation();
    const values = [];
    for (let index = 0; index < samples; index++) {
        const start = performance.now();
        await operation();
        values.push(performance.now() - start);
    }
    return summary(values);
}
const environment = { node: process.version, platform: process.platform,
    cpu: os.cpus()[0].model, samples, warmup: 3, store: 'structuredClone memory adapter' };
console.log(JSON.stringify({ environment }));
for (const count of [500, 5000]) {
    const storage = new Map();
    const catalog = createHistoryCatalog({ store: {
        async getItem(key) { return structuredClone(storage.get(key) ?? null); },
        async setItem(key, value) { storage.set(key, structuredClone(value)); },
    } });
    const buckets = new Map();
    for (let index = 0; index < count; index++) {
        const presetName = `Preset ${Math.floor(index / 10)}`;
        const key = `openai::${presetName}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ id: `snapshot-${index}`, apiId: 'openai', presetName,
            timestamp: index, hash: `${index}`, pinned: index % 20 === 0,
            summary: { sections: [], rawChangedPaths: ['temperature'] },
            preset: { temperature: 0.7, prompts: [{ identifier: 'main', content: 'x'.repeat(1000) }] } });
    }
    const coldStart = performance.now();
    await catalog.rebuild({ keys: [...buckets.keys()].sort((a, b) => a.localeCompare(b, 'en')),
        readBucket: async key => buckets.get(key) });
    const coldBuildMs = performance.now() - coldStart;
    const statusRead = await measure(() => {
        for (let index = 0; index < 100; index++) {
            if (catalog.readState) catalog.readState();
            else catalog.read();
        }
    });
    const summaryRead = await measure(() => catalog.read());
    const bucketUpdate = await measure(() => catalog.replaceBucket('openai', 'Preset 0',
        buckets.get('openai::Preset 0'), { includeSummaries: false }));
    console.log(JSON.stringify({ count, coldBuildMs, statusRead100Ms: statusRead,
        summaryReadMs: summaryRead, bucketUpdateMs: bucketUpdate }));
}
