/**
 * Comprehensive module coordination check script
 * Checks: imports/exports, circular deps, residual refs, i18n keys
 */
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const MODULES_DIR = path.join(BASE, 'modules');

// All JS files to check
const ALL_FILES = [
  'index.js',
  'modules/compatibility.js',
  'modules/preset-takeover.js',
  'modules/auto-save.js',
  'modules/history-panel.js',
  'modules/panel-summary.js',
  'modules/panel-settings-log.js',
  'modules/panel-list-render.js',
  'modules/panel-actions.js',
  'modules/history-store.js',
  'modules/preset-grouping.js',
  'modules/settings.js',
  'modules/ui-injector.js',
  'modules/diff-viewer.js',
  'modules/archive-store.js',
  'modules/logger.js',
  'modules/theme-detector.js',
];

let issues = [];
let warnings = [];

// ============================================================
// 1. Parse imports and exports from each file
// ============================================================

function parseImports(content, filePath) {
  const imports = [];
  // Match: import { a, b, c } from './path'
  // Match: import { a as b, c } from './path'
  // Match: import defaultExport from './path'
  // Match: import * as name from './path'
  const importRegex = /import\s+(?:(\{[^}]+\})|(\*\s+as\s+\w+)|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const namedBlock = match[1];
    const starImport = match[2];
    const defaultImport = match[3];
    const fromPath = match[4];

    // Only check local imports (starting with ./ or ../)
    if (!fromPath.startsWith('.')) continue;

    const symbols = [];
    if (namedBlock) {
      // Parse { a, b as c, d }
      const inner = namedBlock.replace(/[{}]/g, '');
      inner.split(',').forEach(s => {
        s = s.trim();
        if (!s) return;
        // handle "a as b" - we need the original name (a)
        const asMatch = s.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) {
          symbols.push({ exported: asMatch[1], local: asMatch[2] });
        } else {
          symbols.push({ exported: s, local: s });
        }
      });
    }
    if (defaultImport) {
      symbols.push({ exported: 'default', local: defaultImport });
    }
    if (starImport) {
      // namespace import, skip symbol check
      continue;
    }

    // Resolve the path
    const dir = path.dirname(path.join(BASE, filePath));
    let resolved = path.resolve(dir, fromPath);
    if (!resolved.endsWith('.js')) resolved += '.js';
    const relative = path.relative(BASE, resolved).replace(/\\/g, '/');

    imports.push({
      from: relative,
      fromRaw: fromPath,
      symbols,
    });
  }
  return imports;
}

function parseExports(content, filePath) {
  const exports = new Set();

  // export function name(
  const funcRegex = /export\s+function\s+(\w+)/g;
  let m;
  while ((m = funcRegex.exec(content)) !== null) exports.add(m[1]);

  // export async function name(
  const asyncFuncRegex = /export\s+async\s+function\s+(\w+)/g;
  while ((m = asyncFuncRegex.exec(content)) !== null) exports.add(m[1]);

  // export const/let/var name
  const varRegex = /export\s+(?:const|let|var)\s+(\w+)/g;
  while ((m = varRegex.exec(content)) !== null) exports.add(m[1]);

  // export class name
  const classRegex = /export\s+class\s+(\w+)/g;
  while ((m = classRegex.exec(content)) !== null) exports.add(m[1]);

  // export { a, b, c }
  const blockRegex = /export\s+\{([^}]+)\}/g;
  while ((m = blockRegex.exec(content)) !== null) {
    m[1].split(',').forEach(s => {
      s = s.trim();
      if (!s) return;
      const asMatch = s.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch) {
        exports.add(asMatch[2]); // exported name
      } else {
        exports.add(s);
      }
    });
  }

  // export default
  if (/export\s+default\s+/.test(content)) {
    exports.add('default');
  }

  return exports;
}

console.log('========================================');
console.log('  IMPORT/EXPORT COMPLETENESS CHECK');
console.log('========================================\n');

const fileExports = {};
const fileImports = {};
const fileContents = {};

// First pass: collect all exports
for (const f of ALL_FILES) {
  const fullPath = path.join(BASE, f);
  const content = fs.readFileSync(fullPath, 'utf8');
  fileContents[f] = content;
  fileExports[f] = parseExports(content, f);
  fileImports[f] = parseImports(content, f);
}

