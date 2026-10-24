import assert from 'node:assert/strict';
import { test } from 'node:test';

test('restored logs are bounded, validated, detached and immutable', async () => {
    const records = Array.from({ length: 300 }, (_, index) => ({
        seq: index + 1, ts: index, level: 'warn', message: `entry ${index}`, unexpected: 'not retained',
    }));
    records.push({ seq: 301, ts: 301, level: 'invalid', message: 'invalid' });
    records.push({ seq: 302, ts: 302, level: 'warn', message: { not: 'text' } });
    globalThis.localStorage = {
        getItem: key => key === 'pas-log-buffer' ? JSON.stringify(records) : null,
        setItem() {},
    };
    const { logger } = await import('../modules/logger.js?restore-validation');
    const logs = logger.getLogs({ limit: 1000 });
    assert.ok(logs.length <= 200);
    assert.ok(logs.every(entry => typeof entry.message === 'string' && entry.level === 'warn'));
    assert.ok(logs.every(entry => !Object.hasOwn(entry, 'unexpected')));
    assert.throws(() => { logs[0].message = 'tampered'; }, TypeError);
    delete globalThis.localStorage;
});
