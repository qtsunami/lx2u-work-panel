// Smoke test: render the report page (weekly and monthly) plus the evidence sidebar.
// The report view is a whole separate layout, so this walks the real tree to catch
// structural errors in the editor, preview, reference badges and period controls.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const now = new Date().toISOString();
const TASK = {
  id: 't-1', title: '上线插件', description: '', status: 'done',
  urgency: 'high', progress: 100, deadline: '2026-11-10',
  expected: 'v1 发布', nextStep: '', blockedReason: '', completedAt: now, deletedAt: null,
  createdAt: now, updatedAt: now,
};
const LOGS = [{ id: 'l-1', taskId: 't-1', at: now, kind: 'progress', text: '完成发布', source: 'manual' }];
const localStorage = {
  getItem: (k) => {
    if (k === '@local/work-panel:tasks:v1') return JSON.stringify([TASK]);
    if (k === '@local/work-panel:logs:v1') return JSON.stringify(LOGS);
    return null;
  },
  setItem: () => {}, removeItem: () => {},
};

const BODY = [
  '## 一、本期主要成果',
  '- 上线插件已完成 [[task:t-1]]',
  '## 二、重点工作进展',
  '- 完成发布 [[log:l-1]]',
  '- 编造引用 [[task:t-404]]',
].join('\n');

// useState order in WorkPanel (report states are the last block):
// 1 tasks, 2 logs, 3 artifacts, 4 activeView, 5 sortBy, 6 search, 7 selectedId,
// 8 collapsedGroups, 9 quickText, 10 quickDeadline, 11 calOpen, 12 calMonth,
// 13 messages, 14 cmdInput, 15 sending, 16 assistantOpen, 17 theme, 18 flagOpen,
// 19 detailCalOpen, 20 detailCalMonth, 21 logComposerOpen, 22 logText, 23 logKind,
// 24 artifactComposerOpen, 25 artifactSummary, 26 artifactLinks, 27 pendingActions,
// 28 lastApply, 29 aiPanelOpen, 30 aiLoading, 31 aiResult, 32 aiAdopted,
// 33 tidyLoading, 34 tidyNote, 35 reports, 36 reportPeriod, 37 reportMode,
// 38 reportBody, 39 reportDirty, 40 reportExcluded, 41 reportGenerating,
// 42 reportNotice, 43 reportKind
let overrides = {};
let call = 0;
const React = {
  useState: (init) => {
    call += 1;
    if (Object.prototype.hasOwnProperty.call(overrides, call)) return [overrides[call], () => {}];
    const v = typeof init === 'function' ? init() : init;
    return [v, () => {}];
  },
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useEffect: () => {},
  createElement: (type, props, ...children) => ({ type, props, children }),
};
const mockRequire = (spec) => {
  if (spec === 'react') return React;
  throw new Error('unexpected require: ' + spec);
};

let captured;
const sandbox = {
  window: { __ModuleLoader__: { load: (reg) => { captured = reg; } }, localStorage },
  console, Date, JSON, Math,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const plugin = captured.factory(mockRequire);
const registered = {};
plugin.apply({
  slots: {
    inject: (owner, fn) => fn(),
    register: (spec, comp) => { registered[spec.key || spec.id] = comp; return () => {}; },
  },
});
const WorkPanel = registered['work-panel'];

function render(over) {
  overrides = over || {};
  call = 0;
  const tree = WorkPanel();
  const classes = [];
  const refButtons = [];
  (function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string') {
      classes.push(node.props.className);
      if (node.props.className === 'wp-ref') refButtons.push(node);
    }
    (node.children || []).forEach(walk);
  })(tree);
  const has = (name) => classes.some((c) => c.split(' ').includes(name));
  const labels = [];
  (function collectLabels(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(collectLabels); return; }
    if (typeof node !== 'object') return;
    const cls = node.props && node.props.className;
    if (typeof cls === 'string' && (cls.indexOf('wp-act-btn') !== -1 || cls.indexOf('wp-status-seg-item') !== -1)) {
      (node.children || []).forEach((c) => { if (typeof c === 'string') labels.push(c); });
    }
    (node.children || []).forEach(collectLabels);
  })(tree);
  const titleNode = (function findTitle(node) {
    if (!node) return null;
    if (Array.isArray(node)) { for (const child of node) { const hit = findTitle(child); if (hit) return hit; } return null; }
    if (typeof node !== 'object') return null;
    if (node.props && node.props.className === 'wp-mid-title') return node;
    for (const child of (node.children || [])) { const hit = findTitle(child); if (hit) return hit; }
    return null;
  })(tree);
  return { tree, classes, has, refButtons, labels, title: titleNode ? (titleNode.children || []).join('') : '' };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---- weekly report ----
