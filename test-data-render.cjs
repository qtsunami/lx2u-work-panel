// Smoke test: the local data view (backup / import / restore / clear) and the version footer.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const now = new Date().toISOString();
const TASK = {
  id: 't-1', title: '插件收尾', description: '', status: 'todo', urgency: 'medium',
  progress: 0, deadline: '2026-11-12', expected: '', nextStep: '', blockedReason: '',
  completedAt: null, deletedAt: null, projectId: '', createdAt: now, updatedAt: now,
};
const localStorage = {
  getItem: (k) => (k === '@local/work-panel:tasks:v1' ? JSON.stringify([TASK]) : null),
  setItem: () => {}, removeItem: () => {},
  get length() { return 1; },
  key: () => '@local/work-panel:tasks:v1',
};

// useState order: ... 55 inbox, 56 inboxAck, 57 inboxPicks, 58 importMode,
// 59 preImportReady, 60 clearConfirm
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

function textOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object') return '';
  return (node.children || []).map(textOf).join('');
}

function render(over) {
  overrides = over || {};
  call = 0;
  const tree = WorkPanel();
  const nodes = [];
  (function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    nodes.push(node);
    (node.children || []).forEach(walk);
  })(tree);
  const classes = nodes.map((n) => (n.props && typeof n.props.className === 'string' ? n.props.className : '')).filter(Boolean);
  const has = (name) => classes.some((c) => c.split(' ').includes(name));
  return { tree, nodes, classes, has, text: textOf(tree) };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---- 1. data view ----
const dataView = render({ 4: 'data' });
assert(dataView.has('wp-data'), 'data view should render');
assert(dataView.has('wp-data-card'), 'data cards missing');
assert(dataView.has('wp-data-row'), 'data rows missing');
assert(dataView.has('wp-data-actions'), 'data actions missing');
['版本', '本地占用', '数据量', '导出备份', '合并', '覆盖', '选择备份文件', '清空本地数据'].forEach((label) => {
  assert(dataView.text.indexOf(label) !== -1, 'missing data control: ' + label);
});
assert(dataView.text.indexOf('v1.3.1') !== -1, 'panel version should be shown, got ' + dataView.text);
assert(!dataView.has('wp-detail'), 'data view should not show the task detail panel');

// ---- 2. import mode copy switches ----
const replaceMode = render({ 4: 'data', 58: 'replace' });
assert(replaceMode.text.indexOf('用备份文件替换当前全部数据') !== -1, 'replace mode explanation missing');
assert(replaceMode.text.indexOf('不会删除你现有的数据') === -1, 'replace mode must not claim merge behaviour');

// ---- 3. undo entry appears only when a pre-import snapshot exists ----
assert(dataView.text.indexOf('撤销上次导入/清空') === -1, 'undo must stay hidden without a snapshot');
const undoView = render({ 4: 'data', 59: true });
assert(undoView.text.indexOf('撤销上次导入/清空') !== -1, 'undo should appear once a snapshot exists');

// ---- 4. destructive action asks first ----
assert(dataView.text.indexOf('确定清空？') === -1, 'clear must not be pre-confirmed');
const confirming = render({ 4: 'data', 60: true });
assert(confirming.text.indexOf('确定清空？') !== -1, 'clear confirmation string missing');
assert(confirming.text.indexOf('确认清空') !== -1, 'clear confirmation button missing');

// ---- 5. version footer is always visible in the sidebar ----
const normal = render({});
assert(normal.text.indexOf('v1.3.1') !== -1, 'version footer missing from the sidebar');
assert(normal.has('wp-sidenav-foot'), 'version footer element missing');

console.log('DATA RENDER OK · view + modes + undo + confirmation + version footer');
