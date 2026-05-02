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
// 全角 → 半角字符归一化映射表
//   仅用于 parsePresetName 内部解析时归一化输入；显示名仍保留原始字符
// =====================================================
const FULLWIDTH_DIGIT_MAP = '０１２３４５６７８９';
const FULLWIDTH_LATIN_MAP = 'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ';
const FULLWIDTH_PUNCT_MAP = { '．': '.', '－': '-', '＿': '_', '＠': '@', '＃': '#', '：': ':', '；': ';', '／': '/', '＼': '\\', '？': '?', '！': '!' };

/**
 * 把一段字符串里的全角数字、字母、常见标点都归一化为半角
 * 不修改其它字符（中文、emoji 等保持原样）
 */
function normalizeFullwidth(str) {
    if (!str || typeof str !== 'string') return str;
    let out = '';
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        const code = ch.charCodeAt(0);
        // 全角数字 ０-９ → 半角 0-9
        if (code >= 0xff10 && code <= 0xff19) {
            out += String.fromCharCode(code - 0xff10 + 0x30);
        }
        // 全角大写 Ａ-Ｚ → 半角 A-Z
        else if (code >= 0xff21 && code <= 0xff3a) {
            out += String.fromCharCode(code - 0xff21 + 0x41);
        }
        // 全角小写 ａ-ｚ → 半角 a-z
        else if (code >= 0xff41 && code <= 0xff5a) {
            out += String.fromCharCode(code - 0xff41 + 0x61);
        }
        // 已知的常见全角标点
        else if (FULLWIDTH_PUNCT_MAP[ch]) {
            out += FULLWIDTH_PUNCT_MAP[ch];
        }
        else {
            out += ch;
        }
    }
    return out;
}

/**
 * 罗马数字 → 阿拉伯数字（仅识别 I-XX，简化匹配）
 */
const ROMAN_NUMERAL_MAP = {
    'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10,
    'XI': 11, 'XII': 12, 'XIII': 13, 'XIV': 14, 'XV': 15, 'XVI': 16, 'XVII': 17, 'XVIII': 18, 'XIX': 19, 'XX': 20,
};

/**
 * 圈数字 ① ② ③ ⑴ ⑵ → 数字字符串
 */
function circleNumberToInt(str) {
    if (!str) return null;
    const ch = str[0];
    const code = ch.charCodeAt(0);
    // ①-⑳: 0x2460 - 0x2473
    if (code >= 0x2460 && code <= 0x2473) return code - 0x2460 + 1;
    // ⑴-⒇: 0x2474 - 0x2487
    if (code >= 0x2474 && code <= 0x2487) return code - 0x2474 + 1;
    return null;
}

/**
 * 中文数字 → 阿拉伯数字（一二三四五六七八九十）
 */
