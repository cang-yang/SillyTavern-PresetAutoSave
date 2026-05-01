/**
 * SillyTavern Preset Auto Save - Diff Viewer v2
 * 全面重构：LCS 行级/字符级 diff · 词条内容对比 · 参数 delta · 排序可视化
 *
 * 设计：
 *   - 输入两个 snapshot → ST Popup
 *   - 三段：Prompts 词条（核心）/ Settings 标量 / Order 排序
 *   - 词条变化：左右双列布局 + 行级 diff + 字符级高亮
 *   - 数值参数：old → new (+delta)
 *   - 顺序/启用变化：位置箭头 + 启用标签
 *   - 顶部汇总面板；可折叠分区
 */

import { logger } from './logger.js';
import { t, toast } from './compatibility.js';
import { stableStringify, formatBytes } from './history-store.js';

let _popup = null;

// =====================================================
// 公共 API
// =====================================================

/**
 * 显示 A/B 对比弹窗
 * @param {object} snapA
 * @param {object} snapB
 */
export async function showDiffPopup(snapA, snapB) {
    if (_popup) {
        try { _popup.completeCancelled?.(); } catch (_) { /* noop */ }
        _popup = null;
    }
    if (!snapA || !snapB) { toast.error(t('Diff Need Two')); return; }
    if (snapA.id === snapB.id) { toast.warning(t('Diff Same Snapshot')); return; }

    let a = snapA, b = snapB;
    if (a.timestamp > b.timestamp) [a, b] = [b, a];

    try {
        const ctx = SillyTavern.getContext();
        const html = buildDiffHTML(a, b);
        _popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
            wide: true, large: true, allowVerticalScrolling: true,
            okButton: false, cancelButton: t('Close'),
        });
        const p = _popup.show();
        setTimeout(() => bindDiffEvents(a, b), 50);
        p.finally(() => { _popup = null; });
    } catch (e) {
        logger.error('Failed to show diff popup:', e);
        toast.error(t('Diff Failed', { message: e?.message || String(e) }));
    }
}

// =====================================================
// LCS Diff 算法
// =====================================================

const MAX_LINES = 800;
const MAX_CHARS = 400;

/** 构建 LCS DP 表 */
function buildDP(a, b) {
    const m = a.length, n = b.length;
    const dp = [];
    for (let i = 0; i <= m; i++) dp[i] = new Uint16Array(n + 1);
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1] + 1
                : (dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]);
        }
    }
    return dp;
}

/** 回溯 LCS 得到 diff 操作列表 */
function backtrack(a, b, dp) {
    const ops = [];
    let i = a.length, j = b.length;
    while (i > 0 && j > 0) {
        if (a[i - 1] === b[j - 1]) {
            ops.push({ type: 'same', ai: i - 1, bi: j - 1 });
            i--; j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            ops.push({ type: 'del', ai: i - 1 });
            i--;
        } else {
            ops.push({ type: 'add', bi: j - 1 });
            j--;
        }
    }
    while (i > 0) { ops.push({ type: 'del', ai: --i }); }
    while (j > 0) { ops.push({ type: 'add', bi: --j }); }
    return ops.reverse();
}

/**
 * 行级 diff，连续 del+add 配对为 mod
 * @returns {Array<{type:'same'|'add'|'del'|'mod', textA?:string, textB?:string}>}
 */
function lineDiff(textA, textB) {
    if (textA === textB) return [];
    const lA = (textA || '').split('\n');
    const lB = (textB || '').split('\n');
    if (lA.length > MAX_LINES || lB.length > MAX_LINES) {
        return [...lA.map(l => ({ type: 'del', textA: l })), ...lB.map(l => ({ type: 'add', textB: l }))];
    }
    const dp = buildDP(lA, lB);
    const raw = backtrack(lA, lB, dp);
    // 将连续 del+add 配对为 mod
    const out = [];
    let k = 0;
    while (k < raw.length) {
        if (raw[k].type === 'same') {
            out.push({ type: 'same', textA: lA[raw[k].ai], textB: lB[raw[k].bi] });
            k++;
            continue;
        }
        const dels = [], adds = [];
        while (k < raw.length && raw[k].type === 'del') { dels.push(lA[raw[k].ai]); k++; }
        while (k < raw.length && raw[k].type === 'add') { adds.push(lB[raw[k].bi]); k++; }
        const pairs = Math.min(dels.length, adds.length);
        for (let p = 0; p < pairs; p++) out.push({ type: 'mod', textA: dels[p], textB: adds[p] });
        for (let p = pairs; p < dels.length; p++) out.push({ type: 'del', textA: dels[p] });
        for (let p = pairs; p < adds.length; p++) out.push({ type: 'add', textB: adds[p] });
    }
    return out;
}

