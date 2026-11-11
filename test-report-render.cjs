// Smoke test: render the weekly report page and its evidence sidebar.
// The report view is a whole separate layout, so this walks the real tree to
// catch structural errors in the editor, preview and reference badges.
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
// 38 reportBody, 39 reportDirty, 40 reportExcluded, 41 reportGenerating, 42 reportNotice
const OVERRIDES = {
  4: 'reports',
  37: 'preview',
  38: BODY,
};

let call = 0;
const React = {
  useState: (init) => {
    call += 1;
    if (Object.prototype.hasOwnProperty.call(OVERRIDES, call)) return [OVERRIDES[call], () => {}];
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
const want = [
  'wp-report', 'wp-report-toolbar', 'wp-report-period', 'wp-report-nav',
  'wp-report-period-label', 'wp-report-actions', 'wp-report-preview',
  'wp-report-h', 'wp-report-line', 'wp-ref',
  'wp-evidence', 'wp-evidence-title', 'wp-evidence-count', 'wp-evidence-item',
  'wp-evidence-check', 'wp-evidence-task', 'wp-evidence-meta',
];
const missing = want.filter((c) => !has(c));
if (missing.length) throw new Error('missing classes: ' + missing.join(','));

// Only resolvable refs become badges: t-1 and l-1 are real, t-404 is not.
if (refButtons.length !== 2) throw new Error('expected 2 ref badges, got ' + refButtons.length);
const titles = refButtons.map((b) => b.props.title || '');
if (!titles.some((t) => t.indexOf('任务「上线插件」') === 0)) throw new Error('task ref badge missing title');
if (!titles.some((t) => t.indexOf('工作记录「完成发布」') === 0)) throw new Error('log ref badge missing title');

// The fake ref becomes a visible "broken evidence" placeholder, not a silent drop.
if (!has('wp-ref-broken')) throw new Error('unresolvable marker should render as a broken ref');
if (JSON.stringify(tree).indexOf('[[task:t-404]]') !== -1) throw new Error('raw marker should not leak into the preview');

// The period toolbar must offer navigation and generation.
const labels = [];
(function collect(node) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(collect); return; }
  if (typeof node !== 'object') return;
  if (node.props && typeof node.props.className === 'string' && node.props.className.indexOf('wp-act-btn') !== -1) {
    (node.children || []).forEach((c) => { if (typeof c === 'string') labels.push(c); });
  }
  (node.children || []).forEach(collect);
})(tree);
['生成本期报告', '保存草稿', '复制', '导出 MD'].forEach((label) => {
  if (labels.indexOf(label) === -1) throw new Error('missing report action: ' + label);
});

console.log('REPORT RENDER OK · ' + want.length + ' classes · ' + refButtons.length + ' ref badges');
