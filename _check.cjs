// i18n 完整性校验
const fs = require('fs');
const path = require('path');

const en = JSON.parse(fs.readFileSync('i18n/en-us.json', 'utf8'));
const zh = JSON.parse(fs.readFileSync('i18n/zh-cn.json', 'utf8'));

const enKeys = new Set(Object.keys(en));
const zhKeys = new Set(Object.keys(zh));

console.log(`en-us keys: ${enKeys.size}`);
console.log(`zh-cn keys: ${zhKeys.size}`);

let mismatch = 0;
for (const k of enKeys) {
    if (!zhKeys.has(k)) {
        console.log(`  [missing in zh-cn] ${k}`);
        mismatch++;
    }
}
for (const k of zhKeys) {
    if (!enKeys.has(k)) {
        console.log(`  [missing in en-us] ${k}`);
        mismatch++;
    }
}

// 找代码里实际用到的 t() 调用
const SOURCE_DIRS = ['modules', '.'];
const SOURCE_FILES = [];
function collect(dir) {
    const items = fs.readdirSync(dir);
    for (const it of items) {
        const fp = path.join(dir, it);
        const st = fs.statSync(fp);
        if (st.isDirectory() && !['node_modules', 'docs', 'i18n', '.git'].includes(it)) {
            collect(fp);
        } else if (it.endsWith('.js') && !it.startsWith('_')) {
            SOURCE_FILES.push(fp);
        }
    }
}
collect('modules');
SOURCE_FILES.push('index.js');

const usedKeys = new Set();
const tRegex = /\bt\(\s*(['"`])([^'"`]+)\1/g;
for (const f of SOURCE_FILES) {
    const text = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = tRegex.exec(text))) {
        usedKeys.add(m[2]);
    }
}

console.log(`\nt() calls found: ${usedKeys.size}`);
let undefinedKeys = 0;
for (const k of usedKeys) {
    if (!enKeys.has(k)) {
        console.log(`  [USED BUT NOT DEFINED in en-us] "${k}"`);
        undefinedKeys++;
    }
}

console.log('\n' + (mismatch === 0 && undefinedKeys === 0 ? '✓ ALL KEYS OK' : `✗ Issues: ${mismatch} mismatched, ${undefinedKeys} undefined`));
process.exit(mismatch + undefinedKeys === 0 ? 0 : 1);
