'use strict';
const assert = require('node:assert/strict');
const { harness, MemoryStorage } = require('../helpers/ui-harness.cjs');
const NOW = '2026-11-12T04:00:00.000Z';
const TASK_KEY = '@local/work-panel:tasks:v1';
const LOG_KEY = '@local/work-panel:logs:v1';
const has = (node, cls) => String(node.props?.className || '').split(/\s+/).includes(cls);
const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.children || []) : node == null ? '' : String(node);
function state(count = 1) {
  return {
    tasks: Array.from({ length: count }, (_, i) => ({ id: 't-' + i, title: '独立任务 ' + i, projectId: 'p', status: 'todo', urgency: 'medium', progress: 0,
      description: '', deadline: '', expected: '测试通过并提供结果', nextStep: '', blockedReason: '', completedAt: null, deletedAt: null, createdAt: NOW, updatedAt: NOW })),
    projects: [{ id: 'p', name: '个人项目', description: '', color: '', status: 'active', archivedAt: null, createdAt: NOW, updatedAt: NOW }],
    logs: [], artifacts: [], reports: [], inboxAck: [], reportEdits: {},
  };
}
function select(ui, index = 0) {
  ui.fire(ui.one(node => has(node, 'wp-row') && text(node).includes('独立任务 ' + index), 'task row'), 'onClick');
}
function openTab(ui, label) {
  ui.fire(ui.one(node => has(node, 'wp-detail-tab') && text(node).startsWith(label), label + ' tab'), 'onClick');
}
const tests = [];
const test = (name, run) => tests.push({ name, run });

test('AI quick capture prioritizes selected task beyond the first fifty and retains source text', async () => {
  const ui = harness(state(55)); await ui.settle();
  try {
    select(ui, 54);
    const raw = '今天修复了登录问题，测试通过';
    ui.change('wp-quick-input', raw); ui.click('AI 记录');
    const request = ui.nextRequest('chat');
    assert.equal(request.body.context.taskId, 't-54');
    assert.equal(request.body.tasks[0].id, 't-54'); assert.equal(request.body.tasks.length, 50);
    assert.equal(request.body.context.suggestedDeadline, '2026-11-12', 'the first explicit 今天 expression updates the date suggestion');
    await ui.respond(request, { reply: '记录一次推进', actions: [{ op: 'log', taskId: 't-54', kind: 'progress', text: '修复登录并验证通过' }] });
    assert.equal(ui.storage.json(LOG_KEY).length, 0, 'model output alone is not permission');
    ui.click('确认执行');
    const entry = ui.storage.json(LOG_KEY)[0];
    assert.equal(entry.originalText, raw); assert.equal(entry.taskId, 't-54');
    assert.equal(ui.storage.json(TASK_KEY).find(task => task.id === 't-54').status, 'todo');
    openTab(ui, '记录');
    assert.ok(ui.text().includes('查看原始记录'));
    ui.timers.advance(600); await ui.settle();
    assert.equal(ui.server.workspace.logs[0].originalText, raw);
  } finally { ui.close(); }
});

test('Chinese IME composition does not accidentally send quick capture', async () => {
  const ui = harness(state()); await ui.settle();
  try {
    ui.change('wp-quick-input', '还在输入');
    ui.fire(ui.byClass('wp-quick-input'), 'onKeyDown', { key: 'Enter', isComposing: true });
    assert.equal(ui.requests.length, 0); assert.equal(ui.byClass('wp-quick-input').props.value, '还在输入');
  } finally { ui.close(); }
});

test('report chat uses report scope rather than a hidden previously selected task', async () => {
  const ui = harness(state()); await ui.settle();
  try {
    select(ui); ui.reports(); ui.scope('p'); ui.edit('报告中的当前正文');
    ui.click('AI 助手'); ui.change('wp-composer-input', '解释这份报告的风险'); ui.click('发送');
    const request = ui.nextRequest('chat');
    assert.equal(request.body.context.taskId, ''); assert.equal(request.body.context.projectId, 'p');
    assert.equal(request.body.context.report.body, '报告中的当前正文');
    assert.ok(ui.text().includes('当前报告：周报')); assert.ok(ui.text().includes('AI 数据范围'));
    await ui.respond(request, { reply: '仅解释，不修改正文', actions: [] });
    assert.equal(ui.body(), '报告中的当前正文');
  } finally { ui.close(); }
});

