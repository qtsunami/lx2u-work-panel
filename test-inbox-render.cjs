// Smoke test: the execution report-back inbox and its timeline attribution.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const now = new Date().toISOString();
const base = {
  description: '', urgency: 'medium', progress: 0, deadline: '2026-11-12',
  expected: '', nextStep: '', blockedReason: '', completedAt: null, deletedAt: null,
  createdAt: now, updatedAt: now, projectId: '',
};
const TASKS = [
  { ...base, id: 't-1', title: '插件收尾', status: 'todo' },
  { ...base, id: 't-2', title: '插件文档', status: 'todo' },
];
const LOGS = [{
  id: 'l-exec', taskId: 't-1', at: now, kind: 'progress',
  text: '脚本跑完了', source: 'execution',
}];
const localStorage = {
  getItem: (k) => {
    if (k === '@local/work-panel:tasks:v1') return JSON.stringify(TASKS);
    if (k === '@local/work-panel:logs:v1') return JSON.stringify(LOGS);
    return null;
  },
  setItem: () => {}, removeItem: () => {},
};

const INBOX = [
  {
    id: 'rb-1', taskId: 't-1', taskTitle: '', text: '写完方案初稿', kind: 'progress',
    source: 'execution', receivedAt: now,
    artifacts: [{ summary: '方案 v1', links: ['https://a.com', 'ftp://nope'] }],
  },
  {
    id: 'rb-2', taskId: '', taskTitle: '对不上的任务', text: '无法匹配的内容', kind: 'progress',
    source: 'execution', receivedAt: now, artifacts: [],
  },
];

// useState order: ... 53 batch, 54 batchConfirm, 55 inbox, 56 inboxAck, 57 inboxPicks
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

function flatten(list) {
  const out = [];
  (function walk(value) {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value) out.push(value);
  })(list);
  return out;
}
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

// ---- 1. inbox view lists queued reports ----
const inboxView = render({ 4: 'inbox', 55: INBOX });
assert(inboxView.has('wp-inbox-list'), 'inbox view should render its list');
assert(inboxView.has('wp-inbox-item'), 'inbox items should render');
assert(inboxView.has('wp-inbox-source'), 'items should show their source badge');
assert(inboxView.has('wp-inbox-actions'), 'items should offer actions');
assert(inboxView.text.indexOf('采纳为记录') !== -1, 'adopt button missing');
assert(inboxView.text.indexOf('全部采纳') !== -1, 'adopt-all button missing');
assert(inboxView.text.indexOf('全部忽略') !== -1, 'ignore-all button missing');
assert(inboxView.text.indexOf('写完方案初稿') !== -1, 'item text missing');

// ---- 2. matching / unmatched ----
assert(inboxView.text.indexOf('插件收尾') !== -1, 'a matched item should show its task title');
assert(inboxView.has('wp-inbox-task'), 'matched item should render the task label');
assert(inboxView.has('wp-inbox-pick'), 'unmatched item should offer a task picker');
const pick = inboxView.nodes.find((n) => n.props && n.props.className === 'wp-inbox-pick');
assert(pick && pick.props.value === '', 'picker starts empty');
const pickOptions = flatten(pick.children).map(textOf);
assert(pickOptions[0] === '选择任务…', 'picker needs a placeholder, got ' + pickOptions[0]);
assert(pickOptions.indexOf('插件文档') !== -1, 'picker should list other tasks');

// ---- 3. artifacts, with only safe links ----
assert(inboxView.has('wp-inbox-artifacts'), 'artifacts block missing');
assert(inboxView.text.indexOf('方案 v1') !== -1, 'artifact summary missing');
assert(inboxView.text.indexOf('https://a.com') !== -1, 'safe link missing');
assert(!inboxView.nodes.some((n) => n.type === 'a' && n.props && n.props.href === 'ftp://nope'), 'unsafe link must not become an anchor');
assert(inboxView.nodes.some((n) => n.type === 'span' && n.props && n.props.className === 'wp-artifact-url' && textOf(n) === 'ftp://nope'), 'unsafe link should stay plain text');

// ---- 4. empty inbox ----
const emptyInbox = render({ 4: 'inbox', 55: [] });
assert(emptyInbox.has('wp-empty'), 'empty inbox should show the empty state');
assert(emptyInbox.text.indexOf('还没有执行回传') !== -1, 'empty inbox copy missing');

// ---- 5. execution records are marked in the timeline ----
const detail = render({ 7: 't-1' });
assert(detail.text.indexOf('脚本跑完了') !== -1, 'execution record should appear in the timeline');
assert(detail.text.indexOf('回传') !== -1, 'execution record should be marked 回传');

// ---- 6. the sidebar exposes the inbox entry ----
assert(inboxView.text.indexOf('执行回传') !== -1, 'sidebar should list the inbox entry');

console.log('INBOX RENDER OK · list + match + picker + artifacts + empty + timeline tag');