const CN_DIGIT_MAP = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

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
    // ============================================================
    // 优先级 1：复合模式（先剥外层、再让其它模式继续吃）
    // ============================================================

    // 1.1) V/v数字 + 短横 + 数字.json                         例：Izumi DeepSeek V1.1.json
    //      整个 ".json" 后缀 + 版本号一并被吃掉
    {
        re: /\s+([Vv]\d+(?:\.\d+)+)\.json\s*$/i,
        kind: 'v-dot-json',
        captureGroup: 1,
    },

    // 1.2) V/v + 数字 + 空格 + 阶段词                         例：暗夜之歌 V3 Beta / 龙傲天霸气版 V4 Pro
    {
        re: /\s([Vv]\d+(?:\.\d+)*\s+(?:Beta|Alpha|RC|Preview|Test|Dev|Stable|Release|Final|Pro|Plus|Lite|EX|Enhanced|终极版|终焉版|最终版|完整版|改良版))\s*$/i,
        kind: 'v-num-phase',
        captureGroup: 1,
    },

    // 1.3) V/v + 数字 + 空格 + final/plus 等英文修饰          例：死神契约 V3 final / 哈利波特预设 V3 plus
    {
        re: /\s([Vv]\d+(?:\.\d+)*\s+(?:final|plus|pro|lite|ex|enhanced))\s*$/i,
        kind: 'v-num-suffix',
        captureGroup: 1,
    },

    // 1.4) v数字.数字 + 空格 + 阶段词/英文修饰                例：猫娘小可爱 v3.0 Alpha / v3.0 Final
    {
        re: /\s([Vv]\d+(?:\.\d+)+\s+(?:Beta|Alpha|RC|Preview|Test|Dev|Stable|Release|Final|Pro|Plus|Lite|EX|Enhanced|final|plus|pro|lite|ex))\s*$/i,
        kind: 'v-dot-phase',
        captureGroup: 1,
    },

    // 1.5) V/v + 数字 + 中文版本词                            例：永夜君王 V3 终极版 / V2 完整版
    {
        re: /\s([Vv]\d+(?:\.\d+)*\s*(?:终极版|终焉版|最终版|完整版|改良版|增强版|精简版|测试版|稳定版|公测版|内测版|优化版|魔改版))\s*$/,
        kind: 'v-num-cn-suffix',
        captureGroup: 1,
    },

    // 1.6) 复合：V1.0 + Phase + 数字（提前到优先级 1）         例：全能选手 V1.0 Beta 0501
    {
        re: /\s+([Vv]\d+(?:\.\d+)*\s+(?:Beta|Alpha|RC|Preview|Final|Stable)\s+\d+(?:\.\d+)*)\s*$/i,
        kind: 'v-phase-num',
        captureGroup: 1,
    },

    // 1.7) 复合：V1 + 4位数字（提前）                          例：法师 V1 0501
    {
        re: /\s+([Vv]\d+\s+\d{4})\s*$/,
        kind: 'v-date',
        captureGroup: 1,
    },

    // 1.8) 预发布版本号 v1.0.0-alpha.1（提前）                 例：战士 v1.0.0-alpha.1 / v2.0.0-rc.1
    {
        re: /\s+([Vv]\d+(?:\.\d+)*-(?:alpha|beta|rc|pre|preview|dev|snapshot)(?:\.\d+)*)\s*$/i,
        kind: 'pre-release',
        captureGroup: 1,
    },

    // 1.9) ISO 日期格式 YYYY-MM-DD（提前到优先级 1，避免被 sep-num 截胡）
    //      例：守夜人 2024-01-01 / 2024/02/15 / 2024.03.20
    {
        re: /\s+(\d{4}[\-\/\.]\d{1,2}[\-\/\.]\d{1,2})\s*$/,
        kind: 'date-iso',
        captureGroup: 1,
    },

    // 1.10) 中文完整日期（提前）                              例：守夜人 2024年5月1日
    {
        re: /\s+(\d{4}年\d{1,2}月\d{1,2}日)\s*$/,
        kind: 'cn-full-date',
        captureGroup: 1,
    },

    // 1.11) V/v版本号 + 下划线/短横 + ISO日期后缀（提前，避免被 sep-num 截胡）
    //       例：v1.1_2026-05-01 / V2.0-2024-12-31
    {
        re: /[Vv]\d+(?:\.\d+)+[_\-]\d{4}-\d{1,2}-\d{1,2}\s*$/,
        kind: 'v-dot-date',
        captureGroup: 0,
    },

    // 1.12) V/v版本号 + 下划线/短横 + 日期4-8位后缀（提前，避免被 sep-num 截胡）
    //       例：V1-0425_20260501 / v2.0_0501
    {
        re: /[Vv]\d+(?:[\.\-]\d+)*[_\-](\d{4,8})\s*$/,
        kind: 'v-num-date-suffix',
        captureGroup: 0,
    },

    // 1.13) V/v版本号 + 语言后缀（提前，避免 sep-suffix-dot / sep-num 截胡）
    //       例：NekoAssistant-v1.0-cn / Helper-v2.0-jp / Tool_v1.0_EN
    {
        re: /[\-_]([Vv]\d+(?:\.\d+)*[\-_](?:cn|en|jp|ja|kr|ko|tw|fr|de|es|ru|pt|zh|chs|cht))\s*$/i,
        kind: 'v-dot-lang',
        captureGroup: 1,
    },

    // ============================================================
    // 优先级 2：标准模式
    // ============================================================

    // 2.1) V/v + 数字 + (短横 + 数字)+         例：V2-0427-3 / V1-0425
    {
        re: /[Vv]\d+(?:-\d+)+(?:[-_].*)?\s*$/,
        kind: 'v-dash',
        captureGroup: 0,
    },

    // 2.2) 阶段词 + 空格 + 数字.数字...         例：Beta 0.40 / Alpha 1.2 / RC 1.0
    {
        re: /\s+(?:Beta|Alpha|RC|Preview|Test|Dev|Stable|Release|Snapshot|Final)\s+\d+(?:\.\d+)+\s*$/i,
        kind: 'phase',
        captureGroup: 0,
    },

    // 2.3) 阶段词 + 数字 / 阶段词单独           例：Beta1 / Alpha 3 / 量子纠缠态 Alpha
    {
        re: /\s+((?:Beta|Alpha|RC|Preview|Test|Dev|Stable|Release|Final|Snapshot)(?:\s*\d+(?:\.\d+)*)?)\s*$/i,
        kind: 'phase-int',
        captureGroup: 1,
    },

    // 2.4) v/V + 数字.数字(.数字...)            例：v1.2 / V2.0.1
    {
        re: /[Vv]\d+(?:\.\d+)+\s*$/,
        kind: 'v-dot',
        captureGroup: 0,
    },

    // 2.5) 末尾纯数字.数字(.数字...)            例：北棱预设2.4
    {
        re: /(?:^|[^A-Za-z])(\d+(?:\.\d+)+)\s*$/,
        kind: 'dot',
        captureGroup: 1,
    },

    // 2.6) 末尾 8 位数字（完整日期）            例：preset 20250428
    {
        re: /[\s\-_]+(\d{8})\s*$/,
        kind: 'date8',
        captureGroup: 1,
    },

    // 2.7) 末尾 6 位数字（年月日）              例：preset 250428
    {
        re: /[\s\-_]+(\d{6})\s*$/,
        kind: 'date6',
        captureGroup: 1,
    },

    // 2.8) 末尾 4 位数字（月日）                例：Izumi 0318
    {
        re: /[\s\-_]+(\d{4})\s*$/,
        kind: 'date4',
        captureGroup: 1,
    },

    // 2.9) 中文日期"X月X日" / "X月X号"        例：mur 鹿鹿 API 3月24日 / Mur API 12月3号
    {
        re: /\s*(\d{1,2}\s*月\s*\d{1,2}\s*[日号])\s*$/,
        kind: 'cn-date',
        captureGroup: 1,
    },

    // 2.10) 末尾 V/v + 数字（短）              例：预设V2 / 模型 v3 / 龙傲天霸气版 V1 / 助手🔥V1
    //       支持中文/常见分隔符/emoji 等"非拉丁字符"作为前缀
    //       注意：用 \uD800-\uDBFF\uDC00-\uDFFF 兼容 emoji surrogate pair
    {
        re: /(?:[\s\-_·•\u4e00-\u9fa5\u3000-\u303f]|[\uD800-\uDBFF][\uDC00-\uDFFF]|\u200d|\ufe0f)([Vv]\d+)\s*$/,
        kind: 'v-num',
        captureGroup: 1,
    },

    // 2.11) 末尾 #数字                          例：preset #5
    {
        re: /[\s_\-]*#\s*(\d+(?:\.\d+)?)\s*$/,
        kind: 'hash-num',
        captureGroup: 1,
    },

    // 2.12) 末尾"修改/改/新版/旧版"等中文修饰  例：梦境思客 修改版 / 量子纠缠态 正式版
    {
        re: /[\s\-_]?(修改版|新版|旧版|测试版|稳定版|改良版|增强版|完整版|精简版|最终版|终极版|终焉版|内部版|公测版|内测版|优化版|魔改版|限定版|限制版|正式版|发布版|预览版)\s*$/,
        kind: 'cn-suffix',
        captureGroup: 1,
    },

    // 2.13) 英文版本修饰词单独出现              例：limited版 / Limited版 / preset Pro / preset Lite
    {
        re: /\s+(limited版|Limited版|Pro|Plus|Lite|EX|Enhanced|Beta版|Alpha版)\s*$/i,
        kind: 'en-suffix',
        captureGroup: 1,
    },

    // 2.14) 末尾"vX.Y" 中间夹连字符或下划线   例：preset_v1.2 / preset-v2.0
    {
        re: /[\-_]([Vv]\d+(?:\.\d+)+)\s*$/,
        kind: 'sep-v-dot',
        captureGroup: 1,
    },

    // 2.15) 末尾 -X.Y 数字（带短横分隔的小数版本号） 例：Kemini Aether-fr-3.71 → fr-3.71
    //       注意：这条比 sep-num 优先，避免把 3.71 拆成 71
    {
        re: /[\-_]([A-Za-z]+[\-_]\d+(?:\.\d+)+)\s*$/,
        kind: 'sep-suffix-dot',
        captureGroup: 1,
    },

    // 2.16) LOG/log + 分隔符 + 数字（在 sep-num 之前，避免被截胡）
    //       例：开发日志 LOG_001 / 实验 log-42
    {
        re: /\s+((?:LOG|log)[\s_\-\.]*\d+)\s*$/,
        kind: 'log-num',
        captureGroup: 1,
    },

    // 2.17) build + 分隔符 + 数字（在 sep-num 之前，避免被截胡）
    //       例：MyPreset build-42 / 测试 build.001
    {
        re: /\s+(build[\s_\-\.]*\d+)\s*$/i,
        kind: 'build-num',
        captureGroup: 1,
    },

    // 2.18) rev/revision + 分隔符 + 数字（在 sep-num 之前，避免被截胡）
    //       例：文档 rev.1 / 草案 revision-3
    {
        re: /\s+((?:rev|revision)[\s_\-\.]*\d+(?:\.\d+)?)\s*$/i,
        kind: 'rev-num',
        captureGroup: 1,
    },

    // 2.19) 末尾 _数字 / -数字（单独）         例：preset_2 / preset-3
    {
        re: /[\-_](\d+)\s*$/,
        kind: 'sep-num',
        captureGroup: 1,
    },

    // ============================================================
    // 优先级 3：扩展模式（应对各种边缘情况）
    // ============================================================

    // 3.1) 多分隔符 + V版本号                   例：助手@v1 / 助手#1 / 助手|v2 / 助手:v1
    {
        re: /[\s_\-@#|:;]+([Vv]\d+(?:\.\d+)*)\s*$/,
        kind: 'special-sep-v',
        captureGroup: 1,
    },

    // 3.2) 多分隔符 + 数字.数字                例：助手#1.0
    {
        re: /[\s_\-@#|:;]+(\d+(?:\.\d+)+)\s*$/,
        kind: 'special-sep-dot',
        captureGroup: 1,
    },

    // 3.3) 多分隔符 + Phase                    例：助手|alpha / 助手|beta
    {
        re: /[\s_\-@#|:;]+((?:Beta|Alpha|RC|Final|Pro|Plus|Lite|Preview|Test|Dev|Stable)\d*(?:\.\d+)*)\s*$/i,
        kind: 'special-sep-phase',
        captureGroup: 1,
    },

    // 3.4) 多分隔符 + 数字（含助手#1这种）     例：助手#1 / 助手@2
    {
        re: /[@#|:;]+(\d+(?:\.\d+)?)\s*$/,
        kind: 'special-sep-num',
        captureGroup: 1,
    },

    // 3.5) 括号包裹的版本号                     例：守望者(V1) / 探索家[v1.0] / 冒险者{Beta} / 流浪者<Final> / 隐者「v1」
    //      整个括号 + 版本号 + 闭括号一起当作 m[0]，使用 captureGroup=1 提取版本号本体；
    //      关键：m[0] 必须包含整个括号对，working 切到时把括号一并去掉
    {
        re: /\s*[\(\[\{<「]\s*([Vv]\d+(?:\.\d+)*|(?:Beta|Alpha|RC|Final|Pro|Plus|Lite|Preview)\d*(?:\.\d+)*|\d+(?:\.\d+)+)\s*[\)\]\}>」]\s*$/i,
        kind: 'bracket-version',
        captureGroup: 1,
    },

    // 3.6) 罗马数字单独出现                     例：圣骑士 II / 圣骑士 V
    //      注意：放在 v-num 之后避免吞掉 V1, V2
    {
        re: /\s+(I{1,3}|IV|VI{0,3}|IX|X{1,2}|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX)\s*$/,
        kind: 'roman',
        captureGroup: 1,
    },

    // 3.7) 中文序数"第X代/第X版"                例：神龙战士 第一代 / 第二版
    {
        re: /\s*(第[零一二三四五六七八九十百千]+(?:代|版|世|话|章|期|号|次|轮|集))\s*$/,
        kind: 'cn-ordinal',
        captureGroup: 1,
    },

    // 3.8) 圈数字                               例：萤火虫 ① / 萤火虫 ②
    {
        re: /\s*([\u2460-\u249b])\s*$/,
        kind: 'circle-num',
        captureGroup: 1,
    },

    // 3.9) ISO 日期格式 YYYY-MM-DD              例：守夜人 2024-01-01
    {
        re: /\s+(\d{4}[\-\/\.]\d{1,2}[\-\/\.]\d{1,2})\s*$/,
        kind: 'date-iso',
        captureGroup: 1,
    },

    // 3.10) 中文完整日期                         例：守夜人 2024年5月1日
    {
        re: /\s+(\d{4}年\d{1,2}月\d{1,2}日)\s*$/,
        kind: 'cn-full-date',
        captureGroup: 1,
    },

    // 3.11) 短日期 YY.MM.DD                     例：守夜人 24.04.10
    {
        re: /\s+(\d{2}[\-\/\.]\d{1,2}[\-\/\.]\d{1,2})\s*$/,
        kind: 'short-date',
        captureGroup: 1,
    },

    // 3.12) 月份缩写 + 日                       例：看护者 Jan-15 / Feb 20
    {
        re: /\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\-\s\.]+\d{1,2})\s*$/i,
        kind: 'month-day',
        captureGroup: 1,
    },

    // 3.13) 预发布版本号 v1.0.0-alpha.1          例：战士 v1.0.0-alpha.1 / v2.0.0-rc.1
    {
        re: /\s+([Vv]\d+(?:\.\d+)*-(?:alpha|beta|rc|pre|preview|dev|snapshot)(?:\.\d+)*)\s*$/i,
        kind: 'pre-release',
        captureGroup: 1,
    },

    // 3.14) 复合：V1.0 + Phase + 数字            例：全能选手 V1.0 Beta 0501
    {
        re: /\s+([Vv]\d+(?:\.\d+)*\s+(?:Beta|Alpha|RC|Preview|Final|Stable)\s+\d+(?:\.\d+)*)\s*$/i,
        kind: 'v-phase-num',
        captureGroup: 1,
    },

    // 3.15) 复合：V1 + 4位数字                   例：法师 V1 0501
    {
        re: /\s+([Vv]\d+\s+\d{4})\s*$/,
        kind: 'v-date',
        captureGroup: 1,
    },

    // 3.16) 末尾"X代/X版/X号"等数字+单位        例：终极兵器 0501 / 1号特工
    //       注意：仅当数字+单位词在末尾时识别
    {
        re: /\s+(\d+\s*(?:代|版|号|期|次|轮|集|话|章))\s*$/,
        kind: 'num-cn-unit',
        captureGroup: 1,
    },

    // 3.17) Beta版/Alpha版 等带"版"后缀          例：助手 Beta版 / 助手 Alpha版
    {
        re: /\s+((?:Beta|Alpha|RC|Final|Preview)版)\s*$/i,
        kind: 'phase-cn-version',
        captureGroup: 1,
    },

    // 3.18) EP + 数字                              例：冒险日志 EP01 / 探索者 EP.5
    {
        re: /\s+(EP\.?\s*\d+(?:\.\d+)?)\s*$/i,
        kind: 'ep-num',
        captureGroup: 1,
    },

    // 3.19) Part/Chapter + 数字                     例：故事 Part.1 / 传说 Chapter.3
    {
        re: /\s+((?:Part|Chapter|Ch)[\.\s]*\d+(?:\.\d+)?)\s*$/i,
        kind: 'part-num',
        captureGroup: 1,
    },

    // 3.20) Phase + 数字                            例：计划 Phase1 / 行动 Phase 2
    {
        re: /\s+(Phase[\s]*\d+)\s*$/i,
        kind: 'phase-num-standalone',
        captureGroup: 1,
    },

    // 3.24) MK-I/MK-II 等罗马数字变体              例：铁人 MK-III / 战甲 Mk.II
    {
        re: /\s+(MK[\.\-\s]*(?:I{1,3}|IV|VI{0,3}|IX|X{1,2}))\s*$/i,
        kind: 'mk-roman',
        captureGroup: 1,
    },

    // 3.25) 中文大写数字版本                        例：守护者 壹 / 守护者 贰
    {
        re: /\s+([壹贰叁肆伍陆柒捌玖拾])\s*$/,
        kind: 'cn-formal-num',
        captureGroup: 1,
    },

    // 3.26) 希腊字母版本                            例：计划 α / 实验 β / 终版 γ
    {
        re: /\s+([αβγδεζηθικλμ])\s*$/,
        kind: 'greek-letter',
        captureGroup: 1,
    },

    // 3.27) ver. + 任意（宽松版本标记）             例：助手 ver.春 / 工具 ver.2024
    {
        re: /\s+(ver\.\s*\S+)\s*$/i,
        kind: 'ver-dot',
        captureGroup: 1,
    },
];

// ============================================================
// 嵌入式版本号正则（不要求版本号在末尾）
// 用于 parsePresetName 在尾部匹配失败后的二次扫描
// ============================================================
const _EMBEDDED_PATTERNS = [
    // E1) 中文 + V/v数字 + 中文                                  例：神秘V1之书 / 神秘V2之书
    //     提取：series = "神秘之书"（合并前后中文）
    {
        re: /^([\u4e00-\u9fa5]+)([Vv]\d+(?:\.\d+)*)([\u4e00-\u9fa5].*)$/,
        kind: 'embed-v-num',
    },
    // E2) 任意 + 空格 + v1.0 + 空格 + 任意                       例：黑暗 v1.0 骑士团
    //     提取：series = "黑暗 骑士团"
    {
        re: /^(.+?)\s+([Vv]\d+(?:\.\d+)+)\s+(.+?)$/,
        kind: 'embed-v-dot',
    },
    // E3) 任意 + 空格 + Phase + 空格 + 任意                      例：永夜 Beta 守望者
    {
        re: /^(.+?)\s+(Beta|Alpha|RC|Preview|Test|Dev|Final|Stable)\s+(.+?)$/i,
        kind: 'embed-phase',
    },
    // E4) 任意 + 空格 + 4位数字 + 空格 + 任意                    例：灵魂 0501 缔造者
    {
        re: /^(.+?)\s+(\d{4})\s+(.+?)$/,
        kind: 'embed-date4',
    },
    // E5) 任意 + 空格 + Pro/Plus/Lite/Final + 空格 + 任意        例：终极 Pro 战士
    {
        re: /^(.+?)\s+(Pro|Plus|Lite|EX|Enhanced|Final)\s+(.+?)$/,
        kind: 'embed-en-suffix',
    },
];

// ============================================================
// 前缀版本号正则（版本号在开头）
// ============================================================
const _PREFIX_PATTERNS = [
    // P1) V/v数字(.数字)? + 空格 + 名字                          例：V1 暗夜骑士 / V2 暗夜骑士 / v1.0 神秘法师
    {
        re: /^([Vv]\d+(?:\.\d+)*)\s+(.+)$/,
        kind: 'prefix-v',
    },
    // P2) Phase 词 + 空格 + 名字                                例：Beta 黑暗领主 / Alpha 黑暗领主
    {
        re: /^((?:Beta|Alpha|RC|Preview|Test|Dev|Final|Stable|Snapshot))\s+(.+)$/i,
        kind: 'prefix-phase',
    },
    // P3) 4位数字 + 空格 + 名字（日期前置）                     例：0501 时空法师 / 0510 时空法师
    {
        re: /^(\d{4})\s+(.+)$/,
        kind: 'prefix-date4',
    },
    // P4) 中文序数 + 空格 + 名字                                 例：第一版 龙之契约
    {
        re: /^(第[零一二三四五六七八九十百千]+(?:代|版|世|话|章|期|号|次|轮|集))\s+(.+)$/,
        kind: 'prefix-cn-ordinal',
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
        // ⭐ 全角字符归一化：把全角数字/字母/常见标点转半角，便于后续正则匹配
        let working = normalizeFullwidth(original.trim());
        let duplicate = '';
        let version = '';
        let kind = '';

        // ---- 1) 副本标记 ----
        const dupMatch = working.match(DUPLICATE_PATTERN);
        if (dupMatch) {
            duplicate = `(${dupMatch[1]})`;
            working = working.slice(0, dupMatch.index).trim();
        }

        // ---- 1.5) 副本/拷贝/备份标记剥离 ----
        // "Copy of 暗夜之歌 V1" → "暗夜之歌 V1"
        // "暗夜之歌 V1 - 副本" → "暗夜之歌 V1"
        // "暗夜之歌 V1（备份）" / "暗夜之歌 V1 (旧)" → "暗夜之歌 V1"
        working = working.replace(/^(?:Copy\s+of)\s+/i, '');
        working = working.replace(/\s*[\-\u2014]\s*(?:副本|拷贝|备份|copy)\s*$/i, '');
        working = working.replace(/\s*[（(]\s*(?:副本|拷贝|备份|旧|新|old|new|copy|bak|backup)\s*[）)]\s*$/i, '');

        // ---- 2) 尾部版本号匹配（按优先级）----
        // 关键：根据模式的特性判断 working 应该切到哪：
        //   - 标准模式（v-num 等）：切到 m.index + (m[0] 中分隔符前缀的位置)，保留前缀字符
        //     比如 "守护者V1" → 模式 `(\u4e00-\u9fa5)(V1)`，m[0]="者V1", m[1]="V1" → 切到"守护者"位置
        //   - 整匹配模式（bracket-version 等）：完全切掉 m[0]
        //
        // 实现：如果 captureGroup > 0，使用 trimEnd = m.index + indexOf(matched, m[0])
        //       如果 captureGroup = 0（整个 m[0] 就是 version），使用 trimEnd = m.index + (m[0].length - matched.length)
        for (const p of VERSION_PATTERNS) {
            const m = working.match(p.re);
            if (!m || m.index === undefined) continue;
            const cg = p.captureGroup || 0;
            const matched = (cg > 0 && m[cg] !== undefined) ? m[cg] : m[0];

            // 计算 working 应该切到的位置
            // - 对于 captureGroup>0 且 matched 是 m[0] 的尾部子串（即版本号在末尾、前面都是分隔符）：
            //   working 切到 "matched 在 m[0] 中的起始位置" + m.index
            //   如果还有"括号闭合"等后缀，trimEnd 仍正确（前缀长度 = m[0].length - matchedSuffix - 后缀.length）
            // - 但 bracket-version 这种"整体吃掉"模式没有"前缀字符要保留"，
            //   只需保证 trimEnd 不会留下闭括号即可
            let trimEnd;
            const matchedIdxInM0 = m[0].lastIndexOf(matched);
            if (matchedIdxInM0 >= 0) {
                // 标准情况：matched 在 m[0] 内，working 切到"前缀部分"之后
                trimEnd = m.index + matchedIdxInM0;
                // 但如果 matched 之后还有内容（比如闭括号），那一段也要切掉
                // 通过判断 m[0].length 是否 > matchedIdxInM0 + matched.length
                // 即 matched 后还有字符 → 整段都吃掉
                if (matchedIdxInM0 + matched.length < m[0].length) {
                    // 后面还有"闭合"字符，整段 m[0] 吃掉
                    trimEnd = m.index;
                }
            } else {
                // 兜底：直接切到 m.index
                trimEnd = m.index;
            }

            version = String(matched).trim();
            working = working.slice(0, trimEnd).trim();
            kind = p.kind;
            break;
        }

        // ---- 3) 前缀版本号匹配（如果尾部没匹配上）----
        // 例如 "V1 暗夜骑士" / "Beta 黑暗领主" / "0501 时空法师"
        if (!version) {
            for (const p of _PREFIX_PATTERNS) {
                const m = working.match(p.re);
                if (!m) continue;
                version = String(m[1]).trim();
                working = String(m[2]).trim();
                kind = p.kind;
                break;
            }
        }

        // ---- 4) 嵌入式版本号匹配（如果尾部和前缀都没匹配上）----
        // 例如 "神秘V1之书" / "黑暗 v1.0 骑士团" / "永夜 Beta 守望者"
        if (!version) {
            for (const p of _EMBEDDED_PATTERNS) {
                const m = working.match(p.re);
                if (!m) continue;
                // 系列名 = 前缀 + 后缀（如有）
                const before = (m[1] || '').trim();
                const ver = (m[2] || '').trim();
                const after = (m[3] || '').trim();
                // 防止退化：若 before 或 after 为空或太短（容易误匹配）则跳过
                if (!before || !after || before.length < 1 || after.length < 1) continue;
                version = ver;
                // 嵌入式版本号特殊处理：series 形成 "前缀+后缀"
                //   - 中文连接：用空格分隔（"神秘 之书" 比 "神秘之书" 更易读）
                //   - 但若前后都是中文，用直接相连（"神秘之书"）；含拉丁字符则空格分隔
                const isAllChinese = /^[\u4e00-\u9fa5]+$/.test(before) && /^[\u4e00-\u9fa5]+$/.test(after);
                working = isAllChinese ? `${before}${after}` : `${before} ${after}`;
                kind = p.kind;
                break;
            }
        }

        // ---- 5) 系列回退 ----
        let series = working;
        if (!series) {
            series = original.trim();
            version = '';
            kind = '';
        }

        // 去掉系列名末尾/开头的常见连接符（井号/句号/分隔符/括号等）
        series = series.replace(/[\s\-—_·•#@\/\\.\(\[\{<「:|;]+$/, '').trim() || original.trim();
        series = series.replace(/^[\s\-—_·•#@\/\\.\)\]\}>」:|;]+/, '').trim() || original.trim();

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

/**
 * 系列名归一化键：用于"系列归并"时彻底消除噪声差异
 *  - 大小写：mur ≡ Mur ≡ MUR
 *  - 前后空白：" mur" ≡ "mur "
 *  - 内部空白：多个空格 / Tab 折叠为单个空格
 *  - CJK 与 ASCII 之间的空格可有可无："mur鹿鹿 API" ≡ "mur 鹿鹿 API" ≡ "mur鹿鹿API"
 *  - 半角标点 / 全角标点统一
 *  - 但用户看到的"显示名"会保留首次出现时的原始形式
 */
export function normalizeSeriesKey(seriesKey) {
    let s = String(seriesKey || '').trim().toLowerCase();
    // 全角字符已在 parsePresetName 阶段统一过，这里再兜底一次
    s = s.replace(/[\u3000]/g, ' ');                    // 全角空格 → 半角
    s = s.replace(/[‐‑‒–—―−]/g, '-');                    // 各类破折号 → 短横线
    s = s.replace(/\s+/g, ' ');                          // 折叠多空格
    // ⭐ 关键：CJK 与 ASCII（包括数字）相邻处的空格"可有可无"
    //   "mur鹿鹿 API" ≡ "mur 鹿鹿 API"：在 CJK 前后的 ASCII 间消除空格差异
    //   方法：把所有 ASCII↔CJK 边界的空格都删掉，再 trim
    s = s.replace(/([a-z0-9])\s+([\u4e00-\u9fa5])/g, '$1$2');
    s = s.replace(/([\u4e00-\u9fa5])\s+([a-z0-9])/g, '$1$2');
    // 中文之间的空格也消除（"鹿鹿 反重力" 与 "鹿鹿反重力" 视为同一）
    s = s.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2');
    return s.trim();
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

    // normKey -> { displayName, items[] }
    // 用归一化键归并不同大小写的同系列；显示名沿用第一次出现的版本
    const map = new Map();
    for (const n of names) {
        const info = getSeriesInfo(n, overrides, excluded);
        // AH-1 fix: excluded 预设"不参与自动分组" ≠ "从界面上隐藏"
        // 每个 excluded 预设自成一组（系列键 = 原名，不做版本拆分）
        const series = info.excluded ? n : (info.series || n);
        const normKey = normalizeSeriesKey(series);

        if (!map.has(normKey)) {
            map.set(normKey, { displayName: series, items: [] });
        }
        map.get(normKey).items.push({
            presetName: n,
            version: info.excluded ? '' : info.version,
            duplicate: info.excluded ? '' : info.duplicate,
            kind: info.excluded ? '' : info.kind,
            manualOverride: info.manualOverride,
        });
    }

    // 每个系列内按版本排序（新版本排前面）
    const groups = [];
    for (const { displayName, items } of map.values()) {
        items.sort((a, b) => compareVersion(b.version, a.version));
        groups.push({ series: displayName, items });
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
    // seriesMap 的 key 仍然是"显示名"（首次出现的大小写形式）
    // 但归并查找用归一化键，避免 "mur API" 与 "Mur API" 分两组
    const seriesMap = new Map();
    const normToDisplay = new Map();  // normKey → displayName

    if (!Array.isArray(snapshots) || snapshots.length === 0) {
        return seriesMap;
    }

    // 一次扫描：按 series → versionKey → snapshot[]
    for (const snap of snapshots) {
        const presetName = snap?.presetName || '';
        const apiId = snap?.apiId || '';
        if (!presetName) continue;

        const info = getSeriesInfo(presetName, overrides, excluded);
        // AH-1 fix: excluded 预设自成独立系列（系列键 = 原名），不做版本拆分
        const rawSeriesKey = info.excluded ? presetName : (info.series || presetName);
        const normKey = normalizeSeriesKey(rawSeriesKey);
        // 首次出现的大小写形式作为显示名
        if (!normToDisplay.has(normKey)) {
            normToDisplay.set(normKey, rawSeriesKey);
        }
        const seriesKey = normToDisplay.get(normKey);
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
                // AH-1: excluded 预设不做版本拆分
                version: info.excluded ? '' : info.version,
                duplicate: info.excluded ? '' : info.duplicate,
                kind: info.excluded ? '' : info.kind,
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
    // ---- 原有用例（不可改变预期结果）----
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

    // ---- X-0+X-1 增强用例 ----
    // 核心问题：日期后缀 _YYYY-MM-DD
    ['【DarkSide-小猫之神】v1.1_2026-05-01', '【DarkSide-小猫之神】', 'v1.1_2026-05-01'],
    // 语言后缀
    ['NekoAssistant-v1.0-cn',               'NekoAssistant',         'v1.0-cn'],
    ['NekoAssistant-v2.0-jp',               'NekoAssistant',         'v2.0-jp'],
    // 副本标记剥离
    ['Copy of 暗夜之歌 V1',                 '暗夜之歌',              'V1'],
    ['暗夜之歌 V1 - 副本',                  '暗夜之歌',              'V1'],
    ['暗夜之歌 V1（备份）',                  '暗夜之歌',              'V1'],
    // 全角/半角归一化
    ['守护者Ｖ１',                            '守护者',                'V1'],
    ['守护者Ｖ２',                            '守护者',                'V2'],
    // EP/Part/Chapter/LOG/build/rev/Phase/MK
    ['冒险日志 EP01',                        '冒险日志',              'EP01'],
    ['故事 Part.1',                          '故事',                  'Part.1'],
    ['开发日志 LOG_001',                     '开发日志',              'LOG_001'],
    ['MyPreset build-42',                    'MyPreset',              'build-42'],
    ['文档 rev.1',                           '文档',                  'rev.1'],
    ['计划 Phase1',                          '计划',                  'Phase1'],
    ['铁人 MK-III',                          '铁人',                  'MK-III'],
    // 阶段词 + 版本
    ['暗夜之歌 V3 Beta',                     '暗夜之歌',              'V3 Beta'],
    ['暗夜之歌 终焉版',                      '暗夜之歌',              '终焉版'],
    ['月影狼魂 V5 Final',                    '月影狼魂',              'V5 Final'],
    ['深海水母 v2.0 Stable',                 '深海水母',              'v2.0 Stable'],
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
