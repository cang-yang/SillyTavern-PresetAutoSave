/**
 * SillyTavern Preset Auto Save - Diff Viewer
 * 快照对比可视化（A vs B）
 *
 * 设计：
 *   - 输入两个 snapshot，输出一个 ST Popup
 *   - 三段：Settings 标量 / Prompts 详情 / Order
 *   - 仅显示有差异的行（默认）/ 显示全部（切换）
 *   - 数值/字符串差异：左右两列分色显示，截断长字符串
 *   - 仅一边存在的项：用 only-A / only-B 视觉
 */

import { logger } from './logger.js';
import { t, toast } from './compatibility.js';
import { stableStringify, formatBytes } from './history-store.js';

let _popup = null;

/**
 * 显示 A/B 对比
 * @param {object} snapA
 * @param {object} snapB
 */
export async function showDiffPopup(snapA, snapB) {
    if (_popup) {
        try { _popup.completeCancelled?.(); } catch (_) {}
        _popup = null;
    }
    if (!snapA || !snapB) {
        toast.error(t('Diff Need Two'));
        return;
    }
    if (snapA.id === snapB.id) {
        toast.warning(t('Diff Same Snapshot'));
        return;
    }

    // 时间倒序：旧 = A，新 = B（更符合阅读直觉，"A → B" 像变化方向）
    let a = snapA, b = snapB;
    if (a.timestamp > b.timestamp) {
        [a, b] = [b, a];
    }

    try {
        const ctx = SillyTavern.getContext();
        const html = buildDiffHTML(a, b);

        _popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: false,
            cancelButton: t('Close'),
        });

        const showPromise = _popup.show();
        // 等 DOM 进 popup 再绑事件
        setTimeout(() => bindDiffEvents(a, b), 50);

        showPromise.finally(() => { _popup = null; });
    } catch (e) {
        logger.error('Failed to show diff popup:', e);
        toast.error(t('Diff Failed', { message: e?.message || String(e) }));
    }
}

// =====================================================
// 计算 diff
// =====================================================
const SECTION_KIND = Object.freeze({
    SETTINGS: 'settings',
    PROMPTS: 'prompts',
    ORDER: 'order',
});

/**
 * 计算所有 diff 行
 * @returns {{
 *   rows: Array<{section, key, label, aVal, bVal, status}>,
 *   counts: { changed: number, onlyA: number, onlyB: number, total: number }
 * }}
 *
 * status: 'same' | 'changed' | 'only-a' | 'only-b'
 */