test('explicit quick capture date becomes a suggestion, not an invented default', async () => {
  const ui = harness(state()); await ui.settle();
  try {
    ui.click('选择日期 / 时间');
    ui.fire(ui.one(node => node.type === 'button' && has(node, 'wp-cal-day') && text(node) === '13'), 'onClick');
    ui.click('确定'); ui.change('wp-quick-input', '准备交付说明'); ui.click('AI 记录');
    const request = ui.nextRequest('chat');
    assert.equal(request.body.context.suggestedDeadline, '2026-11-13');
    await ui.respond(request, { reply: '请确认', actions: [{ op: 'create', title: '交付说明', deadline: '2026-11-13' }] });
    assert.equal(ui.storage.json(TASK_KEY).length, 1);
  } finally { ui.close(); }
});

test('handoff flushes latest work then opens an unsent append-only DSH draft', async () => {
  const calls = [], prepared = [];
  const ui = harness(state(), undefined, {
    services: { uiWorkspace: { startSession: (...args) => calls.push(args) } },
    contextHook: (body, server) => {
      prepared.push(body); const task = server.workspace.tasks.find(task => task.id === body.taskId);
      return { ok: true, taskId: task.id, prompt: 'taskId=' + task.id + '\n下一步=' + task.nextStep + '\n验收=' + task.expected, revision: server.revision };
    },
  }); await ui.settle();
  try {
    select(ui); openTab(ui, '执行');
    ui.fire(ui.one(node => node.type === 'textarea' && String(node.props.placeholder).includes('当前准备采取的具体动作')), 'onChange', { target: { value: '先运行回归测试' } });
    await ui.click('交给 AI'); await ui.settle();
    assert.deepEqual(prepared, [{ action: 'prepare', taskId: 't-0' }]);
    assert.ok(ui.byClass('wp-delegation-prompt').props.value.includes('先运行回归测试'));
    assert.equal(calls.length, 0, 'preparing the instruction must not execute or navigate');
    ui.click('打开执行草稿');
    assert.equal(calls.length, 1); assert.equal(calls[0][0], undefined);
    assert.equal(calls[0][1].whenDraftExists, 'append'); assert.ok(calls[0][1].prompt.includes('taskId=t-0'));
    assert.equal(ui.storage.json(TASK_KEY)[0].status, 'todo');
  } finally { ui.close(); }
});

test('offline handoff refuses to prepare from stale Host data', async () => {
  let reads = 0;
  const ui = harness(state(), undefined, { contextHook: () => { reads++; return { ok: true, prompt: 'must not use' }; } }); await ui.settle();
  try {
    select(ui); ui.server.offline = true;
    for (const callback of ui.events.get('focus') || []) callback();
    await ui.settle();
    await ui.click('交给 AI'); await ui.settle();
    assert.equal(reads, 0); assert.ok(ui.text().includes('请先同步本机主存'));
  } finally { ui.close(); }
});

test('execution provenance opens its source session while file paths stay inert', async () => {
  const opened = [], copied = [], value = state();
  value.logs = [{ id: 'l-source', taskId: 't-0', at: NOW, kind: 'progress', source: 'execution', text: '已生成文档', sourceSessionId: 'source-session' }];
  value.artifacts = [{ id: 'a-source', taskId: 't-0', at: NOW, summary: '文档', links: [], files: ['/workspace/交付说明.md'], sourceSessionId: 'source-session' }];
  const ui = harness(value, undefined, { services: { uiWorkspace: { openSession: id => opened.push(id) } }, navigator: { clipboard: { writeText: async value => copied.push(value) } } }); await ui.settle();
  try {
    select(ui); openTab(ui, '记录');
    const link = ui.nodes().find(node => has(node, 'wp-source-session') && text(node) === '来源会话');
    ui.fire(link, 'onClick'); assert.deepEqual(opened, ['source-session']);
    openTab(ui, '成果');
    assert.equal(ui.nodes().filter(node => node.type === 'a' && String(node.props.href).startsWith('file:')).length, 0);
    await ui.click('复制路径'); await ui.settle(); assert.deepEqual(copied, ['/workspace/交付说明.md']);
  } finally { ui.close(); }
});

