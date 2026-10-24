import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizePreset } from '../../modules/core/preset-schema.js';
import { sanitizePresetForExport } from '../../modules/compatibility.js';
import { validateHistoryBackup } from '../../modules/core/history-backup.js';
import { computeChangeSummary, hashPreset } from '../../modules/history-store.js';
import { comparePresetStates } from '../../modules/core/preset-comparison.js';

test('capture and backup share aliases and exclusions while retaining unreferenced custom prompts', () => {
    const raw = {
        temp_openai: '0.8', bias_preset_selected: 'Default',
        prompts: [{ identifier: 'custom-local', content: 'user text' }],
    };
    const expected = { temperature: 0.8, prompts: [{ identifier: 'custom-local', content: 'user text' }] };
    const incoming = validateHistoryBackup({ version: 1, data: {
        'openai::Demo': [{ id: 's', timestamp: 1, preset: raw }],
    } }).data.get('openai::Demo')[0].preset;
    assert.deepEqual(canonicalizePreset(raw).canonical, expected);
    assert.deepEqual(sanitizePresetForExport(raw), expected);
    assert.deepEqual(incoming, expected);
});

test('identical character-specific enabled states produce no friendly changes', () => {
    const preset = { prompts: [{ identifier: 'main', content: 'x' }], prompt_order: [
        { character_id: 1, order: [{ identifier: 'main', enabled: true }] },
        { character_id: 2, order: [{ identifier: 'main', enabled: false }] },
    ] };
    const summary = computeChangeSummary(preset, structuredClone(preset));
    assert.deepEqual(summary.sections, []);
    assert.equal(summary.unchanged, true);
});

test('definition permutations have an explainable canonical difference', () => {
    const before = { prompts: [{ identifier: 'main', content: 'x' }, { identifier: 'jailbreak', content: 'y' }] };
    const after = { prompts: [...before.prompts].reverse() };
    assert.notEqual(hashPreset(before), hashPreset(after));
    const summary = computeChangeSummary(before, after);
    assert.equal(summary.unchanged, false);
    assert.ok(summary.rawChangedPaths.length);
    assert.ok(summary.sections.length);
});

test('new prompt fields and non-first order groups receive visible explanations', () => {
    const before = { prompts: [{ identifier: 'main', content: 'x' }], prompt_order: [
        { character_id: 1, order: [{ identifier: 'main', enabled: true }] },
        { character_id: 2, order: [{ identifier: 'main', enabled: false }] },
    ] };
    const after = structuredClone(before);
    after.prompts[0].injection_trigger = ['normal'];
    after.prompt_order[1].order[0].enabled = true;
    const summary = computeChangeSummary(before, after);
    assert.ok(summary.sections.some(section => section.kind === 'prompt-edit'
        && section.items.some(item => item.fields.some(field => field.key === 'injection_trigger'))));
    assert.equal(summary.counts.promptToggledOn, 1);
});

test('every changed extension field remains present beyond the compact summary limit', () => {
    const before = { extensions: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, 0])) };
    const after = { extensions: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, 1])) };
    const comparison = comparePresetStates(before, after);
    assert.equal(comparison.summary.sections.find(section => section.kind === 'field').items.length, 20);
    assert.equal(comparison.changeSet.changed[0].rawBefore, 0);
    assert.equal(comparison.changeSet.changed[0].rawAfter, 1);
});

test('order paths identify character groups and unnamed prompts keep identity separate from label', () => {
    const before = { prompts: [{ identifier: 'opaque-id', content: 'x' }], prompt_order: [
        { character_id: 7, order: [{ identifier: 'opaque-id', enabled: false }] },
    ] };
    const after = structuredClone(before);
    after.prompt_order[0].order[0].enabled = true;
    const comparison = comparePresetStates(before, after);
    assert.deepEqual(comparison.summary.rawChangedPaths, ['prompt_order[character:7].order[0].enabled']);
    assert.equal(comparison.summary.sections[0].items[0].name, '');
    assert.equal(comparison.summary.sections[0].items[0].identifier, 'opaque-id');
});