function computeDiff(a, b) {
    const A = a?.preset || {};
    const B = b?.preset || {};

    const rows = [];

    // ---------- Settings 标量 ----------
    const IGNORE = new Set(['prompts', 'prompt_order', 'extensions', 'preset_settings_openai', 'name', 'bias_presets', 'bias_preset_selected']);
    const allKeys = new Set([...Object.keys(A), ...Object.keys(B)].filter(k => !IGNORE.has(k)));
    const sortedKeys = [...allKeys].sort();
    for (const k of sortedKeys) {
        const aVal = A[k];
        const bVal = B[k];
        const aHas = Object.hasOwn(A, k);
        const bHas = Object.hasOwn(B, k);
        let status;
        if (aHas && !bHas) status = 'only-a';
        else if (!aHas && bHas) status = 'only-b';
        else if (jsonEqual(aVal, bVal)) status = 'same';
        else status = 'changed';

        rows.push({
            section: SECTION_KIND.SETTINGS,
            key: k,
            label: k,
            aVal: formatValueForDiff(aVal),
            bVal: formatValueForDiff(bVal),
            aRaw: aVal,
            bRaw: bVal,
            status,
        });
    }

    // ---------- Prompts ----------
    const aPrompts = Array.isArray(A.prompts) ? A.prompts : [];
    const bPrompts = Array.isArray(B.prompts) ? B.prompts : [];
    const aMap = new Map(aPrompts.filter(p => p && p.identifier).map(p => [p.identifier, p]));
    const bMap = new Map(bPrompts.filter(p => p && p.identifier).map(p => [p.identifier, p]));
    const allIds = new Set([...aMap.keys(), ...bMap.keys()]);
    for (const id of allIds) {
        const ap = aMap.get(id);
        const bp = bMap.get(id);
        if (ap && !bp) {
            rows.push({
                section: SECTION_KIND.PROMPTS,
                key: id,
                label: getPromptLabel(ap),
                aVal: summarizePrompt(ap),
                bVal: '',
                aRaw: ap,
                bRaw: undefined,
                status: 'only-a',
            });
        } else if (!ap && bp) {
            rows.push({
                section: SECTION_KIND.PROMPTS,
                key: id,
                label: getPromptLabel(bp),
                aVal: '',
                bVal: summarizePrompt(bp),
                aRaw: undefined,
                bRaw: bp,
                status: 'only-b',
            });
        } else {
            // 两边都有 → 字段级对比
            const watch = ['name', 'role', 'content', 'system_prompt', 'marker', 'injection_position', 'injection_depth', 'forbid_overrides'];
            for (const f of watch) {
                const av = ap[f];
                const bv = bp[f];
                if (jsonEqual(av, bv)) {
                    // 相同字段也产出一行（让"显示全部"能看到），但标记 same
                    if (av !== undefined || bv !== undefined) {
                        rows.push({
                            section: SECTION_KIND.PROMPTS,
                            key: `${id}::${f}`,
                            label: `${getPromptLabel(bp || ap)} · ${f}`,
                            aVal: formatValueForDiff(av, f),
                            bVal: formatValueForDiff(bv, f),
                            aRaw: av,
                            bRaw: bv,
                            status: 'same',
                        });
                    }
                    continue;
                }
                rows.push({
                    section: SECTION_KIND.PROMPTS,
                    key: `${id}::${f}`,
                    label: `${getPromptLabel(bp || ap)} · ${f}`,
                    aVal: formatValueForDiff(av, f),
                    bVal: formatValueForDiff(bv, f),
                    aRaw: av,
                    bRaw: bv,
                    status: 'changed',
                });
            }
        }
    }

    // ---------- Order（启用状态 + 顺序） ----------
    const aOrder = extractOrder(A.prompt_order);
    const bOrder = extractOrder(B.prompt_order);
    const orderKeys = new Set([...aOrder.keys(), ...bOrder.keys()]);
    for (const id of orderKeys) {
        const aEntry = aOrder.get(id); // { idx, enabled }
        const bEntry = bOrder.get(id);
        if (aEntry && !bEntry) {
            rows.push({
                section: SECTION_KIND.ORDER,
                key: id,
                label: getPromptLabelByIdRef(id, aMap, bMap),
                aVal: `#${aEntry.idx + 1}  ${aEntry.enabled ? '✓' : '✗'}`,
                bVal: '',
                aRaw: aEntry,
                bRaw: undefined,
                status: 'only-a',
            });
        } else if (!aEntry && bEntry) {
            rows.push({
                section: SECTION_KIND.ORDER,
                key: id,
                label: getPromptLabelByIdRef(id, aMap, bMap),
                aVal: '',
                bVal: `#${bEntry.idx + 1}  ${bEntry.enabled ? '✓' : '✗'}`,
                aRaw: undefined,
                bRaw: bEntry,
                status: 'only-b',
            });
        } else {
            const idxChanged = aEntry.idx !== bEntry.idx;
            const enChanged = !!aEntry.enabled !== !!bEntry.enabled;
            const status = (idxChanged || enChanged) ? 'changed' : 'same';
            rows.push({
                section: SECTION_KIND.ORDER,
                key: id,
                label: getPromptLabelByIdRef(id, aMap, bMap),
                aVal: `#${aEntry.idx + 1}  ${aEntry.enabled ? '✓' : '✗'}`,
                bVal: `#${bEntry.idx + 1}  ${bEntry.enabled ? '✓' : '✗'}`,
                aRaw: aEntry,
                bRaw: bEntry,
                status,
            });
        }
    }

    const counts = {
        changed: rows.filter(r => r.status === 'changed').length,
        onlyA:   rows.filter(r => r.status === 'only-a').length,
        onlyB:   rows.filter(r => r.status === 'only-b').length,
        total:   rows.length,
    };

    return { rows, counts };
}

function extractOrder(prompt_order) {
    const out = new Map();
    if (!Array.isArray(prompt_order) || !prompt_order[0] || !Array.isArray(prompt_order[0].order)) return out;
    const arr = prompt_order[0].order;
    for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        if (o && o.identifier) out.set(o.identifier, { idx: i, enabled: !!o.enabled });
    }
    return out;
}