test('focus refresh of the same canonical revision preserves the last user undo', async () => {
  const ui = harness(state()); await ui.settle();
  try {
    ui.click('AI 助手'); ui.change('wp-composer-input', '改标题'); ui.click('发送');
    await ui.respond(ui.nextRequest('chat'), { reply: '确认', actions: [{ op: 'update', taskId: 't-0', patch: { title: '更好的标题' } }] });
    ui.click('确认执行'); ui.timers.advance(600); await ui.settle();
    assert.ok(ui.nodes().some(node => has(node, 'wp-undo-bar')));
    for (const callback of ui.events.get('focus') || []) callback();
    await ui.settle(); assert.ok(ui.nodes().some(node => has(node, 'wp-undo-bar')));
    ui.click('撤销'); assert.equal(ui.storage.json(TASK_KEY)[0].title, '独立任务 0');
  } finally { ui.close(); }
});

test('canonical conflict retains inbox receipt, including after browser cache loss', async () => {
  const queue = [{ id: 'rb-canonical', taskId: 't-0', taskTitle: '', source: 'execution', kind: 'progress', text: '真正完成了一段工作', artifacts: [], receivedAt: NOW }];
  let acknowledgements = 0, next;
  const options = { inboxItems: queue, ackHook: (body, server) => {
    acknowledgements++;
    assert.ok(server.workspace.logs.some(entry => entry.text === queue[0].text), 'canonical record must exist before ACK');
    assert.ok(server.workspace.inboxAck.includes('rb-canonical'));
    queue.splice(0); return { ok: true, removed: body.ids.length };
  } };
  const ui = harness(state(), undefined, options); await ui.settle();
  try {
    ui.server.revision++;
    ui.click('执行回传'); await ui.click('采纳为记录'); await ui.settle();
    assert.equal(acknowledgements, 0); assert.equal(queue.length, 1);
    assert.equal(ui.server.workspace.logs.length, 0); assert.equal(ui.storage.json(LOG_KEY).length, 1);
    ui.close();
    const cleared = new MemoryStorage(); cleared.workspaceServer = ui.server;
    next = harness(state(), cleared, options); await next.settle();
    next.click('执行回传'); assert.ok(next.text().includes('真正完成了一段工作'));
    await next.click('采纳为记录'); await next.settle();
    assert.equal(acknowledgements, 1); assert.equal(queue.length, 0);
    assert.equal(next.server.workspace.logs.length, 1);
  } finally { next?.close(); ui.close(); }
});

for (const invalid of ['{broken JSON', '{}', '[123]']) test('corrupt handled-id cache cannot silently replace canonical receipts: ' + invalid, async () => {
  const value = state(); value.inboxAck = ['already-handled'];
  const ui = harness(value); await ui.settle(); let next;
  try {
    ui.storage.setItem('@local/work-panel:inbox-ack:v1', invalid); ui.close();
    const before = ui.server.calls.filter(call => call.method === 'POST').length;
    next = harness(value, ui.storage); await next.settle();
    assert.deepEqual(next.server.workspace.inboxAck, ['already-handled']);
    assert.equal(next.server.calls.filter(call => call.method === 'POST').length, before);
    assert.ok(next.text().includes('本地数据读取失败'));
  } finally { next?.close(); ui.close(); }
});

test('canonical hydration does not inherit the legacy import record-count cap', async () => {
  const ui = harness(state()); ui.server.workspace = state(5001);
  try {
    await ui.settle();
    assert.equal(ui.storage.json(TASK_KEY).length, 5001);
    assert.equal(ui.server.workspace.tasks.length, 5001);
    assert.equal(ui.byClass('wp-sync-guard').props.disabled, false);
  } finally { ui.close(); }
});

test('pre-migration rollback is explicit, undoable and keeps canonical revisions increasing', async () => {
  const ui = harness(state()); await ui.settle();
  try {
    const initialRevision = ui.server.revision;
    ui.change('wp-quick-input', 'created after migration'); ui.fire(ui.byClass('wp-quick-input'), 'onKeyDown', { key: 'Enter', altKey: true });
    ui.timers.advance(600); await ui.settle(); assert.equal(ui.server.workspace.tasks.length, 2);
    ui.click('设置'); ui.click('数据管理'); ui.click('恢复迁移前副本'); assert.equal(ui.storage.json(TASK_KEY).length, 2);
    ui.click('确认恢复迁移副本'); ui.timers.advance(600); await ui.settle();
    assert.equal(ui.server.workspace.tasks.length, 1); assert.ok(ui.server.revision > initialRevision);
    ui.click('撤销上次导入/清空'); ui.timers.advance(600); await ui.settle();
    assert.equal(ui.server.workspace.tasks.length, 2);
  } finally { ui.close(); }
});

