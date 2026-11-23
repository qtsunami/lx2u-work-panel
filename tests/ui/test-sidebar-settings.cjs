'use strict';
// Isolated handler/tree regression only: this does not verify browser layout,
// focus, responsive rendering, or the running DSH page.
const assert = require('node:assert/strict');
const { harness, workspace, task, KEY, NOW, walk, text, hasClass, seedStorage } = require('../helpers/ui-harness.cjs');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const descendants = (node) => walk(node);
const navLabels = (node) => descendants(node).filter(n => hasClass(n, 'wp-nav-label')).map(text);
const group = (ui, label) => ui.one(n => hasClass(n, 'wp-nav-group')
  && descendants(n).some(c => hasClass(c, 'wp-nav-section-label') && text(c) === label), label + ' group');
const selected = (ui, label) => assert.ok(hasClass(ui.button(label), 'wp-active'), label + ' is active');
const openSettings = (ui) => ui.click('设置');

test('sidebar groups report tools together and keeps closed/deleted tasks independent', async () => {
  const ui = harness(workspace({ tasks: [task('closed'), { ...task('deleted'), deletedAt: NOW }] }));
  await ui.settle();
  try {
    assert.deepEqual(navLabels(group(ui, '任务')), ['全部任务', '今天到期', '已逾期']);
    group(ui, '清单');
    assert.ok(!ui.nodes().some(n => hasClass(n, 'wp-nav-section-label') && text(n) === '项目'));
    assert.deepEqual(navLabels(group(ui, '报告')), ['周报/月报', '需要注意', '执行回传']);
    assert.deepEqual(navLabels(group(ui, '管理')), ['统一检索']);
    assert.ok(!navLabels(ui.byClass('wp-sidenav')).includes('数据'), 'data has no independent sidebar entry');
    const side = ui.byClass('wp-sidenav');
    const nodes = descendants(side);
    const reports = group(ui, '报告');
    const separator = nodes.find(n => n.props.role === 'separator');
    assert.ok(separator, 'archive entries have a semantic separator');
    assert.ok(nodes.indexOf(separator) > nodes.indexOf(reports), 'separator follows reports');
    for (const label of ['回收站', '已完成/废弃']) {
      const button = ui.button(label);
      assert.ok(nodes.indexOf(button) > nodes.indexOf(separator), label + ' follows separator');
      assert.ok(!ui.nodes().filter(n => hasClass(n, 'wp-nav-group')).some(n => descendants(n).includes(button)),
        label + ' is independent, not inside task/report/manage groups');
    }
    assert.deepEqual(navLabels(ui.byClass('wp-nav-archive')), ['回收站', '已完成/废弃']);
    for (const label of ['回收站', '已完成/废弃']) {
      ui.click(label); selected(ui, label);
      if (label === '已完成/废弃') {
        const collapsed = ui.nodes().find(n => hasClass(n, 'wp-group-head') && text(n).includes('展开'));
        if (collapsed) ui.fire(collapsed, 'onClick');
      }
      assert.ok(ui.text().includes(label === '回收站' ? 'deleted' : 'closed'), label + ' still renders its tasks');
    }
    ui.click('需要注意'); selected(ui, '需要注意');
    ui.click('执行回传'); selected(ui, '执行回传');
    ui.click('新建清单');
    const input = ui.byClass('wp-nav-new-input');
    assert.ok(input.props.placeholder.includes('清单'), 'creation uses list terminology');
    ui.fire(input, 'onChange', { target: { value: '新清单' } });
    ui.fire(ui.byClass('wp-nav-new-input'), 'onKeyDown', { key: 'Enter' }); await ui.settle();
    assert.ok(ui.storage.json(KEY.projects).some(p => p.name === '新清单'), 'renaming the entry preserves creation');
    selected(ui, '新清单');
  } finally { ui.close(); }
});

test('footer gear opens two-column settings with preferences selected by default', async () => {
  const ui = harness(workspace()); await ui.settle();
  try {
    const gear = ui.button('设置');
    assert.equal(gear.props['aria-label'], '设置');
    assert.equal(gear.props.title, '设置');
    assert.ok(descendants(ui.byClass('wp-sidenav-bottom')).includes(gear), 'settings is in the sidebar footer');
    assert.equal(descendants(gear).filter(n => hasClass(n, 'wp-nav-label')).length, 0, 'gear is not another text navigation row');
    openSettings(ui);
    assert.equal(ui.button('设置').props['aria-pressed'], true, 'gear exposes its selected state');
    assert.ok(!ui.nodes().some(n => hasClass(n, 'wp-search-input') || hasClass(n, 'wp-quick-input')), 'task-only controls are hidden in settings');
    assert.equal(ui.button('报告表达偏好').props['aria-current'], 'page');
    const layout = ui.byClass('wp-settings-layout');
    const nav = ui.byClass('wp-settings-nav');
    const content = ui.byClass('wp-settings-content');
    assert.ok(descendants(layout).includes(nav) && descendants(layout).includes(content));
    assert.deepEqual(descendants(nav).filter(n => n.type === 'button').map(text), ['报告表达偏好', '自动报告', '数据管理']);
    assert.ok(descendants(content).some(n => n.props.id === 'wp-pref-format'), 'default content is preferences');
    assert.ok(!descendants(content).some(n => hasClass(n, 'wp-auto')), 'automation is not mixed into preferences');
    assert.equal(ui.requests.length, 0, 'opening settings does not call AI');
    ui.click('自动报告');
    assert.equal(ui.button('自动报告').props['aria-current'], 'page');
    assert.equal(ui.button('报告表达偏好').props['aria-current'], undefined);
    assert.ok(descendants(ui.byClass('wp-settings-content')).some(n => hasClass(n, 'wp-auto')));
    assert.ok(!ui.nodes().some(n => n.props.id === 'wp-pref-format'), 'only the corresponding settings are shown');
    assert.ok(ui.text().includes('未开启 · 点击开启'), 'automation stays opt-in');
    assert.equal(ui.requests.length, 0, 'switching setting sections does not call AI');
    ui.click('报告表达偏好');
    assert.ok(ui.nodes().some(n => n.props.id === 'wp-pref-format'));
  } finally { ui.close(); }
});