/**
 * 字符级 diff（用于 mod 行内高亮）
 * @returns {Array<{type:'same'|'add'|'del', text:string}>}
 */
function charDiff(strA, strB) {
    if (strA === strB) return [{ type: 'same', text: strA }];
    if (!strA) return [{ type: 'add', text: strB }];
    if (!strB) return [{ type: 'del', text: strA }];
    const a = [...strA], b = [...strB];
    // 剥离公共前缀/后缀降低 LCS 复杂度
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre
        && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const midA = a.slice(pre, a.length - suf);
    const midB = b.slice(pre, b.length - suf);
    const result = [];
    if (pre > 0) result.push({ type: 'same', text: a.slice(0, pre).join('') });
    if (midA.length > MAX_CHARS || midB.length > MAX_CHARS) {
        if (midA.length) result.push({ type: 'del', text: midA.join('') });
        if (midB.length) result.push({ type: 'add', text: midB.join('') });
    } else if (midA.length || midB.length) {
        const dp = buildDP(midA, midB);
        const raw = backtrack(midA, midB, dp);
        for (const op of raw) {
            const ch = op.type === 'add' ? midB[op.bi] : midA[op.ai];
            if (result.length > 0 && result[result.length - 1].type === op.type) {
                result[result.length - 1].text += ch;
            } else {
                result.push({ type: op.type, text: ch });
            }
        }
    }
    if (suf > 0) result.push({ type: 'same', text: a.slice(a.length - suf).join('') });
    return result;
}

// =====================================================
// Diff 计算（三级结构）
// =====================================================

const IMPORTANT = new Set([
    'temperature', 'top_p', 'top_k', 'min_p', 'top_a',
    'frequency_penalty', 'presence_penalty', 'repetition_penalty',
    'openai_max_tokens', 'openai_max_context', 'openai_model',
    'reasoning_effort', 'seed',
]);
const SKIP = new Set([
    'prompts', 'prompt_order', 'extensions', 'preset_settings_openai',
    'name', 'bias_presets', 'bias_preset_selected',
]);
const PFIELDS = ['name', 'role', 'content', 'system_prompt', 'marker',
    'injection_position', 'injection_depth', 'forbid_overrides'];

function computeDiff(a, b) {
    const A = a?.preset || {}, B = b?.preset || {};
    const settings = diffSettings(A, B);
    const prompts  = diffPrompts(A, B);
    const order    = diffOrder(A, B, prompts);
    return {
        settings, prompts, order,
        counts: {
            settingsChanged: settings.filter(s => s.status !== 'same').length,
            promptsModified: prompts.filter(p => p.status === 'modified').length,
            promptsAdded:    prompts.filter(p => p.status === 'added').length,
            promptsDeleted:  prompts.filter(p => p.status === 'deleted').length,
            orderChanged:    order.filter(o => o.status !== 'same').length,
        },
    };
}

function diffSettings(A, B) {
    const keys = [...new Set([...Object.keys(A), ...Object.keys(B)].filter(k => !SKIP.has(k)))].sort();
    return keys.map(k => {
        const av = A[k], bv = B[k];
        const aH = Object.hasOwn(A, k), bH = Object.hasOwn(B, k);
        let status = aH && !bH ? 'only-a' : !aH && bH ? 'only-b' : jsonEq(av, bv) ? 'same' : 'changed';
        let delta = null;
        if (status === 'changed' && typeof av === 'number' && typeof bv === 'number'
            && Number.isFinite(av) && Number.isFinite(bv)) delta = bv - av;
        return { key: k, aVal: av, bVal: bv, status, delta, important: IMPORTANT.has(k) };
    });
}

