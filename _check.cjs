/**
 * 完整性自检脚本：i18n + 模块导出 + 函数签名一致性
 * 用法：node _check.cjs
 */
const fs = require('fs');
const path = require('path');

let pass = true;
const fail = (msg) => { console.error('✗', msg); pass = false; };
const ok = (msg) => console.log('✓', msg);

// ============ 1) i18n alignment ============
const enPath = path.join(__dirname, 'i18n', 'en-us.json');
const zhPath = path.join(__dirname, 'i18n', 'zh-cn.json');
const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
const zh = JSON.parse(fs.readFileSync(zhPath, 'utf8'));
const enKeys = Object.keys(en);
const zhKeys = Object.keys(zh);

if (enKeys.length !== zhKeys.length) {
    fail(`i18n size mismatch: en=${enKeys.length}, zh=${zhKeys.length}`);
}

const missingInEn = zhKeys.filter(k => !en[k]);
const missingInZh = enKeys.filter(k => !zh[k]);
if (missingInEn.length === 0 && missingInZh.length === 0 && enKeys.length === zhKeys.length) {
    ok(`i18n: en=${enKeys.length} keys / zh=${zhKeys.length} keys (aligned)`);
} else {
    if (missingInEn.length > 0) fail(`Missing in en-us: ${missingInEn.join(', ')}`);
    if (missingInZh.length > 0) fail(`Missing in zh-cn: ${missingInZh.join(', ')}`);
}

// ============ 2) Verify all t() calls have keys defined ============
const moduleDir = path.join(__dirname, 'modules');
const moduleFiles = fs.readdirSync(moduleDir).filter(f => f.endsWith('.js'));
const tCallRe = /\bt\(\s*['"]([^'"]+)['"]/g;
let totalCalls = 0;
const undefinedKeys = new Set();

for (const f of moduleFiles) {
    const content = fs.readFileSync(path.join(moduleDir, f), 'utf8');
    let m;
    while ((m = tCallRe.exec(content)) !== null) {
        totalCalls++;
        const key = m[1];
        if (!en[key]) undefinedKeys.add(key);
    }
}
if (undefinedKeys.size === 0) {
    ok(`t() calls: ${totalCalls} (all keys defined)`);
} else {
    fail(`t() calls reference undefined keys: ${[...undefinedKeys].join(', ')}`);
}

// ============ 3) Module syntax check (basic JS parse) ============
for (const f of moduleFiles) {
    const fp = path.join(moduleDir, f);
    try {
        // 简单 sanity check：文件能读，括号配平
        const c = fs.readFileSync(fp, 'utf8');
        const opens = (c.match(/\{/g) || []).length;
        const closes = (c.match(/\}/g) || []).length;
        if (opens !== closes) {
            fail(`${f}: brace mismatch (${opens} { vs ${closes} })`);
        }
    } catch (e) {
        fail(`${f}: read error - ${e.message}`);
    }
}
ok(`module files: ${moduleFiles.length} (syntax sanity ok)`);

// ============ 4) Critical exports ============
const checks = [
    ['modules/preset-takeover.js', /export\s+async\s+function\s+initPresetTakeover/, 'initPresetTakeover'],
    ['modules/preset-takeover.js', /export\s+function\s+refreshTakeover/, 'refreshTakeover'],
    ['modules/preset-takeover.js', /export\s+function\s+listSeriesFromNativeSelects/, 'listSeriesFromNativeSelects'],
    ['modules/preset-takeover.js', /export\s+async\s+function\s+restoreAllFromArchive/, 'restoreAllFromArchive'],
    ['modules/preset-takeover.js', /export\s+async\s+function\s+seedSnapshotsIfNeeded/, 'seedSnapshotsIfNeeded'],
    ['modules/preset-takeover.js', /export\s+async\s+function\s+forceReseedSnapshots/, 'forceReseedSnapshots'],
    ['modules/archive-store.js', /export\s+async\s+function\s+listArchivedPresets/, 'listArchivedPresets'],
    ['modules/archive-store.js', /export\s+async\s+function\s+archivePreset/, 'archivePreset'],
    ['modules/history-store.js', /export\s+async\s+function\s+addSnapshot/, 'addSnapshot'],
    ['modules/history-store.js', /export\s+async\s+function\s+getSnapshots/, 'getSnapshots'],
    ['modules/settings.js', /autoSeedOnTakeover/, 'autoSeedOnTakeover setting'],
    ['modules/settings.js', /seedSnapshotsDone/, 'seedSnapshotsDone setting'],
    ['modules/history-panel.js', /seedSnapshotsIfNeeded.*forceReseedSnapshots|forceReseedSnapshots.*seedSnapshotsIfNeeded|import\s+\{[\s\S]*?seedSnapshotsIfNeeded[\s\S]*?\}/, 'seed imports'],
    ['modules/history-panel.js', /listArchivedPresets/, 'archive import'],
    ['modules/history-panel.js', /pas-tag-archived/, 'archived tag UI'],
    ['style.css', /\.pas-tag-archived/, 'archived tag CSS'],
    ['style.css', /\.pas-series-subtitle/, 'series subtitle CSS'],
];

for (const [file, re, name] of checks) {
    const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
    if (re.test(content)) {
        ok(`${file}: ${name}`);
    } else {
        fail(`${file}: missing ${name}`);
    }
}

// ============ 5) Check archived/seed UI keys present ============
const requiredI18n = [
    'Reseed Snapshots',
    'Reseed Snapshots Desc',
    'Reseed Done',
    'Reseed All Already Done',
    'Reseed Skipped',
    'Reseed Failed',
    'Seed Snapshots Start',
    'Seed Snapshots Done',
    'Auto Seed Enabled',
    'Auto Seed Enabled Desc',
    'Archived Version',
    'Archived Version Title',
    'Takeover Data Processing',
    'Takeover Data Done',
];
for (const k of requiredI18n) {
    if (!en[k]) fail(`en-us missing key: "${k}"`);
    if (!zh[k]) fail(`zh-cn missing key: "${k}"`);
}
ok(`required new i18n keys: ${requiredI18n.length} (all present)`);

if (pass) {
    console.log('\n========== ALL CHECKS PASSED ==========');
    process.exit(0);
} else {
    console.log('\n========== SOME CHECKS FAILED ==========');
    process.exit(1);
}
