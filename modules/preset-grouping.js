/**
 * SillyTavern Preset Auto Save - Preset Grouping
 * 预设分组（系列识别）模块
 *
 * 职责:
 *   1. 从预设名中提取"系列名"（去掉版本号/副本标记）
 *   2. 把版本号、副本标记单独提取出来便于二级展示
 *   3. 提供对预设快照列表的"系列 → 版本 → 快照"三级分组
 *   4. 支持用户手动覆盖（手动指定某个预设属于哪个系列）
 *
 * 设计要点:
 *   - 算法纯函数，不读 DOM、不依赖 SillyTavern API
 *   - 多层正则按"从特殊到一般"优先级匹配
 *   - 解析失败时安全回退（系列 = 原名）
 *
 * 测试样例（见 _SAMPLES）:
 *   - 【DarkSide-小猫之神】v1.1
 *   - 北棱预设2.4
 *   - 梦境思客V1-0425 / 梦境思客V2-0427-3 / 梦境思客V2-0426 (1)
 *   - 神秘预设v1.2
 *   - 夏瑾 双鱼座 Beta 0.15
 *   - Deepseek 官方提示词指南预设 (5)
 *   - Default / Izumi 0318
 */

import { logger } from './logger.js';

// =====================================================
// 版本号识别正则（按优先级排序，先特殊后一般）
// =====================================================
/**
 * 版本号匹配模式说明（注意：不使用 lookbehind 以兼容旧 Safari）
 *
 * 每条模式：
 *   re      - 正则。如果使用了"分隔符前缀"（不希望被吃进版本号里），
 *             用 captureGroup=1 表示版本号在 m[1]，前面的 m[0..1] 是分隔符
 *   kind    - 模式标识（用于调试/统计）
 *   captureGroup - 0 = 整个 match 就是版本号；1 = m[1] 才是版本号
 */
const _BUILTIN_VERSION_PATTERNS = [
    // 1) V/v + 数字 + (短横 + 数字)+         例：V2-0427-3 / V1-0425
    {
        re: /[Vv]\d+(?:-\d+)+\s*$/,
        kind: 'v-dash',
        captureGroup: 0,
    },
    // 2) 阶段词 + 空格 + 数字.数字...         例：Beta 0.40 / Alpha 1.2
    {
        re: /\s+(?:Beta|Alpha|RC|Preview|Test|Dev|Stable|Release|Snapshot)\s+\d+(?:\.\d+)+\s*$/i,
        kind: 'phase',
        captureGroup: 0,
    },
    // 3) v/V + 数字.数字(.数字...)            例：v1.2 / V2.0.1
    {
        re: /[Vv]\d+(?:\.\d+)+\s*$/,
        kind: 'v-dot',
        captureGroup: 0,
    },
    // 4) 末尾纯数字.数字(.数字...)            例：北棱预设2.4
    //    用普通捕获组替代 lookbehind：([^A-Za-z])(\d+\.\d+)$ → 版本在 m[2]
    //    无前缀（开头就是数字）也允许，靠 |^ 保留
    {
        re: /(?:^|[^A-Za-z])(\d+(?:\.\d+)+)\s*$/,
        kind: 'dot',
        captureGroup: 1,
    },
    // 5) 末尾 4 位数字（日期）                例：Izumi 0318
    {
        re: /\s+(\d{4})\s*$/,
        kind: 'date',
        captureGroup: 1,
    },
    // 6) 末尾 V/v + 数字（短）                例：预设V2 / 模型 v3
    //    用普通捕获组替代 lookbehind：分隔符（空白/中文标点）+ Vn
    {
        re: /(?:[\s\u4e00-\u9fa5\u3000-\u303f])([Vv]\d+)\s*$/,
        kind: 'v-num',
        captureGroup: 1,
    },
];

// 运行时模式列表：可通过 registerVersionPattern() 扩展
const VERSION_PATTERNS = [..._BUILTIN_VERSION_PATTERNS];

// 副本标记 (N) 通常表示导入时的"重复版本副本"
const DUPLICATE_PATTERN = /\s*\((\d+)\)\s*$/;