function diffPrompts(A, B) {
    const aArr = Array.isArray(A.prompts) ? A.prompts : [];
    const bArr = Array.isArray(B.prompts) ? B.prompts : [];
    const aM = new Map(aArr.filter(p => p?.identifier).map(p => [p.identifier, p]));
    const bM = new Map(bArr.filter(p => p?.identifier).map(p => [p.identifier, p]));
    const seen = new Set(), ids = [];
    for (const p of bArr) { if (p?.identifier && !seen.has(p.identifier)) { seen.add(p.identifier); ids.push(p.identifier); } }
    for (const p of aArr) { if (p?.identifier && !seen.has(p.identifier)) { seen.add(p.identifier); ids.push(p.identifier); } }

    return ids.map(id => {
        const ap = aM.get(id), bp = bM.get(id);
        if (ap && !bp) return { id, name: pLabel(ap), status: 'deleted', aP: ap, bP: null, fields: [] };
        if (!ap && bp) return { id, name: pLabel(bp), status: 'added', aP: null, bP: bp, fields: [] };
        let changed = false;
        const fields = [];
        for (const f of PFIELDS) {
            const av = ap[f], bv = bp[f];
            if (av === undefined && bv === undefined) continue;
            const same = jsonEq(av, bv);
            if (!same) changed = true;
            const fd = { field: f, aVal: av, bVal: bv, status: same ? 'same' : 'changed' };
            if (f === 'content' && !same && typeof av === 'string' && typeof bv === 'string') {
                fd.lineDiffs = lineDiff(av, bv);
            }
            fields.push(fd);
        }
        return { id, name: pLabel(bp || ap), status: changed ? 'modified' : 'unchanged', aP: ap, bP: bp, fields };
    });
}

function diffOrder(A, B, promptsDiff) {
    const aO = extractOrd(A.prompt_order), bO = extractOrd(B.prompt_order);
    const nm = new Map(promptsDiff.map(p => [p.id, p.name]));
    const seen = new Set(), ids = [];
    for (const [id] of bO) { if (!seen.has(id)) { seen.add(id); ids.push(id); } }
    for (const [id] of aO) { if (!seen.has(id)) { seen.add(id); ids.push(id); } }
    return ids.map(id => {
        const ae = aO.get(id), be = bO.get(id), name = nm.get(id) || id;
        if (ae && !be) return { id, name, aIdx: ae.idx, bIdx: null, aEn: ae.en, bEn: null, status: 'only-a' };
        if (!ae && be) return { id, name, aIdx: null, bIdx: be.idx, aEn: null, bEn: be.en, status: 'only-b' };
        const pc = ae.idx !== be.idx, ec = !!ae.en !== !!be.en;
        return { id, name, aIdx: ae.idx, bIdx: be.idx, aEn: ae.en, bEn: be.en, pc, ec, status: pc || ec ? 'changed' : 'same' };
    });
}

function extractOrd(po) {
    const m = new Map();
    if (!Array.isArray(po) || !po[0] || !Array.isArray(po[0].order)) return m;
    po[0].order.forEach((o, i) => { if (o?.identifier) m.set(o.identifier, { idx: i, en: !!o.enabled }); });
    return m;
}

// =====================================================
// HTML 构建
// =====================================================