function getPromptLabel(p) {
    if (!p) return '?';
    if (typeof p.name === 'string' && p.name.trim()) return p.name.trim();
    if (typeof p.identifier === 'string') {
        return p.identifier.length > 18 ? p.identifier.slice(0, 14) + '…' : p.identifier;
    }
    return '?';
}

function getPromptLabelByIdRef(id, aMap, bMap) {
    const p = bMap.get(id) || aMap.get(id);
    return getPromptLabel(p) + (id ? ` · ${id.length > 12 ? id.slice(0, 10) + '…' : id}` : '');
}

/**
 * 把一个 prompt 简要描述（用于 only-A / only-B 行）
 */
function summarizePrompt(p) {
    if (!p || typeof p !== 'object') return '';
    const role = p.role || '';
    const len = (typeof p.content === 'string') ? p.content.length : 0;
    return `${role || '—'} · ${len} chars`;
}

/**
 * 把任意值格式化为单元格里的可读字符串
 * - content 字段截断到 240
 * - 超长字符串显示前后片段
 * - 对象转 stableStringify 截断
 */
function formatValueForDiff(v, fieldName = '') {
    if (v === undefined) return '';
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '∞';
    if (typeof v === 'string') {
        const limit = (fieldName === 'content') ? 240 : 160;
        if (v.length <= limit) return v || '""';
        return v.slice(0, limit) + ` …(+${v.length - limit})`;
    }
    if (Array.isArray(v)) {
        return `[${v.length}] ${truncate(stableStringify(v), 200)}`;
    }
    if (typeof v === 'object') {
        return truncate(stableStringify(v), 200);
    }
    return String(v);
}

function truncate(s, n) {
    if (typeof s !== 'string') return String(s);
    return s.length <= n ? s : s.slice(0, n) + '…';
}

function jsonEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return a === b;
    return stableStringify(a) === stableStringify(b);
}

// =====================================================
// HTML 构建
// =====================================================
function buildDiffHTML(a, b) {
    const aTime = formatTime(a.timestamp);
    const bTime = formatTime(b.timestamp);
    const aName = a.name?.trim() || a.presetName;
    const bName = b.name?.trim() || b.presetName;

    const { rows, counts } = computeDiff(a, b);
    const html = renderRows(rows, /* showAll */ false);

    return `
<div class="pas-diff-popup">
    <div class="pas-diff-header">
        <h4>
            <i class="fa-solid fa-code-compare"></i>
            ${escapeHtml(t('Diff Title'))}
        </h4>
    </div>

    <div class="pas-diff-meta">
        <div class="pas-diff-side-meta pas-diff-side-meta-a">
            <span class="pas-diff-side-meta-tag">A</span>
            <span class="pas-diff-side-meta-name">${escapeHtml(aName)}</span>
            <span class="pas-diff-side-meta-time">${escapeHtml(aTime)}</span>
            <span class="pas-diff-side-meta-extra">
                ${formatBytes(a.size || 0)} · <code>${escapeHtml(a.hash || '')}</code>
                ${a.pinned ? ` · <i class="fa-solid fa-thumbtack" style="color:var(--pas-c-pin)"></i>` : ''}
            </span>
        </div>
        <div class="pas-diff-side-meta pas-diff-side-meta-b">
            <span class="pas-diff-side-meta-tag">B</span>
            <span class="pas-diff-side-meta-name">${escapeHtml(bName)}</span>
            <span class="pas-diff-side-meta-time">${escapeHtml(bTime)}</span>
            <span class="pas-diff-side-meta-extra">
                ${formatBytes(b.size || 0)} · <code>${escapeHtml(b.hash || '')}</code>
                ${b.pinned ? ` · <i class="fa-solid fa-thumbtack" style="color:var(--pas-c-pin)"></i>` : ''}
            </span>
        </div>
    </div>

    <div class="pas-diff-toolbar">
        <div class="pas-diff-toolbar-left">
            <span class="pas-diff-counter">
                <i class="fa-solid fa-pen-to-square" style="color:var(--pas-c-edit)"></i>
                ${escapeHtml(t('Diff Changed'))} <b id="pas-diff-cnt-changed">${counts.changed}</b>
            </span>
            <span class="pas-diff-counter">
                <i class="fa-solid fa-circle-minus" style="color:var(--pas-c-a)"></i>
                ${escapeHtml(t('Diff Only A'))} <b id="pas-diff-cnt-onlya">${counts.onlyA}</b>
            </span>
            <span class="pas-diff-counter">
                <i class="fa-solid fa-circle-plus" style="color:var(--pas-c-b)"></i>
                ${escapeHtml(t('Diff Only B'))} <b id="pas-diff-cnt-onlyb">${counts.onlyB}</b>
            </span>
        </div>
        <div class="pas-diff-toolbar-right">
            <label class="pas-log-autoscroll" title="${escapeAttr(t('Diff Show All Desc'))}" style="margin-right:0;">
                <input type="checkbox" class="pas-diff-show-all">
                <span>${escapeHtml(t('Diff Show All'))}</span>
            </label>
            <button class="pas-mini-btn pas-diff-btn-swap" type="button" title="${escapeAttr(t('Diff Swap Title'))}">
                <i class="fa-solid fa-arrow-right-arrow-left"></i>
                <span>${escapeHtml(t('Diff Swap'))}</span>
            </button>
            <button class="pas-mini-btn pas-diff-btn-export" type="button" title="${escapeAttr(t('Diff Export Title'))}">
                <i class="fa-solid fa-download"></i>
                <span>${escapeHtml(t('Diff Export'))}</span>
            </button>
        </div>
    </div>

    <div class="pas-diff-body">${html}</div>
</div>`;
}