/**
 * 注册自定义版本号模式（扩展点）
 *
 * @param {object} pattern { re: RegExp, kind: string, captureGroup?: number }
 * @param {object} [opts]
 * @param {boolean} [opts.priority=false] true 表示插到列表前面（优先级最高）
 * @returns {Function} 取消注册函数
 *
 * 例：
 *   const off = registerVersionPattern({
 *     re: /\bbuild-\d+\s*$/i,
 *     kind: 'build',
 *     captureGroup: 0,
 *   });
 *   // 之后 "MyPreset build-42" 会被识别为 series="MyPreset" version="build-42"
 */
export function registerVersionPattern(pattern, opts = {}) {
    if (!pattern || !(pattern.re instanceof RegExp) || typeof pattern.kind !== 'string') {
        logger.warn('registerVersionPattern: invalid pattern', pattern);
        return () => {};
    }
    const entry = {
        re: pattern.re,
        kind: pattern.kind,
        captureGroup: typeof pattern.captureGroup === 'number' ? pattern.captureGroup : 0,
    };
    if (opts.priority) VERSION_PATTERNS.unshift(entry);
    else VERSION_PATTERNS.push(entry);
    _parseCache.clear();  // 清缓存使新模式立即生效
    return () => {
        const i = VERSION_PATTERNS.indexOf(entry);
        if (i >= 0) VERSION_PATTERNS.splice(i, 1);
        _parseCache.clear();
    };
}

/**
 * 重置为内置模式（清除所有自定义模式）
 */
export function resetVersionPatterns() {
    VERSION_PATTERNS.length = 0;
    VERSION_PATTERNS.push(..._BUILTIN_VERSION_PATTERNS);
    _parseCache.clear();
}

// =====================================================
// 解析单个预设名 → { series, version, duplicate, kind, original }
// =====================================================
/**
 * 把"预设原名"拆成 { series, version, duplicate }
 *
 * @param {string} name 预设原名
 * @returns {{series:string, version:string, duplicate:string, kind:string, original:string}}
 *          series   = 去掉版本/副本后的"裸名字"（解析失败时 = original）
 *          version  = 提取到的版本号字符串（含 v/V/Beta 等前缀，trim 过）
 *          duplicate = 提取到的副本标记，例如 "(1)"
 *          kind     = 命中的版本模式 kind，未命中为 ''
 *          original = 原名（保留首尾空白也保留）
 */
/**
 * 模块级解析缓存（LRU-ish）：解析同一个名字时直接复用结果
 *  - 每条快照渲染都会调用 parsePresetName，搜索框 keypress 时也会调用
 *  - 用户的预设数量通常 << 200，缓存上限设 500 完全够用且永不爆内存
 */
const _parseCache = new Map();
const _PARSE_CACHE_LIMIT = 500;

export function parsePresetName(name) {
    const cacheKey = String(name ?? '');
    if (_parseCache.has(cacheKey)) return _parseCache.get(cacheKey);

    const original = cacheKey;
    let result;
    if (!original.trim()) {
        result = Object.freeze({
            series: '', version: '', duplicate: '', kind: '', original,
        });
    } else {
        let working = original.trim();
        let duplicate = '';
        let version = '';
        let kind = '';

        // ---- 1) 副本标记 ----
        const dupMatch = working.match(DUPLICATE_PATTERN);
        if (dupMatch) {
            duplicate = `(${dupMatch[1]})`;
            working = working.slice(0, dupMatch.index).trim();
        }

        // ---- 2) 版本号（按优先级）----
        // 关键：使用 captureGroup 时，
        //   - version = m[captureGroup]（不带分隔符前缀）
        //   - series 切到 m.index + (m[0] 中分隔符前缀部分的长度)
        //     即：m.index + m[0].indexOf(m[captureGroup])
        for (const p of VERSION_PATTERNS) {
            const m = working.match(p.re);
            if (!m || m.index === undefined) continue;
            const cg = p.captureGroup || 0;
            const matched = (cg > 0 && m[cg] !== undefined) ? m[cg] : m[0];
            // 计算 working 应该切到的位置：
            // 整个 m[0] 中"前缀长度" = m[0].length - matched.length（仅适用于版本号在末尾的情况，本算法所有模式都满足）
            const trimEnd = m.index + (m[0].length - matched.length);
            version = String(matched).trim();
            working = working.slice(0, trimEnd).trim();
            kind = p.kind;
            break;
        }

        // ---- 3) 系列回退 ----
        // 如果剥光后剩空字符串（例如名字本身就只是 "v1.0"），则把整个名字回填给 series
        let series = working;
        if (!series) {
            series = original.trim();
            version = '';
            kind = '';
        }

        // 去掉系列名末尾的常见连接符（如 "夏瑾 双鱼座 - " "梦境思客 - "）
        series = series.replace(/[\s\-—_·•]+$/, '').trim() || original.trim();

        result = Object.freeze({ series, version, duplicate, kind, original });
    }

    // LRU：超过上限淘汰最早插入的（Map 保持插入顺序）
    if (_parseCache.size >= _PARSE_CACHE_LIMIT) {
        const firstKey = _parseCache.keys().next().value;
        _parseCache.delete(firstKey);
    }
    _parseCache.set(cacheKey, result);
    return result;
}

