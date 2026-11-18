'use strict';
const assert = require('node:assert/strict');
const { harness, workspace, task, KEY, NOW } = require('../helpers/ui-harness.cjs');
(async () => {
  const first = { ...task('a'), title: '客户方案设计', projectId: 'pa' };
  const second = { ...task('b'), title: '客户方案初稿', projectId: 'pa' };
  const state = workspace({ tasks: [first, second], logs: [{ id: 'l1', taskId: 'a', at: NOW, kind: 'progress', text: '关键词记录' }],
    artifacts: [{ id: 'a1', taskId: 'b', at: NOW, summary: '关键词成果', links: [], files: [] }], reports: [] });
  const ui = harness(state); await ui.settle();
  try {
    ui.click('统一检索');
    const input = ui.one(n => n.type === 'input' && n.props.id === 'wp-global-search');
    ui.fire(input, 'onChange', { target: { value: '关键词' } });
    assert.ok(ui.text().includes('找到 2 条'));
    assert.ok(ui.text().includes('关键词记录') && ui.text().includes('关键词成果'));
    assert.equal(ui.requests.length, 0, 'search must not call AI');
    const result = ui.nodes().find(n => n.type === 'button' && (n.children || []).some(c => typeof c === 'string' && c.includes('关键词成果')));
    assert.ok(result); ui.fire(result, 'onClick');
    assert.ok(ui.nodes().some(n => n.props && n.props.value === '客户方案初稿'), 'search opens source task');
    // Open the first task and verify explainable suggestions point to the other one.
    ui.click('统一检索');
    ui.fire(ui.one(n => n.type === 'input' && n.props.id === 'wp-global-search'), 'onChange', { target: { value: '客户方案设计' } });
    const firstRow = ui.nodes().find(n => n.type === 'button' && (n.children || []).some(c => typeof c === 'string' && c.includes('客户方案设计')));
    assert.ok(firstRow); ui.fire(firstRow, 'onClick');
    assert.ok(ui.text().includes('相关历史成果') && ui.text().includes('关键词成果') && ui.text().includes('同一项目'));
    ui.click('数据');
    const format = ui.one(n => n.type === 'select' && n.props.id === 'wp-pref-format');
    assert.equal(format.props.value, '', 'preferences are opt-in');
    ui.fire(format, 'onChange', { target: { value: 'list' } }); await ui.settle();
    assert.equal(ui.storage.json(KEY['workspace-extras']).reportPreferences.format, 'list');
    ui.click('周报/月报');
    ui.click('生成本期报告'); await ui.settle();
    const request = ui.nextRequest('report');
    assert.deepEqual(request.body.preferences, { format: 'list', detail: 'standard', tone: 'neutral' });
    await ui.respond(request, { report: { body: '报告内容' } });
    ui.click('编辑'); ui.edit('待保存的独特报告内容');
    ui.click('统一检索');
    ui.fire(ui.one(n => n.type === 'input' && n.props.id === 'wp-global-search'), 'onChange', { target: { value: '独特报告' } });
    assert.ok(ui.text().includes('未保存的报告编辑'), 'search finds the buffered report separately');
    ui.click('数据'); ui.click('清除报告偏好'); await ui.settle();
    assert.equal(ui.storage.json(KEY['workspace-extras']).reportPreferences, null);
  } finally { ui.close(); }
  console.log('P1 UI integration passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