// Second pass: verify imports
for (const f of ALL_FILES) {
  const imports = fileImports[f];
  for (const imp of imports) {
    const targetFile = imp.from;
    const targetExports = fileExports[targetFile];

    if (!targetExports) {
      // Target file not in our list (external dep)
      continue;
    }

    for (const sym of imp.symbols) {
      if (sym.exported === 'default') continue; // skip default checks for now
      if (!targetExports.has(sym.exported)) {
        issues.push(`[IMPORT MISSING] ${f} imports '${sym.exported}' from '${targetFile}', but it's not exported there.`);
      }
    }
  }
}

// Print results
if (issues.length === 0) {
  console.log('✅ All imports verified - every imported symbol is exported by its source.\n');
} else {
  console.log('❌ Import/Export issues found:\n');
  issues.forEach(i => console.log('  ' + i));
  console.log('');
}

// ============================================================
// 2. Circular Dependency Check
// ============================================================

console.log('========================================');
console.log('  CIRCULAR DEPENDENCY CHECK');
console.log('========================================\n');

// Build adjacency list
const depGraph = {};
for (const f of ALL_FILES) {
  depGraph[f] = [];
  for (const imp of fileImports[f]) {
    if (ALL_FILES.includes(imp.from)) {
      depGraph[f].push(imp.from);
    }
  }
}

// Print dependency graph
console.log('Dependency Graph:');
for (const f of ALL_FILES) {
  const deps = depGraph[f];
  if (deps.length > 0) {
    console.log(`  ${f} → ${deps.map(d => d.replace('modules/', '')).join(', ')}`);
  } else {
    console.log(`  ${f} → (none)`);
  }
}
console.log('');

// DFS cycle detection
function findCycles(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  const cycles = [];

  for (const node of Object.keys(graph)) color[node] = WHITE;

  function dfs(node, pathStack) {
    color[node] = GRAY;
    pathStack.push(node);

    for (const neighbor of (graph[node] || [])) {
      if (color[neighbor] === GRAY) {
        // Found cycle
        const cycleStart = pathStack.indexOf(neighbor);
        const cycle = pathStack.slice(cycleStart).concat(neighbor);
        cycles.push(cycle);
      } else if (color[neighbor] === WHITE) {
        dfs(neighbor, pathStack);
      }
    }

    pathStack.pop();
    color[node] = BLACK;
  }

  for (const node of Object.keys(graph)) {
    if (color[node] === WHITE) {
      dfs(node, []);
    }
  }

  return cycles;
}

const cycles = findCycles(depGraph);
if (cycles.length === 0) {
  console.log('✅ No circular dependencies detected.\n');
} else {
  console.log('❌ Circular dependencies found:\n');
  cycles.forEach(c => {
    console.log('  ' + c.join(' → '));
    issues.push(`[CIRCULAR DEP] ${c.join(' → ')}`);
  });
  console.log('');
}

// ============================================================
// 3. Residual Reference Check
// ============================================================

console.log('========================================');
console.log('  RESIDUAL REFERENCE CHECK');
console.log('========================================\n');

const residualPatterns = [
  { pattern: /\bregisterPresetDataResolver\b/g, name: 'registerPresetDataResolver' },
  { pattern: /\brestoreAllDom\b/g, name: 'restoreAllDom' },
  { pattern: /\bonSelectChangeIntercept\b/g, name: 'onSelectChangeIntercept' },
  { pattern: /\b_detachedOptions\b/g, name: '_detachedOptions' },
  { pattern: /data-pas-orig-text/g, name: 'data-pas-orig-text' },
  { pattern: /data-pas-rep\b/g, name: 'data-pas-rep' },
  { pattern: /data-pas-hidden/g, name: 'data-pas-hidden' },
  { pattern: /\btakeoverHideMode\b/g, name: 'takeoverHideMode' },
  { pattern: /\btakeoverDataConfirmed\b/g, name: 'takeoverDataConfirmed' },
];

// For takeoverMode as JS identifier (not in strings)
const takeoverModePattern = {
  // Match takeoverMode that is NOT inside a string literal
  check: (content, filePath) => {
    const hits = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment lines
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      // Check for takeoverMode as identifier (not in string)
      if (/\btakeoverMode\b/.test(line)) {
        // Check it's not inside quotes
        const stripped = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
        if (/\btakeoverMode\b/.test(stripped)) {
          hits.push({ line: i + 1, text: line.trim() });
        }
      }
    }
    return hits;
  },
  name: 'takeoverMode (as JS identifier)'
};

// TRIGGER_LABELS usage (not definition)
const triggerLabelsPattern = {
  check: (content, filePath) => {
    const hits = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\bTRIGGER_LABELS\b/.test(line)) {
        // Exclude definition lines (export const TRIGGER_LABELS = ...)
        if (!/export\s+const\s+TRIGGER_LABELS/.test(line) && !/^\s*const\s+TRIGGER_LABELS/.test(line)) {
          hits.push({ line: i + 1, text: line.trim() });
        }
      }
    }
    return hits;
  },
  name: 'TRIGGER_LABELS (usage, not definition)'
};