function buildDiffHTML(a, b) {
    const diff = computeDiff(a, b);
    const c = diff.counts;
    return `
<div class="pas-diff-popup">
    <div class="pas-diff-header">
        <h4><i class="fa-solid fa-code-compare"></i> ${esc(t('Diff Title'))}</h4>
    </div>
    <div class="pas-diff-meta">
        <div class="pas-diff-side-meta pas-diff-side-meta-a">${sideMetaHTML('A', a)}</div>
        <div class="pas-diff-side-meta pas-diff-side-meta-b">${sideMetaHTML('B', b)}</div>
    </div>
    <div class="pas-diff-summary-bar">${summaryBarHTML(c)}</div>
    <div class="pas-diff-toolbar">
        <div class="pas-diff-toolbar-left">
            <label class="pas-log-autoscroll" title="${escA(t('Diff Show All Desc'))}" style="margin-right:0;">
                <input type="checkbox" class="pas-diff-show-all">
                <span>${esc(t('Diff Show All'))}</span>
            </label>
        </div>
        <div class="pas-diff-toolbar-right">
            <button class="pas-mini-btn pas-diff-btn-swap" type="button" title="${escA(t('Diff Swap Title'))}">
                <i class="fa-solid fa-arrow-right-arrow-left"></i>
                <span>${esc(t('Diff Swap'))}</span>
            </button>
            <button class="pas-mini-btn pas-diff-btn-export" type="button" title="${escA(t('Diff Export Title'))}">
                <i class="fa-solid fa-download"></i>
                <span>${esc(t('Diff Export'))}</span>
            </button>
        </div>
    </div>
    <div class="pas-diff-body">${bodyHTML(diff, false)}</div>
</div>`;
}

function sideMetaHTML(tag, s) {
    const nm = s.name?.trim() || s.presetName;
    return `<span class="pas-diff-side-meta-tag">${esc(tag)}</span>
        <span class="pas-diff-side-meta-name">${esc(nm)}</span>
        <span class="pas-diff-side-meta-time">${esc(fmtTime(s.timestamp))}</span>
        <span class="pas-diff-side-meta-extra">${formatBytes(s.size || 0)} · <code>${esc(s.hash || '')}</code>${s.pinned ? ' · <i class="fa-solid fa-thumbtack" style="color:var(--pas-c-pin)"></i>' : ''}</span>`;
}

function summaryBarHTML(c) {
    return `
        <span class="pas-diff-summary-item"><i class="fa-solid fa-pen-to-square" style="color:var(--pas-c-edit)"></i> <b>${c.promptsModified}</b> ${esc(t('Diff Prompts Modified'))}</span>
        <span class="pas-diff-summary-item"><i class="fa-solid fa-circle-plus" style="color:var(--pas-c-add)"></i> <b>${c.promptsAdded}</b> ${esc(t('Diff Prompts Added'))}</span>
        <span class="pas-diff-summary-item"><i class="fa-solid fa-circle-minus" style="color:var(--pas-c-del)"></i> <b>${c.promptsDeleted}</b> ${esc(t('Diff Prompts Deleted'))}</span>
        <span class="pas-diff-summary-sep">|</span>
        <span class="pas-diff-summary-item"><i class="fa-solid fa-sliders" style="color:var(--pas-c-info)"></i> <b>${c.settingsChanged}</b> ${esc(t('Diff Params Changed'))}</span>
        <span class="pas-diff-summary-item"><i class="fa-solid fa-arrows-up-down" style="color:var(--pas-c-warn)"></i> <b>${c.orderChanged}</b> ${esc(t('Diff Order Changed'))}</span>`;
}

function bodyHTML(diff, showAll) {
    const hs = diff.settings.some(s => s.status !== 'same');
    const hp = diff.prompts.some(p => p.status !== 'unchanged');
    const ho = diff.order.some(o => o.status !== 'same');
    if (!hs && !hp && !ho && !showAll) {
        return `<div class="pas-diff-no-changes"><i class="fa-solid fa-equals"></i><span>${esc(t('Diff No Changes'))}</span></div>`;
    }
    let h = '';
    if (hp || showAll) h += promptsSectionHTML(diff.prompts, showAll);
    if (hs || showAll) h += settingsSectionHTML(diff.settings, showAll);
    if (ho || showAll) h += orderSectionHTML(diff.order, showAll);
    return h;
}

// ---------- Prompts section ----------