const week = render({ 4: 'reports', 37: 'preview', 38: BODY });
const want = [
  'wp-report', 'wp-report-toolbar', 'wp-report-period', 'wp-report-kind', 'wp-report-nav',
  'wp-report-period-label', 'wp-report-actions', 'wp-report-preview',
  'wp-report-h', 'wp-report-line', 'wp-ref',
  'wp-evidence', 'wp-evidence-title', 'wp-evidence-count', 'wp-evidence-item',
  'wp-evidence-check', 'wp-evidence-task', 'wp-evidence-meta',
];
const missing = want.filter((c) => !week.has(c));
assert(!missing.length, 'missing classes: ' + missing.join(','));
assert(week.title === '周报', 'weekly header title should be 周报, got ' + week.title);

// Only resolvable refs become badges: t-1 and l-1 are real, t-404 is not.
assert(week.refButtons.length === 2, 'expected 2 ref badges, got ' + week.refButtons.length);
const titles = week.refButtons.map((b) => b.props.title || '');
assert(titles.some((t) => t.indexOf('任务「上线插件」') === 0), 'task ref badge missing title');
assert(titles.some((t) => t.indexOf('工作记录「完成发布」') === 0), 'log ref badge missing title');
// The fake ref becomes a visible "broken evidence" placeholder, not a silent drop.
assert(week.has('wp-ref-broken'), 'unresolvable marker should render as a broken ref');
assert(JSON.stringify(week.tree).indexOf('[[task:t-404]]') === -1, 'raw marker should not leak into the preview');

['生成本期报告', '保存草稿', '复制', '导出 MD', '周报', '月报'].forEach((label) => {
  assert(week.labels.indexOf(label) !== -1, 'missing report control: ' + label);
});

// ---- monthly report ----
const month = render({
  4: 'reports',
  36: { start: '2026-11-01', end: '2026-11-30' },
  38: BODY,
  43: 'month',
});
assert(month.has('wp-report'), 'monthly view must render the report page');
assert(month.title === '月报', 'monthly header title should be 月报, got ' + month.title);
assert(month.refButtons.length === 2, 'monthly view should resolve the same refs');
assert(month.labels.indexOf('本月') !== -1, 'monthly view should offer 本月');
assert(month.labels.indexOf('本周') === -1, 'monthly view should not offer 本周');

// ---- empty monthly state ----
const empty = render({ 4: 'reports', 36: { start: '2026-11-01', end: '2026-11-30' }, 43: 'month' });
assert(empty.has('wp-report-empty'), 'empty state should render');
assert(JSON.stringify(empty.tree).indexOf('还没有本月报告') !== -1, 'empty monthly copy should say 本月');

// ---- paragraph polishing ----
const polishing = render({
  4: 'reports',
  37: 'preview',
  38: BODY,
  46: {
    index: 1,
    source: '- 上线插件已完成 [[task:t-1]]',
    loading: false,
    error: '',
    result: '- 上线插件已完成并发布 [[task:t-1]]',
    reply: '更紧凑',
  },
});
assert(polishing.has('wp-report-line-selected'), 'selected paragraph should be highlighted');
assert(polishing.has('wp-line-polish'), 'selected paragraph should offer the polish action');
assert(polishing.has('wp-polish-panel'), 'polish panel should render');
assert(polishing.has('wp-polish-text'), 'polish result should render');
assert(polishing.labels.indexOf('替换这一段') !== -1, 'accept button missing');
assert(JSON.stringify(polishing.tree).indexOf('未应用') !== -1, 'polish result must be marked unapplied');
// The polished paragraph keeps its evidence marker, rendered as a badge (2 in body + 1 in panel).
assert(polishing.refButtons.length === 3, 'polished paragraph should keep its ref badge, got ' + polishing.refButtons.length);

// A failed polish shows the error, never a silent no-op.
const polishError = render({ 4: 'reports', 37: 'preview', 38: BODY, 46: { index: 1, source: '- 上线插件已完成 [[task:t-1]]', loading: false, error: '润色结果改动了依据标记，已拒绝。再试一次即可。', result: '', reply: '' } });
assert(polishError.has('wp-polish-error'), 'polish rejection must be surfaced');

console.log('REPORT RENDER OK · ' + (want.length + 6) + ' classes · weekly + monthly + empty + polish');