/**
 * 清空解析缓存（用于测试或在改变模式后强制重算）
 */
export function clearParseCache() {
    _parseCache.clear();
}

// =====================================================
// 应用手动覆盖：返回最终系列名
// =====================================================
/**
 * 把"原名"先做自动解析，再叠加用户的手动覆盖
 *
 * @param {string} presetName 原名
 * @param {object} [overrides] { [presetName]: seriesName } 手动覆盖
 * @param {object} [excluded]  { [presetName]: true } 排除（不分组）
 * @returns {{series:string, version:string, duplicate:string, manualOverride:boolean, excluded:boolean, original:string}}
 */
export function getSeriesInfo(presetName, overrides = null, excluded = null) {
    const parsed = parsePresetName(presetName);
    const isExcluded = !!(excluded && excluded[presetName]);
    if (isExcluded) {
        return { ...parsed, manualOverride: false, excluded: true };
    }
    if (overrides && Object.hasOwn(overrides, presetName)) {
        const ov = String(overrides[presetName] || '').trim();
        if (ov) {
            return { ...parsed, series: ov, manualOverride: true, excluded: false };
        }
    }
    return { ...parsed, manualOverride: false, excluded: false };
}

// =====================================================
// 版本号比较（用于排序）—— 数字段优先，字符串次之
// =====================================================
/**
 * 比较两个版本号字符串
 * 返回正数 = a > b，负数 = a < b，0 = 等价
 *
 * 规则：把每段"数字"按数字大小比较，长度不等的位置补 0；
 *       全部数字段都相等则用 localeCompare 兜底。
 *
 * 例子：
 *   v1.2  vs v1.10   → v1.10 大
 *   V2-0427-3 vs V2-0427-2 → V2-0427-3 大
 *   Beta 0.40 vs Beta 0.15 → Beta 0.40 大
 */