/**
 * 渲染 diff 主体（按 section 分块）
 */
function renderRows(rows, showAll) {
    const filtered = showAll ? rows : rows.filter(r => r.status !== 'same');
    if (filtered.length === 0) {
        return `<div class="pas-diff-no-changes">
            <i class="fa-solid fa-equals"></i>
            <span>${escapeHtml(t('Diff No Changes'))}</span>
        </div>`;
    }

    const sectionLabels = {
        [SECTION_KIND.SETTINGS]: { label: t('Diff Section Settings'), icon: 'fa-sliders' },
        [SECTION_KIND.PROMPTS]:  { label: t('Diff Section Prompts'),  icon: 'fa-list-ul' },
        [SECTION_KIND.ORDER]:    { label: t('Diff Section Order'),    icon: 'fa-arrows-up-down' },
    };

    let html = '';
    let lastSection = null;
    for (const r of filtered) {
        if (r.section !== lastSection) {
            const meta = sectionLabels[r.section] || { label: r.section, icon: 'fa-folder' };
            html += `<div class="pas-diff-section-head">
                <i class="fa-solid ${meta.icon}"></i>
                <span>${escapeHtml(meta.label)}</span>
            </div>`;
            lastSection = r.section;
        }
        html += renderRow(r);
    }
    return html;
}

function renderRow(r) {
    const aCls = cellClassFor(r, 'a');
    const bCls = cellClassFor(r, 'b');
    const aHtml = renderCell(r.aVal, r.status === 'only-a', r);
    const bHtml = renderCell(r.bVal, r.status === 'only-b', r);

    return `<div class="pas-diff-row" data-status="${escapeAttr(r.status)}">
        <div class="pas-diff-row-key">${escapeHtml(r.label)}</div>
        <div class="pas-diff-cell ${aCls}">${aHtml}</div>
        <div class="pas-diff-cell ${bCls}">${bHtml}</div>
    </div>`;
}

function cellClassFor(r, side) {
    if (r.status === 'only-a' && side === 'a') return 'pas-diff-cell-only-a';
    if (r.status === 'only-b' && side === 'b') return 'pas-diff-cell-only-b';
    if (r.status === 'changed') return side === 'a' ? 'pas-diff-cell-changed-a' : 'pas-diff-cell-changed-b';
    return '';
}

function renderCell(val, isOnly, _r) {
    if (val === '' || val === undefined || val === null) {
        return `<span class="pas-diff-cell-empty">${escapeHtml(t('Diff Cell Empty'))}</span>`;
    }
    return escapeHtml(val);
}

