// Smoke test: render the AI confirmation card, undo bar and in-task AI panel.
// These branches only run after a model reply, so a unit test can't reach them;
// this walks the real tree to catch structural errors before a user clicks.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const iso = new Date().toISOString();
const TASK = {
  id: 't-1', title: '完成报告', description: '描述', status: 'todo',
  urgency: 'high', progress: 0, deadline: '2026-11-12T10:00',
  expected: '', nextStep: '', blockedReason: '', completedAt: null, deletedAt: null,
  createdAt: iso, updatedAt: iso,
};
const localStorage = {
  getItem: (k) => (k === '@local/work-panel:tasks:v1' ? JSON.stringify([TASK]) : null),
  setItem: () => {}, removeItem: () => {},
};

// useState order in WorkPanel:
// 1 tasks, 2 logs, 3 artifacts, 4 activeView, 5 sortBy, 6 search, 7 selectedId,
// 8 collapsedGroups, 9 quickText, 10 quickDeadline, 11 calOpen, 12 calMonth,
// 13 messages, 14 cmdInput, 15 sending, 16 assistantOpen, 17 theme, 18 flagOpen,
// 19 detailCalOpen, 20 detailCalMonth, 21 logComposerOpen, 22 logText, 23 logKind,
// 24 artifactComposerOpen, 25 artifactSummary, 26 artifactLinks, 27 pendingActions,
// 28 lastApply, 29 aiPanelOpen, 30 aiLoading, 31 aiResult, 32 aiAdopted,
// 33 tidyLoading, 34 tidyNote
const OVERRIDES = {
  7: 't-1',
  16: true,
  27: {
    reply: '我准备这样改',
    actions: [
      { op: 'complete', taskId: 't-1' },
      { op: 'update', taskId: 't-1', patch: { urgency: 'high', nextStep: '写提纲' } },
      { op: 'create', title: '完成报告' },
      { op: 'complete', taskId: 't-missing' },
    ],
  },
  28: { before: { tasks: [TASK], logs: [], artifacts: [] }, at: iso },
  29: true,
  31: {
    reply: '还缺验收标准',
    suggestion: {
      summary: '已完成第一版',
      nextStep: '补上验收标准',
      blockedReason: '等产品确认',
      risks: ['时间偏紧'],
    },
  },
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
(function walk(node) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (typeof node !== 'object') return;
  if (node.props && typeof node.props.className === 'string') classes.push(node.props.className);
  (node.children || []).forEach(walk);
})(tree);

const has = (name) => classes.some((c) => c.split(' ').includes(name));
const want = [
  'wp-action-card', 'wp-action-card-head', 'wp-action-item', 'wp-action-op',
  'wp-action-line', 'wp-action-warn', 'wp-action-force', 'wp-action-card-actions',
  'wp-undo-bar', 'wp-undo-btn',
  'wp-ai-panel', 'wp-ai-tag', 'wp-ai-sug', 'wp-ai-adopt', 'wp-ai-hint',
];
const missing = want.filter((c) => !has(c));
if (missing.length) throw new Error('missing classes: ' + missing.join(','));

// The duplicate create must be flagged, and the unknown task must be marked invalid.
if (!has('wp-action-item-warn')) throw new Error('duplicate/invalid actions were not flagged');
const warnings = [];
(function collect(node) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(collect); return; }
  if (typeof node !== 'object') return;
  if (node.props && typeof node.props.className === 'string' && node.props.className.indexOf('wp-action-warn') !== -1) {
    warnings.push((node.children || []).filter((c) => typeof c === 'string').join(''));
  }
  (node.children || []).forEach(collect);
})(tree);
if (!warnings.some((t) => t.indexOf('相似任务') !== -1)) throw new Error('duplicate warning text missing');
if (!warnings.some((t) => t.indexOf('无法执行') !== -1)) throw new Error('invalid-task warning text missing');

console.log('ACTIONS RENDER OK · ' + want.length + ' classes · warnings: ' + warnings.length);