export function compareVersion(va, vb) {
    const a = String(va || '');
    const b = String(vb || '');
    if (a === b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    const na = (a.match(/\d+/g) || []).map(Number);
    const nb = (b.match(/\d+/g) || []).map(Number);
    const len = Math.max(na.length, nb.length);
    for (let i = 0; i < len; i++) {
        const x = na[i] ?? 0;
        const y = nb[i] ?? 0;
        if (x !== y) return x - y;
    }
    // 显式指定 locale='en'：避免不同浏览器/系统的本地化排序差异
    return a.localeCompare(b, 'en');
}

// =====================================================
// 代表版本挑选（用于"接管原生下拉"和"二级面板默认应用"）
// =====================================================
/**
 * 从一组同系列版本中挑选"最新版本"
 *   - 按 compareVersion 倒序排列后取第一项
 *   - 输入数组应至少有 version 字段
 * @param {Array<{version: string}>} items
 * @returns {Object|null}
 */
export function pickLatestVersion(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    let best = items[0];
    for (let i = 1; i < items.length; i++) {
        if (compareVersion(items[i].version, best.version) > 0) {
            best = items[i];
        }
    }
    return best;
}

/**
 * 为某个系列挑选"代表版本"
 *   - 优先级 1：用户在 settings.seriesDefaultApply 中显式指定
 *   - 优先级 2：版本号最大者
 *
 * @param {string} seriesKey 系列名
 * @param {Array<{version: string, presetName: string}>} items 同系列所有版本
 * @param {Object<string, string>} [seriesDefaultApply] { [seriesKey]: presetName }
 * @returns {Object|null} 选中的 item（即 items 中的某一项）
 */
export function pickRepresentativeVersion(seriesKey, items, seriesDefaultApply = null) {
    if (!Array.isArray(items) || items.length === 0) return null;

    if (seriesDefaultApply && Object.hasOwn(seriesDefaultApply, seriesKey)) {
        const target = String(seriesDefaultApply[seriesKey] || '').trim();
        if (target) {
            const found = items.find(it => it.presetName === target);
            if (found) return found;
        }
    }
    return pickLatestVersion(items);
}

// =====================================================
// 把一组预设名按"系列"聚类（用于"扫描向导"）
// =====================================================
/**
 * 给定一组预设名，按系列归类
 *
 * @param {string[]} names
 * @param {object} [overrides]
 * @param {object} [excluded]
 * @returns {Array<{series:string, items:Array<{presetName:string, version:string, duplicate:string, kind:string}>}>}
 */
export function groupNamesBySeries(names, overrides = null, excluded = null) {
    if (!Array.isArray(names) || names.length === 0) return [];

    const map = new Map(); // series → items[]
    for (const n of names) {
        const info = getSeriesInfo(n, overrides, excluded);
        if (info.excluded) continue;
        const key = info.series || n;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({
            presetName: n,
            version: info.version,
            duplicate: info.duplicate,
            kind: info.kind,
            manualOverride: info.manualOverride,
        });
    }

    // 每个系列内按版本排序（新版本排前面）
    const groups = [];
    for (const [series, items] of map.entries()) {
        items.sort((a, b) => compareVersion(b.version, a.version));
        groups.push({ series, items });
    }
    // 系列名 A→Z
    groups.sort((a, b) => a.series.localeCompare(b.series));
    return groups;
}

// =====================================================
// 把"快照"按 系列 → 版本（apiId+presetName） → 快照 三级分组
// =====================================================
/**
 * @param {Array} snapshots 来自 history-store.getAllSnapshots()
 * @param {object} [options]
 * @param {object} [options.overrides] 手动覆盖
 * @param {object} [options.excluded] 排除集合
 * @returns {Map<string, {
 *   series: string,
 *   versions: Array<{
 *     apiId: string,
 *     presetName: string,
 *     version: string,
 *     duplicate: string,
 *     kind: string,
 *     manualOverride: boolean,
 *     snapshots: Array,
 *     latestTime: number,
 *     totalSize: number,
 *     snapshotCount: number,
 *   }>,
 *   latestTime: number,
 *   totalSize: number,
 *   snapshotCount: number,
 *   versionCount: number,
 * }>}
 */
export function groupSnapshotsBySeries(snapshots, options = {}) {
    const overrides = options.overrides || null;
    const excluded = options.excluded || null;
    const seriesMap = new Map();

    if (!Array.isArray(snapshots) || snapshots.length === 0) {
        return seriesMap;
    }

    // 一次扫描：按 series → versionKey → snapshot[]
    for (const snap of snapshots) {
        const presetName = snap?.presetName || '';
        const apiId = snap?.apiId || '';
        if (!presetName) continue;

        const info = getSeriesInfo(presetName, overrides, excluded);
        if (info.excluded) continue;
        const seriesKey = info.series || presetName;
        const versionKey = `${apiId}::${presetName}`;

        let series = seriesMap.get(seriesKey);
        if (!series) {
            series = {
                series: seriesKey,
                _versionMap: new Map(),
                versions: [],
                latestTime: 0,
                totalSize: 0,
                snapshotCount: 0,
                versionCount: 0,
            };
            seriesMap.set(seriesKey, series);
        }

        let ver = series._versionMap.get(versionKey);
        if (!ver) {
            ver = {
                apiId,
                presetName,
                version: info.version,
                duplicate: info.duplicate,
                kind: info.kind,
                manualOverride: info.manualOverride,
                snapshots: [],
                latestTime: 0,
                totalSize: 0,
                snapshotCount: 0,
            };
            series._versionMap.set(versionKey, ver);
            series.versions.push(ver);
        }

        ver.snapshots.push(snap);
        const sz = snap.size || 0;
        const ts = snap.timestamp || 0;
        ver.totalSize += sz;
        ver.snapshotCount += 1;
        if (ts > ver.latestTime) ver.latestTime = ts;
        series.totalSize += sz;
        series.snapshotCount += 1;
        if (ts > series.latestTime) series.latestTime = ts;
    }

    // 排序：每个 version 内部按时间倒序，每个 series 内的 version 按版本号倒序
    for (const series of seriesMap.values()) {
        for (const ver of series.versions) {
            ver.snapshots.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        }
        series.versions.sort((a, b) => {
            const v = compareVersion(b.version, a.version);
            if (v !== 0) return v;
            // 版本号相同（或都没有）按最近时间倒序
            return b.latestTime - a.latestTime;
        });
        series.versionCount = series.versions.length;
        delete series._versionMap;
    }

    return seriesMap;
}

// =====================================================
// 用快照列表反推"系列分组的 key 集合"
//   用于"展开/折叠所有"操作时知道有哪些 key
// =====================================================
export function getAllSeriesKeys(snapshots, options = {}) {
    const map = groupSnapshotsBySeries(snapshots, options);
    return Array.from(map.keys());
}

// =====================================================
// 给单个"新预设名"建议系列归属（用于"导入识别"提示）
// =====================================================
/**
 * @param {string} name 新预设原名
 * @param {string[]} existingSeries 当前已知系列名列表
 * @returns {{
 *   parsed: ReturnType<typeof parsePresetName>,
 *   suggestedSeries: string,    // 建议归到哪个系列
 *   isNewSeries: boolean,       // 是否为新系列
 * }}
 */
export function suggestSeriesForName(name, existingSeries = []) {
    const parsed = parsePresetName(name);
    const candidate = parsed.series;
    if (!candidate) {
        return { parsed, suggestedSeries: name, isNewSeries: true };
    }
    // 完全匹配
    if (existingSeries.includes(candidate)) {
        return { parsed, suggestedSeries: candidate, isNewSeries: false };
    }
    // 大小写不敏感匹配
    const lower = candidate.toLowerCase();
    const hit = existingSeries.find(s => s.toLowerCase() === lower);
    if (hit) {
        return { parsed, suggestedSeries: hit, isNewSeries: false };
    }
    return { parsed, suggestedSeries: candidate, isNewSeries: true };
}

// =====================================================
// 自检 / Smoke Test（仅在调试模式下打印）
// =====================================================
const _SAMPLES = Object.freeze([
    ['【DarkSide-小猫之神】v1.1',          '【DarkSide-小猫之神】', 'v1.1'],
    ['北棱预设2.4',                          '北棱预设',              '2.4'],
    ['梦境思客V1-0425',                      '梦境思客',              'V1-0425'],
    ['梦境思客V1-0426',                      '梦境思客',              'V1-0426'],
    ['梦境思客V2-0426 (1)',                  '梦境思客',              'V2-0426'],
    ['梦境思客V2-0427-3',                    '梦境思客',              'V2-0427-3'],
    ['梦境思客V2-0429',                      '梦境思客',              'V2-0429'],
    ['神秘预设v1.2',                         '神秘预设',              'v1.2'],
    ['温柔鲸鱼妈妈v1.8',                     '温柔鲸鱼妈妈',          'v1.8'],
    ['夏瑾 双鱼座 Beta 0.15',                '夏瑾 双鱼座',           'Beta 0.15'],
    ['夏瑾 双鱼座 Beta 0.37',                '夏瑾 双鱼座',           'Beta 0.37'],
    ['夏瑾 双鱼座 Beta 0.40',                '夏瑾 双鱼座',           'Beta 0.40'],
    ['Deepseek 官方提示词指南预设 (5)',     'Deepseek 官方提示词指南预设', ''],
    ['Default',                              'Default',               ''],
    ['Izumi 0318',                           'Izumi',                 '0318'],
]);

/**
 * 运行内置样例自检，把不符合预期的打 warn
 * 仅作为开发期校验，不影响功能
 */
export function runGroupingSelfTest(verbose = false) {
    let pass = 0, fail = 0;
    const failures = [];
    for (const [input, expectedSeries, expectedVersion] of _SAMPLES) {
        const r = parsePresetName(input);
        const ok = r.series === expectedSeries && r.version === expectedVersion;
        if (ok) {
            pass++;
            if (verbose) logger.debug(`[grouping] ✓ "${input}" → series="${r.series}" version="${r.version}"`);
        } else {
            fail++;
            failures.push({
                input,
                expected: { series: expectedSeries, version: expectedVersion },
                actual: { series: r.series, version: r.version, kind: r.kind },
            });
        }
    }
    if (fail > 0) {
        logger.warn(`[grouping] self-test ${pass}/${pass + fail} passed, ${fail} failures:`);
        for (const f of failures) logger.warn('  ', f);
    } else if (verbose) {
        logger.success(`[grouping] self-test all ${pass} passed`);
    }
    return { pass, fail, failures };
}
