import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('all lifecycle entry points share the serialized readiness path', () => {
    assert.match(source, /function ensureRuntimeReady\(\)/);
    assert.match(source, /if \(_runtimeReadyPromise\) return _runtimeReadyPromise/);
    assert.match(source, /APP_INITIALIZED received'[\s\S]{0,120}ensureRuntimeReady\(\)/);
    assert.match(source, /APP_READY received'[\s\S]{0,120}ensureRuntimeReady\(\)/);
    assert.doesNotMatch(source, /Auto-save phase deferred because its storage\/takeover dependencies are not ready/);
});

test('startup aborts when required host compatibility is unavailable', () => {
    assert.match(source, /if \(!initCompatibility\(\)\) \{[\s\S]*?return;[\s\S]*?\}/);
    assert.doesNotMatch(source, /Compatibility check failed, extension may not work properly/);
});

test('disable and delete quiesce background history work', () => {
    assert.match(source, /teardownHistoryStore/);
    assert.match(source, /onDelete\(\)[\s\S]*?await teardownHistoryStore\(\)/);
    assert.match(source, /onDisable\(\)[\s\S]*?await teardownHistoryStore\(\)/);
});