function promptsSectionHTML(prompts, showAll) {
    const vis = showAll ? prompts : prompts.filter(p => p.status !== 'unchanged');
    if (!vis.length) return '';
    return `<div class="pas-diff-section" data-section="prompts">
        <div class="pas-diff-section-head pas-diff-section-toggle">
            <i class="fa-solid fa-list-ul"></i><span>${esc(t('Diff Section Prompts'))}</span>
            <span class="pas-diff-section-count">${vis.length}</span>
            <i class="fa-solid fa-chevron-down pas-diff-section-chevron"></i>
        </div>
        <div class="pas-diff-section-body">${vis.map(promptCardHTML).join('')}</div>
    </div>`;
}

function promptCardHTML(p) {
    const labels = { modified: t('Diff Prompt Modified'), added: t('Diff Prompt Added'), deleted: t('Diff Prompt Deleted'), unchanged: t('Diff Prompt Unchanged') };
    const role = p.bP?.role || p.aP?.role || '';
    let body = '';
    if (p.status === 'added') body = singleContentHTML(p.bP, 'add');
    else if (p.status === 'deleted') body = singleContentHTML(p.aP, 'del');
    else if (p.status === 'modified') body = modifiedBodyHTML(p);

    return `<div class="pas-diff-prompt-card pas-diff-prompt-${esc(p.status)}">
        <div class="pas-diff-prompt-header">
            <span class="pas-diff-prompt-name">${esc(p.name)}</span>
            ${role ? `<span class="pas-diff-prompt-role">${esc(role)}</span>` : ''}
            <span class="pas-diff-prompt-id">${esc(p.id)}</span>
            <span class="pas-diff-prompt-badge pas-diff-badge-${esc(p.status)}">${esc(labels[p.status] || p.status)}</span>
        </div>
        ${body ? `<div class="pas-diff-prompt-body">${body}</div>` : ''}
    </div>`;
}

function singleContentHTML(prompt, type) {
    if (!prompt) return '';
    const content = typeof prompt.content === 'string' ? prompt.content : '';
    if (!content) return `<div class="pas-diff-no-content">${esc(t('Diff No Content'))}</div>`;
    const lines = content.split('\n');
    const cls = type === 'add' ? 'pas-diff-cline-add' : 'pas-diff-cline-del';
    let rows = '';
    for (let i = 0; i < lines.length; i++) {
        const ln = i + 1;
        if (type === 'del') {
            rows += `<div class="pas-diff-cline ${cls}"><div class="pas-diff-cline-a"><span class="pas-diff-ln">${ln}</span><span class="pas-diff-ct">${esc(lines[i]) || '&nbsp;'}</span></div><div class="pas-diff-cline-b"></div></div>`;
        } else {
            rows += `<div class="pas-diff-cline ${cls}"><div class="pas-diff-cline-a"></div><div class="pas-diff-cline-b"><span class="pas-diff-ln">${ln}</span><span class="pas-diff-ct">${esc(lines[i]) || '&nbsp;'}</span></div></div>`;
        }
    }
    return `<div class="pas-diff-content-table">${rows}</div>`;
}

function modifiedBodyHTML(p) {
    let h = '';
    const fc = p.fields.filter(fd => fd.field !== 'content' && fd.status === 'changed');
    if (fc.length) {
        h += '<div class="pas-diff-prompt-fields">';
        for (const fd of fc) {
            const label = t(`Prompt Field ${fd.field}`) || fd.field;
            h += `<div class="pas-diff-prompt-field-row"><span class="pas-diff-prompt-field-label">${esc(label)}:</span> <code class="pas-diff-val-old">${esc(fmtV(fd.aVal))}</code> <span class="pas-diff-arrow">→</span> <code class="pas-diff-val-new">${esc(fmtV(fd.bVal))}</code></div>`;
        }
        h += '</div>';
    }
    const cf = p.fields.find(fd => fd.field === 'content');
    if (cf?.lineDiffs && cf.lineDiffs.length) {
        h += contentTableHTML(cf.lineDiffs);
    } else if (cf && cf.status === 'changed') {
        h += `<div class="pas-diff-prompt-fields"><div class="pas-diff-prompt-field-row"><span class="pas-diff-prompt-field-label">${esc(t('Prompt Field content'))}:</span> <code class="pas-diff-val-old">${esc(fmtV(cf.aVal))}</code> <span class="pas-diff-arrow">→</span> <code class="pas-diff-val-new">${esc(fmtV(cf.bVal))}</code></div></div>`;
    }
    return h;
}