test('duplicate or missing prompt identifiers fall back to positional differences without losing content', () => {
    for (const prompts of [
        [{ identifier: 'same', content: 'a' }, { identifier: 'same', content: 'b' }],
        [null, { content: 'b' }],
    ]) {
        const after = structuredClone(prompts);
        after[1].content = 'changed';
        const comparison = comparePresetStates({ prompts }, { prompts: after });
        assert.ok(comparison.changeSet.meaningful);
        assert.ok(comparison.summary.sections.length);
        assert.deepEqual(comparison.after.prompts, after);
    }
});

test('canonical JSON rejects cycles and nonplain payloads without rewriting user-owned prototypes', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalizePreset({ extensions: cyclic }), /circular/);
    assert.throws(() => canonicalizePreset(new Date()), /plain object/);
    const value = JSON.parse('{"extensions":{"__proto__":{"sentinel":"kept"}}}');
    assert.deepEqual(canonicalizePreset(value).canonical, value);
    assert.equal({}.sentinel, undefined);
});

test('credential-key variants are excluded without changing prompt strings or token counters', () => {
    const preset = {
        api_key: 'secret-root', apiKey: 'secret-camel', access_token: 'secret-access',
        token: 'secret-token', password: 'secret-password', max_tokens: 100, token_count: 20,
        prompts: [{ identifier: 'password', name: 'password', content: 'api_key=user example' }],
        extensions: { provider: { api_key: 'secret-extension', refreshToken: 'secret-refresh',
            client_secret: 'secret-client', max_tokens: 42, template: 'password=example' } },
    };
    const { canonical, ignored } = canonicalizePreset(preset, { apiId: 'textgenerationwebui' });
    const serialized = JSON.stringify(canonical);
    assert.equal(serialized.includes('secret-'), false);
    assert.equal(canonical.max_tokens, 100);
    assert.equal(canonical.extensions.provider.max_tokens, 42);
    assert.deepEqual(canonical.prompts, preset.prompts);
    assert.equal(canonical.extensions.provider.template, 'password=example');
    assert.ok(ignored.some(item => item.path === 'extensions.provider.api_key'));
    assert.equal(JSON.stringify(ignored).includes('secret-extension'), false);
});

test('individual preset export excludes connection aliases at root and in extension arrays', () => {
    const preset = {
        temperature: 0.7,
        apiKeyOpenAI: 'SYNTHETIC_CREDENTIAL_ROOT',
        customIncludeHeaders: 'Authorization: Bearer SYNTHETIC_CREDENTIAL_HEADER',
        prompts: [{ identifier: 'api_key_openai', name: 'password',
            content: 'custom_include_headers: Authorization literal example' }],
        extensions: { providers: [{ settings: {
            'api-key-openai': 'SYNTHETIC_CREDENTIAL_NESTED',
            customIncludeHeaders: ['Authorization: Bearer SYNTHETIC_CREDENTIAL_ARRAY'],
            proxyAuthorization: 'SYNTHETIC_CREDENTIAL_PROXY',
            api_key_claude: 'SYNTHETIC_CREDENTIAL_CLAUDE',
            max_tokens: 100, token_count: 5, token: 7,
            template: 'api_key_openai is an example field name',
        } }] },
    };
    const original = structuredClone(preset);
    for (const apiId of ['openai', 'textgenerationwebui']) {
        const result = sanitizePresetForExport(preset, { apiId });
        assert.equal(JSON.stringify(result).includes('SYNTHETIC_CREDENTIAL_'), false);
        assert.deepEqual(result.prompts, preset.prompts);
        assert.deepEqual(result.extensions.providers[0].settings, {
            max_tokens: 100, token_count: 5, token: 7,
            template: 'api_key_openai is an example field name',
        });
        const { ignored } = canonicalizePreset(preset, { apiId });
        assert.ok(ignored.some(item => item.path === 'extensions.providers[0].settings.customIncludeHeaders'));
        assert.equal(JSON.stringify(ignored).includes('SYNTHETIC_CREDENTIAL_'), false);
    }
    assert.deepEqual(preset, original);
});