test('data view explains every sync state and marks the current one', async () => {
  const ui = harness(state()); await ui.settle();
  try {
    ui.click('设置'); ui.click('数据管理');
    ui.byClass('wp-sync-legend');
    const plainText = ui.text();
    for (const word of ['同步中', '已同步', '离线', '仅本页保存', '冲突', '异常']) assert.ok(plainText.includes(word), 'missing state ' + word);
    assert.ok(plainText.includes('work_panel_workspace.json'), 'documents the canonical file location');
    const current = ui.nodes().filter(node => has(node, 'wp-sync-legend-row') && has(node, 'wp-sync-legend-current'));
    assert.equal(current.length, 1, 'exactly one state is highlighted');
    assert.ok(current[0] && text(current[0]).startsWith('已同步'), 'ready is the highlighted state');
  } finally { ui.close(); }
});

test('overlong AI quick input stays editable and is not silently sent or cleared', async () => {
  const ui = harness(state()); await ui.settle();
  try {
    const raw = '长'.repeat(4001); ui.change('wp-quick-input', raw); ui.click('AI 记录');
    assert.equal(ui.requests.length, 0); assert.equal(ui.byClass('wp-quick-input').props.value, raw);
    assert.ok(ui.text().includes('当前输入已保留'));
  } finally { ui.close(); }
});

test('Host storage load failure allows ordinary local add and completion without claiming sync', async () => {
  const ui = harness(state(), undefined, { workspaceGetFailure: true }); await ui.settle();
  try {
    assert.equal(ui.byClass('wp-sync-guard').props.disabled, false);
    assert.ok(ui.text().includes('仅本页保存'));
    let warned = false;
    for (const handler of ui.events.get('beforeunload') || []) handler({ preventDefault() { warned = true; }, returnValue: '' });
    assert.equal(warned, true, 'unsynced local-only edits must warn before the page closes');
    ui.change('wp-quick-input', '新的待办事项'); ui.click('添加任务');
    assert.equal(ui.storage.json(TASK_KEY).length, 2);
    assert.equal(ui.server.workspace.tasks.length, 1, 'Host must never be silently overwritten');
    const checkbox = ui.nodes().find(node => has(node, 'wp-row-check') && node.props.title === '标记为已完成');
    assert.ok(checkbox, 'unfinished checkbox must be available'); ui.fire(checkbox, 'onClick');
    assert.ok(ui.storage.json(TASK_KEY).some(task => task.status === 'done'));
    assert.equal(ui.server.workspace.tasks.filter(task => task.status === 'done').length, 0);
    assert.ok(ui.storage.json('@local/work-panel:local-only:v1'));
    assert.equal(ui.server.calls.filter(call => call.method === 'POST').length, 0);
  } finally { ui.close(); }
});

test('restart cannot silently hydrate over tasks edited during Host load failure', async () => {
  const ui = harness(state(), undefined, { workspaceGetFailure: true }); await ui.settle(); let next;
  try {
    ui.change('wp-quick-input', '只存在本页的任务'); ui.fire(ui.byClass('wp-quick-input'), 'onKeyDown', { key: 'Enter' });
    assert.equal(ui.storage.json(TASK_KEY).length, 2); ui.close();
    ui.server.getHook = null;
    next = harness(state(), ui.storage); await next.settle();
    assert.equal(next.storage.json(TASK_KEY).length, 2);
    assert.equal(next.server.workspace.tasks.length, 1);
    assert.equal(next.byClass('wp-sync-guard').props.disabled, false);
    assert.ok(next.text().includes('仅本页保存') && next.text().includes('主存已有数据'));
    next.click('备份后加载主存');
    assert.equal(next.storage.json(TASK_KEY).length, 2, 'first click must only show confirmation');
    next.click('取消'); assert.equal(next.storage.json(TASK_KEY).length, 2);
  } finally { next?.close(); ui.close(); }
});

test('Host load failure with unpersistable local-only marker does not enable editing', async () => {
  const ui = harness(state(), undefined, { workspaceGetFailure: true });
  // The failure is injected for a second mount below; do not touch real storage.
  await ui.settle(); const storage = ui.storage; ui.close();
  storage.removeItem('@local/work-panel:local-only:v1');
  storage.fail('set', '@local/work-panel:local-only:v1', 2);
  const next = harness(state(), storage, { workspaceGetFailure: true }); await next.settle();
  try { assert.equal(next.byClass('wp-sync-guard').props.disabled, true); assert.equal(next.server.calls.filter(call => call.method === 'POST').length, 0); }
  finally { next.close(); }
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`PRODUCT 1.4: ${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