function contentTableHTML(diffs) {
    let aLn = 0, bLn = 0, rows = '';
    for (const d of diffs) {
        if (d.type === 'same') {
            aLn++; bLn++;
            rows += `<div class="pas-diff-cline pas-diff-cline-same"><div class="pas-diff-cline-a"><span class="pas-diff-ln">${aLn}</span><span class="pas-diff-ct">${esc(d.textA) || '&nbsp;'}</span></div><div class="pas-diff-cline-b"><span class="pas-diff-ln">${bLn}</span><span class="pas-diff-ct">${esc(d.textB) || '&nbsp;'}</span></div></div>`;
        } else if (d.type === 'mod') {
            aLn++; bLn++;
            const ch = charDiff(d.textA, d.textB);
            rows += `<div class="pas-diff-cline pas-diff-cline-mod"><div class="pas-diff-cline-a pas-diff-cline-moddel"><span class="pas-diff-ln">${aLn}</span><span class="pas-diff-ct">${charSideHTML(ch, 'del')}</span></div><div class="pas-diff-cline-b pas-diff-cline-modadd"><span class="pas-diff-ln">${bLn}</span><span class="pas-diff-ct">${charSideHTML(ch, 'add')}</span></div></div>`;
        } else if (d.type === 'del') {
            aLn++;
            rows += `<div class="pas-diff-cline pas-diff-cline-del"><div class="pas-diff-cline-a"><span class="pas-diff-ln">${aLn}</span><span class="pas-diff-ct">${esc(d.textA) || '&nbsp;'}</span></div><div class="pas-diff-cline-b"></div></div>`;
        } else {
            bLn++;
            rows += `<div class="pas-diff-cline pas-diff-cline-add"><div class="pas-diff-cline-a"></div><div class="pas-diff-cline-b"><span class="pas-diff-ln">${bLn}</span><span class="pas-diff-ct">${esc(d.textB) || '&nbsp;'}</span></div></div>`;
        }
    }
    return `<div class="pas-diff-content-table">${rows}</div>`;
}

/** 渲染字符级 diff 的一侧：del 侧显示 same+del，add 侧显示 same+add */
function charSideHTML(ops, side) {
    let h = '';
    for (const op of ops) {
        if (op.type === 'same') { h += esc(op.text); continue; }
        if (op.type === side) {
            h += `<span class="pas-diff-c${side}">${esc(op.text)}</span>`;
        }
    }
    return h || '&nbsp;';
}

// ---------- Settings section ----------

function settingsSectionHTML(settings, showAll) {
    const vis = showAll ? settings : settings.filter(s => s.status !== 'same');
    if (!vis.length) return '';
    const sorted = [...vis].sort((a, b) => {
        if (a.important !== b.important) return a.important ? -1 : 1;
        const o = { changed: 0, 'only-a': 1, 'only-b': 2, same: 3 };
        return (o[a.status] ?? 9) - (o[b.status] ?? 9) || a.key.localeCompare(b.key);
    });
    return `<div class="pas-diff-section" data-section="settings">
        <div class="pas-diff-section-head pas-diff-section-toggle">
            <i class="fa-solid fa-sliders"></i><span>${esc(t('Diff Section Settings'))}</span>
            <span class="pas-diff-section-count">${vis.length}</span>
            <i class="fa-solid fa-chevron-down pas-diff-section-chevron"></i>
        </div>
        <div class="pas-diff-section-body"><div class="pas-diff-params-list">${sorted.map(paramRowHTML).join('')}</div></div>
    </div>`;
}

