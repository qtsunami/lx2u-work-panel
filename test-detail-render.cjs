// Smoke test: render the detail panel with a selected task.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const TASK = {
  id: 't-1', title: '测试任务', description: '描述内容', status: 'todo',
  urgency: 'high', progress: 0, deadline: '2026-11-10T10:00',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
const localStorage = {
  getItem: (k) => (k === '@local/work-panel:tasks:v1' ? JSON.stringify([TASK]) : null),
  setItem: () => {}, removeItem: () => {},
};
let call = 0;
const React = {
  useState: (init) => {
    call += 1;
    const v = typeof init === 'function' ? init() : init;
    // useState order in WorkPanel: 1 tasks, 2 logs, 3 artifacts, 4 activeView,
    // 5 sortBy, 6 search, 7 selectedId, ...
    if (call === 7) return ['t-1', () => {}];
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

const want = [
  'wp-detail', 'wp-detail-body', 'wp-detail-meta', 'wp-detail-check', 'wp-detail-date', 'wp-detail-flag',
  'wp-row', 'wp-row-time', 'wp-row-desc',
  'wp-detail-field', 'wp-detail-actions', 'wp-detail-section', 'wp-detail-empty',
];
const missing = want.filter((c) => !classes.some((x) => x.split(' ').includes(c)));
if (missing.length) throw new Error('missing classes: ' + missing.join(','));
console.log('DETAIL RENDER OK · ' + classes.filter((c) => c.indexOf('wp-detail') === 0).join(', '));
