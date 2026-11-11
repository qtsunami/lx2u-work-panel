// Smoke test: project grouping in the sidebar, the project field in the task
// detail, and project scoping on the report page.
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
  { ...base, id: 't-1', title: '插件收尾', project: '工作台', status: 'todo' },
  { ...base, id: 't-2', title: '插件文档', project: '工作台', status: 'done' },
  { ...base, id: 't-3', title: '客户上门', project: '客户交付', status: 'todo' },
  { ...base, id: 't-4', title: '无项目任务', project: '', status: 'todo' },
];
const localStorage = {
  getItem: (k) => (k === '@local/work-panel:tasks:v1' ? JSON.stringify(TASKS) : null),
  setItem: () => {}, removeItem: () => {},
};

// useState order in WorkPanel: ... 43 reportKind, 44 purgeConfirmId, 45 toast,
// 46 polish, 47 reportScope
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
  const nodes = [];
  (function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    nodes.push(node);
    (node.children || []).forEach(walk);
  })(tree);
  const classes = nodes.map((n) => (n.props && typeof n.props.className === 'string' ? n.props.className : '')).filter(Boolean);
  const texts = [];
  (function collect(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (typeof node === 'string') { texts.push(node); return; }
    if (typeof node !== 'object') return;
    (node.children || []).forEach(collect);
  })(tree);
  const has = (name) => classes.some((c) => c.split(' ').includes(name));
  const navButtons = nodes.filter((n) => n.props && typeof n.props.className === 'string'
    && n.props.className.split(' ').includes('wp-nav-item'));
  const navLabels = navButtons.map(textOf);
  return { tree, nodes, classes, texts, has, navButtons, navLabels, text: texts.join('|') };
}

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---- 1. sidebar groups projects after the built-in views ----
const sidebar = render();
assert(sidebar.has('wp-nav-section'), 'sidebar should render a project section');
assert(sidebar.texts.indexOf('项目') !== -1, 'project section label missing');
// Nav labels concatenate the label and its count ("工作台2"), so match by substring.
['工作台', '客户交付'].forEach((name) => {
  assert(sidebar.navLabels.some((label) => label.indexOf(name) !== -1), 'missing project nav item: ' + name);
});
// Two tasks in 工作台, one in 客户交付.
const wb = sidebar.navButtons.find((n) => textOf(n).indexOf('工作台') !== -1);
assert(wb, '工作台 nav item missing');
const wbCount = (wb.children || []).find((c) => c && c.props && c.props.className === 'wp-nav-count');
assert(wbCount && textOf(wbCount) === '2', '工作台 should count 2 tasks, got ' + textOf(wbCount));
assert(!sidebar.navLabels.some((label) => label.indexOf('无项目任务') !== -1), 'tasks without a project must not create a nav entry');
assert(sidebar.navButtons.length === 6 + 2, 'expected 6 built-in views + 2 projects, got ' + sidebar.navButtons.length);

// ---- 2. clicking a project filters the list ----
const projectView = render({ 4: 'proj:工作台' });
assert(projectView.text.indexOf('插件收尾') !== -1, 'project view should list its tasks');
assert(projectView.text.indexOf('客户上门') === -1, 'project view must not list other projects');
assert(projectView.text.indexOf('无项目任务') === -1, 'project view must not list ungrouped tasks');

// ---- 3. the task detail exposes a project field ----
const detail = render({ 7: 't-1' });
assert(detail.has('wp-detail-project'), 'task detail should render the project input');
const projectInput = detail.nodes.find((n) => n.props && n.props.className && n.props.className.indexOf('wp-detail-project') !== -1);
assert(projectInput && projectInput.props.value === '工作台', 'project input should hold the current project');
assert(projectInput.props.list === 'wp-project-options', 'project input should suggest existing projects');
const datalist = detail.nodes.find((n) => n.props && n.props.id === 'wp-project-options');
assert(datalist && flatten(datalist.children).length === 2, 'datalist should carry the two existing projects');

// ---- 4. the report page can be scoped to one project ----
const report = render({ 4: 'reports', 38: '## 一、本期主要成果\n- 完成 [[task:t-2]]', 47: '工作台' });
assert(report.has('wp-report-scope'), 'report page should render the scope selector');
const scope = report.nodes.find((n) => n.props && n.props.className === 'wp-report-scope');
assert(scope && scope.props.value === '工作台', 'scope selector should hold the project');
const options = flatten(scope.children).map(textOf);
assert(options[0] === '全部项目', 'scope selector needs an all-projects option, got ' + options[0]);
assert(options.indexOf('客户交付') !== -1, 'scope selector should list projects');

// ---- 5. no projects means no empty section ----
const noProjects = (function () {
  overrides = { 1: [] };
  call = 0;
  const tree = WorkPanel();
  const classes = [];
  (function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string') classes.push(node.props.className);
    (node.children || []).forEach(walk);
  })(tree);
  return { has: (name) => classes.some((c) => c.split(' ').includes(name)) };
})();
assert(!noProjects.has('wp-nav-section'), 'no projects should hide the section header');

console.log('PROJECT RENDER OK · sidebar + filter + detail field + report scope');