function paramRowHTML(s) {
    const friendly = t(`Field ${s.key}`);
    const hasFN = friendly && friendly !== `Field ${s.key}` && friendly !== s.key;
    let vH = '';
    if (s.status === 'only-a') {
        vH = `<code class="pas-diff-val-old">${esc(fmtV(s.aVal))}</code> <span class="pas-diff-arrow">→</span> <span class="pas-diff-val-gone">${esc(t('Diff Cell Empty'))}</span>`;
    } else if (s.status === 'only-b') {
        vH = `<span class="pas-diff-val-gone">${esc(t('Diff Cell Empty'))}</span> <span class="pas-diff-arrow">→</span> <code class="pas-diff-val-new">${esc(fmtV(s.bVal))}</code>`;
    } else if (s.status === 'changed') {
        vH = `<code class="pas-diff-val-old">${esc(fmtV(s.aVal))}</code> <span class="pas-diff-arrow">→</span> <code class="pas-diff-val-new">${esc(fmtV(s.bVal))}</code>`;
        if (s.delta !== null) {
            const sign = s.delta > 0 ? '+' : '';
            const dc = s.delta > 0 ? 'pas-diff-delta-up' : 'pas-diff-delta-down';
            vH += ` <span class="pas-diff-param-delta ${dc}">(${sign}${rd(s.delta)})</span>`;
        }
    } else {
        vH = `<code class="pas-diff-val-same">${esc(fmtV(s.aVal))}</code>`;
    }
    return `<div class="pas-diff-param-row pas-diff-param-${esc(s.status)}${s.important ? ' pas-diff-param-important' : ''}">
        <span class="pas-diff-param-label">${hasFN ? `<span class="pas-diff-param-fname">${esc(friendly)}</span> ` : ''}<span class="pas-diff-param-key">${esc(s.key)}</span>${s.important ? ' <i class="fa-solid fa-star pas-diff-param-star"></i>' : ''}</span>
        <span class="pas-diff-param-values">${vH}</span>
    </div>`;
}

// ---------- Order section ----------

function orderSectionHTML(order, showAll) {
    const vis = showAll ? order : order.filter(o => o.status !== 'same');
    if (!vis.length) return '';
    return `<div class="pas-diff-section" data-section="order">
        <div class="pas-diff-section-head pas-diff-section-toggle">
            <i class="fa-solid fa-arrows-up-down"></i><span>${esc(t('Diff Section Order'))}</span>
            <span class="pas-diff-section-count">${vis.length}</span>
            <i class="fa-solid fa-chevron-down pas-diff-section-chevron"></i>
        </div>
        <div class="pas-diff-section-body"><div class="pas-diff-order-list">${vis.map(orderRowHTML).join('')}</div></div>
    </div>`;
}

function orderRowHTML(o) {
    let posH = '', enH = '';
    if (o.status === 'only-a') {
        posH = `<span class="pas-diff-order-pos">#${o.aIdx + 1}</span>`;
        enH = `<span class="pas-diff-order-en">${o.aEn ? '✓' : '✗'}</span>`;
    } else if (o.status === 'only-b') {
        posH = `<span class="pas-diff-order-pos">#${o.bIdx + 1}</span>`;
        enH = `<span class="pas-diff-order-en">${o.bEn ? '✓' : '✗'}</span>`;
    } else {
        if (o.pc) {
            const d = o.bIdx - o.aIdx, arr = d < 0 ? '↑' : '↓', ac = d < 0 ? 'pas-diff-order-up' : 'pas-diff-order-down';
            posH = `<span class="pas-diff-order-pos">#${o.aIdx + 1} → #${o.bIdx + 1} <span class="pas-diff-order-arrow ${ac}">${arr}${Math.abs(d)}</span></span>`;
        } else {
            posH = `<span class="pas-diff-order-pos pas-diff-order-pos-same">#${o.aIdx + 1}</span>`;
        }
        if (o.ec) {
            const lbl = o.bEn ? t('Diff Order Enabled') : t('Diff Order Disabled');
            const ec = o.bEn ? 'pas-diff-en-on' : 'pas-diff-en-off';
            enH = `<span class="pas-diff-order-en ${ec}">${o.aEn ? '✓' : '✗'} → ${o.bEn ? '✓' : '✗'} <span class="pas-diff-en-label">${esc(lbl)}</span></span>`;
        } else {
            enH = `<span class="pas-diff-order-en">${o.aEn ? '✓' : '✗'}</span>`;
        }
    }
    return `<div class="pas-diff-order-row pas-diff-order-${esc(o.status)}">
        <span class="pas-diff-order-name">${esc(o.name)}</span>${posH}${enH}
    </div>`;
}

