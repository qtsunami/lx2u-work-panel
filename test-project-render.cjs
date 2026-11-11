// Smoke test: project entities — sidebar grouping, project views, the task
// selector, project settings, and project-scoped reports.
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
const PROJECTS = [
  { id: 'p-1', name: '工作台', description: '插件开发', color: '', status: 'active', archivedAt: null, createdAt: now, updatedAt: now },
  { id: 'p-2', name: '客户交付', description: '', color: '', status: 'archived', archivedAt: now, createdAt: now, updatedAt: now },
  { id: 'p-3', name: '空项目', description: '', color: '', status: 'active', archivedAt: null, createdAt: now, updatedAt: now },
];
const TASKS = [
  { ...base, id: 't-1', title: '插件收尾', projectId: 'p-1', status: 'todo' },
  { ...base, id: 't-2', title: '插件文档', projectId: 'p-1', status: 'done' },
  { ...base, id: 't-3', title: '客户上门', projectId: 'p-2', status: 'todo' },
  { ...base, id: 't-4', title: '无项目任务', projectId: '', status: 'todo' },
];
const localStorage = {
  getItem: (k) => {
    if (k === '@local/work-panel:tasks:v1') return JSON.stringify(TASKS);
    if (k === '@local/work-panel:projects:v1') return JSON.stringify(PROJECTS);
    if (k === '@local/work-panel:migration:projects:v1') return 'v1';
    return null;
  },
  setItem: () => {}, removeItem: () => {},
};

// useState order: ... 43 reportKind, 44 purgeConfirmId, 45 toast, 46 polish,
// 47 reportScope, 48 projects, 49 newProject, 50 projectSettingsOpen,
// 51 projectEdit, 52 projectDeleteConfirm
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
  const allText = textOf(tree);
  const navButtons = nodes.filter((n) => n.props && typeof n.props.className === 'string'
    && n.props.className.split(' ').includes('wp-nav-item'));
  return {
    tree, nodes, classes, has,
    text: allText,
    navLabels: navButtons.map(textOf),
    navClasses: navButtons.map((n) => n.props.className),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---- 1. sidebar lists project entities, including an empty and an archived one ----
const sidebar = render();
assert(sidebar.has('wp-nav-section'), 'sidebar should render the project section');
assert(sidebar.text.indexOf('项目') !== -1, 'project section label missing');
['工作台', '客户交付', '空项目'].forEach((name) => {
  assert(sidebar.navLabels.some((label) => label.indexOf(name) !== -1), 'missing project nav item: ' + name);
});
assert(sidebar.navLabels.some((label) => label === '工作台2'), '工作台 should count 2 live tasks, got ' + JSON.stringify(sidebar.navLabels));
assert(sidebar.navLabels.indexOf('空项目') !== -1, 'an empty project must still be listed');
assert(sidebar.navClasses.some((c) => c.split(' ').includes('wp-nav-item-archived')), 'archived project should be marked');
assert(sidebar.navLabels.indexOf('无项目任务') === -1, 'tasks without a project must not create a nav entry');

// ---- 1b. the sidebar is grouped into sections ----
const sectionLabels = sidebar.nodes
  .filter((n) => n.props && n.props.className === 'wp-nav-section-label')
  .map(textOf);
['任务', '项目', '报告', '管理'].forEach((title) => {
  assert(sectionLabels.indexOf(title) !== -1, 'missing nav group: ' + title + ' (got ' + JSON.stringify(sectionLabels) + ')');
});
const groupCount = sidebar.classes.filter((c) => c.split(' ').includes('wp-nav-group')).length;
assert(groupCount === 4, 'expected 4 nav groups, got ' + groupCount);

// ---- 2. a project view lists only its tasks ----
const projectView = render({ 4: 'proj:p-1' });
assert(projectView.text.indexOf('插件收尾') !== -1, 'project view should list its tasks');
assert(projectView.text.indexOf('客户上门') === -1, 'project view must not list other projects');
assert(projectView.text.indexOf('无项目任务') === -1, 'project view must not list ungrouped tasks');

// ---- 3. an empty project still has a working view ----
const emptyProject = render({ 4: 'proj:p-3' });
assert(emptyProject.has('wp-empty'), 'empty project should show the empty state');

// ---- 4. task detail uses a project selector, not free text ----
const detail = render({ 7: 't-1' });
assert(detail.has('wp-detail-project-select'), 'task detail should render the project selector');
const select = detail.nodes.find((n) => n.props && n.props.className && n.props.className.indexOf('wp-detail-project-select') !== -1);
assert(select && select.props.value === 'p-1', 'selector should hold the current project id, got ' + (select && select.props.value));
const options = flatten(select.children);
const optionValues = options.map((o) => o.props.value);
assert(optionValues[0] === '', 'selector needs an ungrouped option');
assert(optionValues.indexOf('p-1') !== -1 && optionValues.indexOf('p-2') !== -1, 'selector should list projects by id');
assert(optionValues[optionValues.length - 1] === '__new__', 'selector should offer creating a project');
assert(textOf(options.find((o) => o.props.value === 'p-2')).indexOf('已归档') !== -1, 'archived project should be labelled');

// ---- 5. creating a project from the task detail ----
const creating = render({ 7: 't-1', 49: { mode: 'task', name: '新项目' } });
assert(creating.has('wp-inline-new'), 'new-project row should render in the detail');
assert(creating.has('wp-inline-new-input'), 'new-project input missing');

// ---- 6. reports can be scoped to a project id ----
const report = render({ 4: 'reports', 38: '## 一、本期主要成果\n- 完成 [[task:t-2]]', 47: 'p-1' });
assert(report.has('wp-report-scope'), 'report page should render the scope selector');
const scope = report.nodes.find((n) => n.props && n.props.className === 'wp-report-scope');
assert(scope && scope.props.value === 'p-1', 'scope selector should hold the project id');
const scopeOptions = flatten(scope.children).map(textOf);
assert(scopeOptions[0] === '全部项目', 'scope selector needs an all-projects option');
assert(scopeOptions.some((label) => label.indexOf('客户交付') === 0 && label.indexOf('已归档') !== -1), 'scope should include archived projects, labelled');

// ---- 7. project settings: rename, archive, delete ----
const settings = render({ 4: 'proj:p-1', 50: true, 51: { name: '工作台', description: '插件开发' } });
assert(settings.has('wp-project-settings'), 'settings panel should render');
['保存', '取消', '归档', '删除项目'].forEach((label) => {
  assert(settings.text.indexOf(label) !== -1, 'missing settings action: ' + label);
});
assert(settings.nodes.some((n) => n.props && n.props.value === '插件开发'), 'settings should prefill the description');

const confirming = render({ 4: 'proj:p-1', 50: true, 51: { name: '工作台', description: '' }, 52: true });
assert(confirming.text.indexOf('确认删除') !== -1, 'delete confirmation missing');
assert(confirming.text.indexOf('任务会变为未分组') !== -1, 'confirmation must explain that tasks are kept');

// ---- 8. archived project toggles to 取消归档 ----
const archivedSettings = render({ 4: 'proj:p-2', 50: true, 51: { name: '客户交付', description: '' } });
assert(archivedSettings.text.indexOf('取消归档') !== -1, 'archived project should offer unarchive');

console.log('PROJECT RENDER OK · sidebar + views + selector + create + scope + settings + delete');
