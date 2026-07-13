const API_ID = 'openai';

function prompt(identifier, name, content, role = 'system') {
    return { identifier, name, content, role, system_prompt: role === 'system', marker: false };
}

function order(prompts, disabled = new Set()) {
    return [{ character_id: 100001, order: prompts.map(item => ({
        identifier: item.identifier,
        enabled: !disabled.has(item.identifier),
    })) }];
}

function presetFor({ seriesIndex, versionIndex, revisionIndex }) {
    const basePrompts = [
        prompt('main', '核心系统提示', `你是第 ${seriesIndex + 1} 组场景的可靠助手。`, 'system'),
        prompt('style', '写作风格', '保持自然、清楚，并避免机械重复。', 'system'),
        prompt('jailbreak', '补充约束', '只在确有必要时使用补充约束。', 'system'),
    ];
    const prompts = revisionIndex >= 2
        ? [...basePrompts, prompt('review', '质量复核', '回答前检查事实、格式和上下文连续性。')]
        : basePrompts;
    if (revisionIndex >= 1) prompts[1] = { ...prompts[1], content: `保持自然、清楚；当前修订 ${revisionIndex + 1} 强调具体细节。` };

    return {
        temperature: Number((0.55 + versionIndex * 0.08 + revisionIndex * 0.02).toFixed(2)),
        top_p: Number((0.9 - revisionIndex * 0.01).toFixed(2)),
        max_tokens: 2048 + revisionIndex * 256,
        frequency_penalty: revisionIndex % 2 ? 0.15 : 0,
        presence_penalty: versionIndex ? 0.1 : 0,
        stream_openai: true,
        prompts,
        prompt_order: order(prompts, revisionIndex >= 3 ? new Set(['jailbreak']) : new Set()),
    };
}

export function buildVisualScenario({ revisionsPerVersion = 5 } = {}) {
    const series = [
        { key: '星海导航', versions: ['V1.0', 'V1.1', 'V2.0 Beta'] },
        { key: '星海导航 · 创作', versions: ['V1.0', 'V1.2'] },
        { key: '星海导航 · 创作 · 长篇', versions: ['V3.0', 'V3.1'] },
        { key: '极长名称压力测试：中英文 Mixed_Name_With_Punctuation_🧭_<script>_以及不会轻易换行的连续字符', versions: ['V2026.06.19', 'V2026.06.20'] },
    ];
    const records = [];
    const overrides = {};

    series.forEach((entry, seriesIndex) => {
        entry.versions.forEach((version, versionIndex) => {
            const presetName = `${entry.key} ${version}`;
            overrides[presetName] = entry.key;
            for (let revisionIndex = 0; revisionIndex < revisionsPerVersion; revisionIndex++) {
                records.push({
                    apiId: API_ID,
                    presetName,
                    trigger: revisionIndex === 0 ? 'switch_guard' : revisionIndex === 4 ? 'manual' : 'auto',
                    pinned: revisionIndex === 1 && versionIndex === 0,
                    label: revisionIndex === 4 ? `发布候选 · 修订 ${revisionIndex + 1}` : '',
                    preset: presetFor({ seriesIndex, versionIndex, revisionIndex }),
                });
            }
        });
    });

    return {
        records,
        overrides,
        tree: {
            '星海导航 · 创作': '星海导航',
            '星海导航 · 创作 · 长篇': '星海导航 · 创作',
        },
    };
}

export function buildPerformanceScenario({ presetCount = 25, revisionsPerPreset = 20 } = {}) {
    const records = [];
    const overrides = {};
    for (let presetIndex = 0; presetIndex < presetCount; presetIndex++) {
        const seriesIndex = Math.floor(presetIndex / 5);
        const series = `性能场景 ${String(seriesIndex + 1).padStart(2, '0')}`;
        const presetName = `${series} V${seriesIndex + 1}.${presetIndex % 5}`;
        overrides[presetName] = series;
        for (let revisionIndex = 0; revisionIndex < revisionsPerPreset; revisionIndex++) {
            records.push({
                apiId: API_ID,
                presetName,
                trigger: revisionIndex % 11 === 0 ? 'manual' : 'auto',
                pinned: revisionIndex === 0 && presetIndex % 4 === 0,
                label: '',
                preset: presetFor({ seriesIndex, versionIndex: presetIndex % 5, revisionIndex }),
            });
        }
    }
    return { records, overrides, tree: {} };
}