// =====================================================
// 事件绑定
// =====================================================

function bindDiffEvents(a, b) {
    const root = document.querySelector('.pas-diff-popup');
    if (!root) return;
    const showAllCb = root.querySelector('.pas-diff-show-all');
    const body = root.querySelector('.pas-diff-body');
    const swapBtn = root.querySelector('.pas-diff-btn-swap');
    const exportBtn = root.querySelector('.pas-diff-btn-export');

    let curA = a, curB = b, curDiff = computeDiff(curA, curB);

    const refresh = () => {
        if (body) body.innerHTML = bodyHTML(curDiff, !!showAllCb?.checked);
        bindToggles(root);
    };

    showAllCb?.addEventListener('change', refresh);

    swapBtn?.addEventListener('click', () => {
        [curA, curB] = [curB, curA];
        curDiff = computeDiff(curA, curB);
        const ma = root.querySelector('.pas-diff-side-meta-a');
        const mb = root.querySelector('.pas-diff-side-meta-b');
        if (ma) ma.innerHTML = sideMetaHTML('A', curA);
        if (mb) mb.innerHTML = sideMetaHTML('B', curB);
        const bar = root.querySelector('.pas-diff-summary-bar');
        if (bar) bar.innerHTML = summaryBarHTML(curDiff.counts);
        refresh();
    });

    exportBtn?.addEventListener('click', () => {
        try {
            const payload = { version: 2, exportedAt: Date.now(), a: snapExp(curA), b: snapExp(curB), counts: curDiff.counts };
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const el = document.createElement('a');
            el.href = url;
            el.download = `pas-diff-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            document.body.appendChild(el);
            el.click();
            el.remove();
            URL.revokeObjectURL(url);
            toast.success(t('Diff Export Done'));
        } catch (e) {
            logger.error('Diff export failed:', e);
            toast.error(t('Export Failed'));
        }
    });

    bindToggles(root);
}

function bindToggles(root) {
    root.querySelectorAll('.pas-diff-section-toggle').forEach(h => {
        if (h._bound) return;
        h._bound = true;
        h.addEventListener('click', () => {
            const sec = h.closest('.pas-diff-section');
            if (sec) sec.classList.toggle('pas-diff-section-collapsed');
        });
    });
}

function snapExp(s) {
    return s ? { id: s.id, presetName: s.presetName, apiId: s.apiId, timestamp: s.timestamp, trigger: s.trigger, size: s.size, hash: s.hash, name: s.name || '', pinned: !!s.pinned } : null;
}

// =====================================================
// 工具函数
// =====================================================

function pLabel(p) {
    if (!p) return '?';
    if (typeof p.name === 'string' && p.name.trim()) return p.name.trim();
    if (typeof p.identifier === 'string') return p.identifier.length > 24 ? p.identifier.slice(0, 20) + '…' : p.identifier;
    return '?';
}

function jsonEq(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return a === b;
    return stableStringify(a) === stableStringify(b);
}

function fmtV(v) {
    if (v === undefined) return '';
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '∞';
    if (typeof v === 'string') return v.length === 0 ? '""' : v.length > 200 ? v.slice(0, 200) + '…(+' + (v.length - 200) + ')' : v;
    if (Array.isArray(v)) return '[' + v.length + ']';
    if (typeof v === 'object') { const s = stableStringify(v); return s.length > 200 ? s.slice(0, 200) + '…' : s; }
    return String(v);
}

function rd(d) { return parseFloat(d.toFixed(4)); }

function fmtTime(ts) {
    if (!ts) return '—';
    try {
        const d = new Date(ts), pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch (_) { return String(ts); }
}

function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escA(s) { return esc(s); }