// =====================================================
// 事件绑定
// =====================================================
function bindDiffEvents(a, b) {
    const root = document.querySelector('.pas-diff-popup');
    if (!root) return;

    const showAll = root.querySelector('.pas-diff-show-all');
    const body = root.querySelector('.pas-diff-body');
    const swap = root.querySelector('.pas-diff-btn-swap');
    const exportBtn = root.querySelector('.pas-diff-btn-export');

    let { rows } = computeDiff(a, b);
    let curA = a, curB = b;

    const refreshBody = () => {
        const html = renderRows(rows, !!showAll?.checked);
        if (body) body.innerHTML = html;
    };

    showAll?.addEventListener('change', refreshBody);

    swap?.addEventListener('click', () => {
        [curA, curB] = [curB, curA];
        const next = computeDiff(curA, curB);
        rows = next.rows;
        // 更新 meta + 计数
        updateMetaAfterSwap(root, curA, curB, next.counts);
        refreshBody();
    });

    exportBtn?.addEventListener('click', () => {
        try {
            const payload = {
                version: 1,
                exportedAt: Date.now(),
                a: snapshotForExport(curA),
                b: snapshotForExport(curB),
                rows: rows.map(r => ({
                    section: r.section,
                    key: r.key,
                    label: r.label,
                    status: r.status,
                    aVal: r.aVal,
                    bVal: r.bVal,
                })),
            };
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const aEl = document.createElement('a');
            aEl.href = url;
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            aEl.download = `pas-diff-${ts}.json`;
            document.body.appendChild(aEl);
            aEl.click();
            aEl.remove();
            URL.revokeObjectURL(url);
            toast.success(t('Diff Export Done'));
        } catch (e) {
            logger.error('Diff export failed:', e);
            toast.error(t('Export Failed'));
        }
    });
}

function snapshotForExport(s) {
    if (!s) return null;
    return {
        id: s.id,
        presetName: s.presetName,
        apiId: s.apiId,
        timestamp: s.timestamp,
        trigger: s.trigger,
        size: s.size,
        hash: s.hash,
        name: s.name || '',
        pinned: !!s.pinned,
    };
}

function updateMetaAfterSwap(root, a, b, counts) {
    const aTime = formatTime(a.timestamp);
    const bTime = formatTime(b.timestamp);
    const aName = a.name?.trim() || a.presetName;
    const bName = b.name?.trim() || b.presetName;

    const ma = root.querySelector('.pas-diff-side-meta-a');
    const mb = root.querySelector('.pas-diff-side-meta-b');
    if (ma) {
        ma.innerHTML = `
            <span class="pas-diff-side-meta-tag">A</span>
            <span class="pas-diff-side-meta-name">${escapeHtml(aName)}</span>
            <span class="pas-diff-side-meta-time">${escapeHtml(aTime)}</span>
            <span class="pas-diff-side-meta-extra">
                ${formatBytes(a.size || 0)} · <code>${escapeHtml(a.hash || '')}</code>
                ${a.pinned ? ` · <i class="fa-solid fa-thumbtack" style="color:var(--pas-c-pin)"></i>` : ''}
            </span>`;
    }
    if (mb) {
        mb.innerHTML = `
            <span class="pas-diff-side-meta-tag">B</span>
            <span class="pas-diff-side-meta-name">${escapeHtml(bName)}</span>
            <span class="pas-diff-side-meta-time">${escapeHtml(bTime)}</span>
            <span class="pas-diff-side-meta-extra">
                ${formatBytes(b.size || 0)} · <code>${escapeHtml(b.hash || '')}</code>
                ${b.pinned ? ` · <i class="fa-solid fa-thumbtack" style="color:var(--pas-c-pin)"></i>` : ''}
            </span>`;
    }
    const cChanged = root.querySelector('#pas-diff-cnt-changed');
    const cOnlyA = root.querySelector('#pas-diff-cnt-onlya');
    const cOnlyB = root.querySelector('#pas-diff-cnt-onlyb');
    if (cChanged) cChanged.textContent = String(counts.changed);
    if (cOnlyA)   cOnlyA.textContent   = String(counts.onlyA);
    if (cOnlyB)   cOnlyB.textContent   = String(counts.onlyB);
}

// =====================================================
// 工具
// =====================================================
function formatTime(ts) {
    if (!ts) return '—';
    try {
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch (_) {
        return String(ts);
    }
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeAttr(s) {
    return escapeHtml(s);
}