test('preferences survive section/navigation changes and can still be cleared', async () => {
  const ui = harness(workspace()); await ui.settle();
  try {
    openSettings(ui);
    const format = () => ui.one(n => n.type === 'select' && n.props.id === 'wp-pref-format');
    assert.equal(format().props.value, '');
    ui.fire(format(), 'onChange', { target: { value: 'list' } }); await ui.settle();
    ui.click('自动报告'); ui.click('数据管理'); ui.click('报告表达偏好');
    assert.equal(format().props.value, 'list');
    ui.click('全部任务'); openSettings(ui);
    assert.equal(format().props.value, 'list');
    assert.equal(ui.storage.json(KEY['workspace-extras']).reportPreferences.format, 'list');
    ui.click('清除报告偏好'); await ui.settle();
    assert.equal(format().props.value, '');
    assert.equal(ui.storage.json(KEY['workspace-extras']).reportPreferences, null);
    assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
});

test('settings data management retains every data tool without duplicated settings content', async () => {
  const ui = harness(workspace()); await ui.settle();
  try {
    openSettings(ui); ui.click('数据管理');
    assert.equal(ui.button('数据管理').props['aria-current'], 'page');
    assert.equal(ui.button('报告表达偏好').props['aria-current'], undefined);
    const content = ui.byClass('wp-settings-content');
    assert.equal(content.props['aria-label'], '数据管理设置');
    assert.ok(descendants(content).includes(ui.byClass('wp-data')), 'data stays in the settings right content column');
    for (const label of ['同步状态', '本地占用', '数据量', '导出备份', '选择备份文件', '合并', '覆盖', '清空本地数据']) {
      assert.ok(text(content).includes(label), 'data content retains ' + label);
    }
    assert.ok(!descendants(content).some(n => n.props.id === 'wp-pref-format' || hasClass(n, 'wp-auto')));
    ui.click('导出备份'); await ui.settle();
    assert.equal(ui.downloads.length, 1, 'backup export remains functional');
    assert.ok(ui.byClass('wp-data-file'), 'import control remains available');
    assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
});

test('sync failure permits settings category navigation and data recovery but not preference writes', async () => {
  const value = workspace({ tasks: [task('recoverable')] });
  const storage = seedStorage(value);
  storage.fail('set', '@local/work-panel:local-only:v1', 20);
  const ui = harness(value, storage, { workspaceGetFailure: true }); await ui.settle();
  try {
    assert.equal(ui.byClass('wp-sync-guard').props.disabled, true, 'ordinary task writes are guarded');
    openSettings(ui);
    assert.equal(ui.byClass('wp-sync-guard').props.disabled, false, 'settings container remains reachable after sync failure');
    assert.equal(ui.byClass('wp-settings-guard').props.disabled, true, 'preference content remains guarded');
    assert.throws(() => ui.fire(ui.one(n => n.props.id === 'wp-pref-format'), 'onChange', { target: { value: 'list' } }), /disabled control/);
    ui.click('自动报告');
    assert.equal(ui.byClass('wp-settings-guard').props.disabled, true, 'automation remains guarded');
    assert.throws(() => ui.click('未开启 · 点击开启'), /disabled control/);
    ui.click('数据管理');
    assert.equal(ui.byClass('wp-settings-guard').props.disabled, false, 'recovery content is not blocked');
    ui.click('导出备份'); await ui.settle();
    assert.equal(ui.downloads.length, 1, 'backup can be exported despite sync failure');
    ui.click('覆盖');
    assert.ok(ui.text().includes('用备份文件替换当前全部数据'));
    ui.click('报告表达偏好');
    assert.equal(ui.byClass('wp-settings-guard').props.disabled, true, 'switching back does not accidentally enable writes');
    assert.equal(ui.storage.json(KEY['workspace-extras']).reportPreferences, undefined);
    assert.equal(ui.server.calls.filter(call => call.method === 'POST').length, 0);
  } finally { ui.close(); }
});

test('data recovery and report preference shortcuts select their explicit settings category', async () => {
  const value = workspace();
  const storage = seedStorage(value); storage.setItem(KEY.tasks, 'invalid-json-for-recovery');
  const ui = harness(value, storage); await ui.settle();
  try {
    ui.click('数据恢复');
    assert.equal(ui.button('数据管理').props['aria-current'], 'page');
    ui.byClass('wp-data');
  } finally { ui.close(); }
  const healthy = harness(value); await healthy.settle();
  try {
    openSettings(healthy); healthy.click('数据管理');
    healthy.click('周报/月报'); healthy.click('报告偏好');
    assert.equal(healthy.button('报告表达偏好').props['aria-current'], 'page');
    assert.ok(healthy.nodes().some(n => n.props.id === 'wp-pref-format'));
    assert.ok(!healthy.nodes().some(n => hasClass(n, 'wp-data')));
  } finally { healthy.close(); }
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`SIDEBAR SETTINGS: ${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
