// Smoke test: the recycle bin (list, detail, purge confirmation) and the delete entry.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const now = new Date().toISOString();
const base = {
  description: '', urgency: 'medium', progress: 0, deadline: '2026-11-12',
  expected: '', nextStep: '', blockedReason: '', completedAt: null, deletedAt: null,
  createdAt: now, updatedAt: now,
};
const TASKS = [
  { ...base, id: 't-alive', title: '还活着的任务', status: 'todo' },
  { ...base, id: 't-gone', title: '被删掉的任务', status: 'done', deletedAt: '2026-11-10T04:00:00.000Z' },
];
const localStorage = {
  getItem: (k) => (k === '@local/work-panel:tasks:v1' ? JSON.stringify(TASKS) : null),
  setItem: () => {}, removeItem: () => {},
};

// useState order in WorkPanel: ... 43 reportKind, 44 purgeConfirmId, 45 toast
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
  const texts = [];
  (function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'string') { texts.push(node); return; }
    if (typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string') classes.push(node.props.className);
    (node.children || []).forEach(walk);
  })(tree);
  const has = (name) => classes.some((c) => c.split(' ').includes(name));
  return { tree, classes, texts, has, text: texts.join('|') };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---- 1. trash view lists only deleted tasks, with its own actions ----
const trash = render({ 4: 'trash' });
assert(trash.has('wp-row-trash'), 'trash view must render recycle-bin rows');
assert(trash.has('wp-trash-actions'), 'trash rows must offer actions');
assert(trash.text.indexOf('被删掉的任务') !== -1, 'deleted task should be listed');
assert(trash.text.indexOf('还活着的任务') === -1, 'live task must not appear in the recycle bin');
assert(trash.text.indexOf('恢复') !== -1, 'restore action missing');
assert(trash.text.indexOf('彻底删除') !== -1, 'purge action missing');
assert(!trash.has('wp-quick-input'), 'quick add must not appear in the recycle bin');
assert(trash.text.indexOf('删除于') !== -1, 'rows should show when the task was deleted');

// ---- 2. selecting a deleted task shows the trash detail panel ----
const detail = render({ 4: 'trash', 7: 't-gone' });
assert(detail.has('wp-detail-trash'), 'deleted task should render the trash detail panel');
assert(!detail.has('wp-detail-input'), 'deleted task must not be editable');
assert(detail.text.indexOf('恢复') !== -1, 'trash detail must offer restore');

// ---- 3. purge asks for confirmation before destroying data ----
const confirm = render({ 4: 'trash', 44: 't-gone' });
assert(confirm.has('wp-trash-confirm'), 'purge must ask for confirmation');
assert(confirm.text.indexOf('彻底删除后不可恢复') !== -1, 'confirmation copy missing');
assert(confirm.text.indexOf('确认删除') !== -1, 'confirmation button missing');
assert(confirm.text.indexOf('取消') !== -1, 'cancel button missing');

// ---- 4. the delete entry lives in the task detail meta row ----
const live = render({ 7: 't-alive' });
assert(live.has('wp-detail-del'), 'live task detail should expose a delete entry');
assert(live.has('wp-detail-input'), 'live task must stay editable');

// ---- 5. empty recycle bin ----
// state 1 is the task list: an empty list means an empty recycle bin.
const empty = render({ 1: [], 4: 'trash' });
assert(empty.has('wp-empty'), 'empty recycle bin should render the empty state');
assert(empty.text.indexOf('回收站是空的') !== -1, 'empty recycle bin copy missing');

console.log('TRASH RENDER OK · list + detail + confirm + delete entry + empty');
