'use strict';
// Reuse the existing isolated, effect-aware UI harness without executing its suite.
// Run: node work-panel/tests/ui/test-acceptance-ui.cjs
const assert = require('node:assert/strict');
const { harness, workspace, task, KEY } = require('../helpers/ui-harness.cjs');
const item = { id: 'receipt-1', taskId: 'ta', source: 'execution', text: '旧格式摘要', workDone: '实现功能', verification: '测试通过', remainingIssues: '待复核', artifacts: [{ summary: '成果', links: [], files: ['/tmp/result'] }] };
async function open(overrides = {}, options = {}) {
  const state = workspace({ tasks: [{ ...task('ta'), status: 'todo', progress: 0, completedAt: null }], ...overrides });
  const ui = harness(state, undefined, { inboxItems: [item], ...options });
  await ui.settle(); ui.click('执行回传'); await ui.settle(); return ui;
}
(async () => {
  {
    const ui = await open();
    for (const value of ['旧格式摘要', '已完成工作', '实现功能', '验证情况', '测试通过', '遗留问题', '待复核', '成果', '不代表验收']) assert.ok(ui.text().includes(value), value);
    assert.equal(ui.storage.json(KEY.logs, []).length, 0);
    ui.click('要求补充（生成草稿）');
    assert.ok(ui.text().includes('尚未发送'));
    assert.ok(ui.byClass('wp-report-editor').props.value.includes('请补充'));
    ui.change('wp-report-editor', '我的草稿');
    ui.click('继续推进（生成草稿）');
    assert.equal(ui.byClass('wp-report-editor').props.value, '我的草稿');
    assert.equal(ui.storage.json(KEY.logs, []).length, 0);
    assert.equal(ui.storage.json(KEY['inbox-ack'], []).length, 0);
    assert.equal(ui.requests.length, 0); ui.close();
  }
  {
    const ui = await open(); ui.click('继续推进（生成草稿）');
    assert.ok(ui.byClass('wp-report-editor').props.value.includes('请继续推进'));
    assert.ok(ui.text().includes('尚未发送')); ui.close();
  }
  {
    const ui = await open(); await ui.click('接受成果'); await ui.settle();
    const logs = ui.storage.json(KEY.logs, []);
    assert.equal(logs.length, 1);
    for (const value of ['人工验收：接受成果', '旧格式摘要', '实现功能', '测试通过', '待复核']) assert.ok(logs[0].text.includes(value), value);
    assert.equal(logs[0].receiptFields.verification, '测试通过');
    assert.equal(ui.storage.json(KEY.artifacts, []).length, 1);
    assert.equal(ui.storage.json(KEY.tasks, [])[0].status, 'todo');
    assert.deepEqual(ui.storage.json(KEY['inbox-ack'], []), ['receipt-1']);
    ui.click('周报/月报'); ui.click('生成本期报告'); await ui.settle();
    const reportRequest = ui.nextRequest('report');
    assert.equal(reportRequest.body.evidence[0].logs[0].receiptFields.verification, '测试通过');
    await ui.respond(reportRequest, { report: { body: '报告' } }); ui.close();
  }
  {
    const ui = await open({}, { inboxItems: [{ id: 'old', taskId: 'ta', source: 'execution', text: '旧回传', artifacts: [] }] });
    assert.ok(ui.text().includes('旧回传')); await ui.click('采纳为记录'); await ui.settle();
    assert.equal(ui.storage.json(KEY.logs, [])[0].text, '旧回传'); ui.close();
  }
  {
    const ui = await open(); ui.storage.fail('set', KEY.logs); await ui.click('接受成果'); await ui.settle();
    assert.equal(ui.storage.json(KEY.logs, []).length, 0);
    assert.equal(ui.storage.json(KEY['inbox-ack'], []).length, 0);
    assert.ok(ui.text().includes('实现功能')); ui.close();
  }
  console.log('acceptance UI tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
