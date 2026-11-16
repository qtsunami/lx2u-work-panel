'use strict';
// Effect-aware regression harness; all storage and networking are isolated fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const fixturePath = path.join(__dirname, 'test-stability.cjs');
const harnessSource = fs.readFileSync(fixturePath, 'utf8').split('const tests = [];')[0];
const m = new Module(fixturePath, module); m.filename = fixturePath; m.paths = module.paths;
m._compile(harnessSource + '\nmodule.exports = { harness, workspace, task, KEY, NOW };', fixturePath);
const { harness, workspace, task, KEY, NOW } = m.exports;
const baseTask = (id, title) => ({ ...task(id, 'p', title), status: 'todo', progress: 0, completedAt: null, nextStep: '原下一步' });
const receipts = [{ id: 'receipt-a', taskId: 'a', text: '尚待验收', verification: '运行了测试', artifacts: [] },
  { id: 'receipt-b', taskId: 'b', text: '其他任务回执', artifacts: [] }];
const state = () => workspace({ tasks: [baseTask('a', '客户方案'), baseTask('b', '历史客户方案')],
  logs: [{ id: 'log-a', taskId: 'a', text: '已经整理初稿', at: NOW, kind: 'progress' }],
  artifacts: [{ id: 'art-b', taskId: 'b', summary: '历史客户方案参考', files: ['/secret/path'], links: ['https://private'], at: NOW }] });
const reply = { reply: '请人工核对', options: [{ text: '与客户核对范围', evidence: [{ type: 'log', id: 'log-a' }, { type: 'artifact', id: 'art-b' }], uncertainty: '可能需要补充信息' }],
  receiptSummary: [{ id: 'receipt-a', summary: '测试待核对', uncertainty: '尚未验收' }] };
const has = (n, c) => typeof n?.props?.className === 'string' && n.props.className.split(' ').includes(c);
const text = n => typeof n === 'string' ? n : n && typeof n === 'object' ? (n.children || []).map(text).join('') : '';
async function open(options = {}) {
  const ui = harness(state(), undefined, { inboxItems: receipts, ...options }); await ui.settle();
  const row = ui.one(n => has(n, 'wp-row') && text(n).includes('客户方案') && !text(n).includes('历史客户方案'));
  ui.fire(row, 'onClick'); ui.click('工作助手'); return ui;
}
(async () => {
  {
    const ui = await open(); try {
      assert.equal(ui.requests.length, 0, 'opening panel does not call model');
      assert.ok(ui.text().includes('历史客户方案参考') && ui.text().includes('本地匹配'));
      ui.click('生成工作建议'); await ui.settle();
      const request = ui.nextRequest('task'); assert.equal(request.body.intent, 'assist');
      assert.equal(request.body.task.id, 'a'); assert.deepEqual(request.body.receipts.map(x => x.id), ['receipt-a']);
      assert.ok(!JSON.stringify(request.body).includes('/secret/path') && !JSON.stringify(request.body).includes('https://private'));
      const original = ui.storage.json(KEY.tasks); await ui.respond(request, reply);
      assert.deepEqual(ui.storage.json(KEY.tasks), original); assert.deepEqual(ui.storage.json(KEY['inbox-ack'], []), []);
      assert.ok(ui.text().includes('人工核对') && ui.text().includes('不确定性') && ui.text().includes('已经整理初稿'));
      ui.click('选择作为下一步'); assert.ok(ui.text().includes('当前下一步：原下一步'));
      assert.equal(ui.storage.json(KEY.tasks).find(t => t.id === 'a').nextStep, '原下一步');
      ui.click('确认写入下一步'); await ui.settle();
      assert.equal(ui.storage.json(KEY.tasks).find(t => t.id === 'a').nextStep, '与客户核对范围');
      assert.equal(ui.storage.json(KEY.tasks).find(t => t.id === 'a').status, 'todo');
      assert.deepEqual(ui.storage.json(KEY['inbox-ack'], []), []);
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      ui.click('生成工作建议'); await ui.settle(); const request = ui.nextRequest('task');
      // Modify the same task while the network call is in flight.
      const description = ui.one(n => n.type === 'textarea' && has(n, 'wp-detail-desc-input'));
      ui.fire(description, 'onChange', { target: { value: '新增上下文' } });
      await ui.respond(request, reply);
      assert.ok(ui.text().includes('已变化，请重新整理'));
      assert.equal(ui.storage.json(KEY.tasks).find(t => t.id === 'a').nextStep, '原下一步');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      ui.click('生成工作建议'); await ui.settle(); const request = ui.nextRequest('task'); await ui.respond(request, reply);
      ui.click('选择作为下一步'); ui.storage.fail('set', KEY.tasks); ui.click('确认写入下一步'); await ui.settle();
      assert.equal(ui.storage.json(KEY.tasks).find(t => t.id === 'a').nextStep, '原下一步');
      assert.ok(ui.text().includes('保存失败'));
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      ui.click('生成工作建议'); await ui.settle(); const old = ui.nextRequest('task');
      ui.click('工作助手'); ui.click('工作助手'); ui.click('生成工作建议'); await ui.settle(); const newer = ui.nextRequest('task');
      await ui.respond(old, reply);
      assert.ok(!ui.text().includes('与客户核对范围'), 'closed-panel old response must be ignored');
      await ui.respond(newer, reply); assert.ok(ui.text().includes('与客户核对范围'));
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      ui.click('生成工作建议'); await ui.settle(); const request = ui.nextRequest('task'); await ui.respond(request, reply);
      ui.click('选择作为下一步');
      const nextStep = ui.one(n => n.type === 'textarea' && n.props.value === '原下一步');
      ui.fire(nextStep, 'onChange', { target: { value: '用户新写的下一步' } }); await ui.settle();
      assert.equal(ui.button('确认写入下一步').props.disabled, true);
      assert.equal(ui.storage.json(KEY.tasks).find(t => t.id === 'a').nextStep, '用户新写的下一步');
      assert.ok(ui.text().includes('建议可能过期'));
    } finally { ui.close(); }
  }
  {
    let live = receipts.slice();
    const ui = await open({ inboxHook: () => ({ items: live }) }); try {
      live = live.filter(item => item.id !== 'receipt-a');
      ui.click('生成工作建议'); await ui.settle();
      assert.equal(ui.requests.length, 0, 'changed receipts must be refreshed before sending to model');
      assert.ok(ui.text().includes('回执或任务已变化'));
    } finally { ui.close(); }
  }
  {
    let live = receipts.slice();
    const ui = await open({ inboxHook: () => ({ items: live }) }); try {
      ui.click('生成工作建议'); await ui.settle(); const request = ui.nextRequest('task'); await ui.respond(request, reply);
      ui.click('选择作为下一步'); live = live.filter(item => item.id !== 'receipt-a');
      ui.click('确认写入下一步'); await ui.settle();
      assert.equal(ui.storage.json(KEY.tasks).find(t => t.id === 'a').nextStep, '原下一步');
      assert.ok(ui.text().includes('回执或任务已变化'));
    } finally { ui.close(); }
  }
  {
    const ui = await open({ inboxHook: () => { throw new Error('offline'); } }); try {
      assert.ok(ui.text().includes('回执连接异常'));
      ui.click('生成工作建议'); await ui.settle();
      assert.equal(ui.requests.length, 0, 'do not claim a stale or failed inbox is current');
      assert.ok(ui.text().includes('请先恢复连接'));
    } finally { ui.close(); }
  }
  console.log('TASK ASSISTANT: 8 interaction scenarios passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