let residualFound = false;

for (const f of ALL_FILES) {
  const content = fileContents[f];

  for (const p of residualPatterns) {
    p.pattern.lastIndex = 0;
    const matches = content.match(p.pattern);
    if (matches && matches.length > 0) {
      // Find line numbers
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        p.pattern.lastIndex = 0;
        if (p.pattern.test(lines[i])) {
          // Skip if it's in a comment
          const trimmed = lines[i].trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          console.log(`  ⚠️  ${f}:${i + 1} - residual '${p.name}': ${trimmed}`);
          issues.push(`[RESIDUAL] ${f}:${i + 1} - '${p.name}' still referenced`);
          residualFound = true;
        }
      }
    }
  }

  // Check takeoverMode as JS identifier
  const tmHits = takeoverModePattern.check(content, f);
  for (const hit of tmHits) {
    console.log(`  ⚠️  ${f}:${hit.line} - residual '${takeoverModePattern.name}': ${hit.text}`);
    issues.push(`[RESIDUAL] ${f}:${hit.line} - '${takeoverModePattern.name}' still referenced`);
    residualFound = true;
  }

  // Check TRIGGER_LABELS usage
  const tlHits = triggerLabelsPattern.check(content, f);
  for (const hit of tlHits) {
    console.log(`  ⚠️  ${f}:${hit.line} - residual '${triggerLabelsPattern.name}': ${hit.text}`);
    issues.push(`[RESIDUAL] ${f}:${hit.line} - '${triggerLabelsPattern.name}' still referenced`);
    residualFound = true;
  }
}

// Also check style.css and HTML templates in JS
const cssContent = fs.readFileSync(path.join(BASE, 'style.css'), 'utf8');
for (const p of residualPatterns) {
  p.pattern.lastIndex = 0;
  if (p.pattern.test(cssContent)) {
    const lines = cssContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
      p.pattern.lastIndex = 0;
      if (p.pattern.test(lines[i])) {
        console.log(`  ⚠️  style.css:${i + 1} - residual '${p.name}': ${lines[i].trim()}`);
        issues.push(`[RESIDUAL] style.css:${i + 1} - '${p.name}' still referenced`);
        residualFound = true;
      }
    }
  }
}

if (!residualFound) {
  console.log('✅ No residual references to deleted symbols found.\n');
} else {
  console.log('');
}

// ============================================================
// 4. i18n Key Completeness
// ============================================================

console.log('========================================');
console.log('  I18N KEY COMPLETENESS CHECK');
console.log('========================================\n');

const enUs = JSON.parse(fs.readFileSync(path.join(BASE, 'i18n/en-us.json'), 'utf8'));
const zhCn = JSON.parse(fs.readFileSync(path.join(BASE, 'i18n/zh-cn.json'), 'utf8'));

const enKeys = new Set(Object.keys(enUs));
const zhKeys = new Set(Object.keys(zhCn));

const missingInZh = [...enKeys].filter(k => !zhKeys.has(k));
const missingInEn = [...zhKeys].filter(k => !enKeys.has(k));

if (missingInZh.length > 0) {
  console.log('❌ Keys in en-us.json but missing in zh-cn.json:');
  missingInZh.forEach(k => {
    console.log(`  - ${k}`);
    issues.push(`[I18N] Key '${k}' in en-us.json but missing in zh-cn.json`);
  });
  console.log('');
}

if (missingInEn.length > 0) {
  console.log('❌ Keys in zh-cn.json but missing in en-us.json:');
  missingInEn.forEach(k => {
    console.log(`  - ${k}`);
    issues.push(`[I18N] Key '${k}' in zh-cn.json but missing in en-us.json`);
  });
  console.log('');
}

if (missingInZh.length === 0 && missingInEn.length === 0) {
  console.log(`✅ Both i18n files have identical key sets (${enKeys.size} keys).\n`);
}

// ============================================================
// SUMMARY
// ============================================================

console.log('========================================');
console.log('  SUMMARY');
console.log('========================================\n');

if (issues.length === 0) {
  console.log('🎉 ALL CHECKS PASSED! No issues found.\n');
} else {
  console.log(`❌ ${issues.length} issue(s) found:\n`);
  issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
  console.log('');
}

process.exit(issues.length > 0 ? 1 : 0);
