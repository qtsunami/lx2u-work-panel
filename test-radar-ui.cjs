'use strict';
// 1.5.0 product interactions: the radar must surface facts from local rules,
// respect snooze/dismiss persistence, and never claim the model decided.
const assert = require('node:assert/strict');
const { harness } = require('./test-stability.cjs');
const NOW_ISO = '2026-11-12T04:00:00.000Z';
const has = (node, cls) => String(node.props?.className || '').split(/\s+/).includes(cls);
const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.children || []) : node == null ? '' : String(node);
function task(id, patch = {}) {
  return { id, title: '任务 ' + id, projectId: '', status: 'todo', urgency: 'medium', progress: 0,
    description: '', deadline: '', expected: '', nextStep: '', blockedReason: '', completedAt: null,
    deletedAt: null, createdAt: NOW_ISO, updatedAt: NOW_ISO, ...patch };
}
function state(tasks = [], patch = {}) {
  return { tasks, projects: [], logs: [], artifacts: [], reports: [], inboxAck: [], reportEdits: {}, ...patch };
}
const tests = [];
const test = (name, run) => tests.push({ name, run });
const radarView = (ui) => { ui.click('需要注意'); return ui; };
const rows = (ui) => ui.nodes().filter(node => has(node, 'wp-radar-item'));
test('radar opens from the sidebar and reports an overdue task as a stated fact', async () => {
  // The injected VM clock is fixed at NOW_ISO, so this deadline is in the past.
  const ui = harness(state([task('a', { deadline: '2026-11-01' })])); await ui.settle();
  try {
    radarView(ui);
    assert.equal(rows(ui).length, 1, 'one issue');
    const body = ui.text();
    assert.ok(body.includes('已逾期'), 'kind label shown');
    assert.ok(body.includes('任务 a'), 'task title shown');
    assert.ok(/已逾期 \d+ 天/.test(body), 'states the elapsed days as a fact');
    assert.ok(body.includes('提示来自本地规则'), 'discloses that local rules produced it');
  } finally { ui.close(); }
});

test('an empty radar states there is nothing to note instead of inventing work', async () => {
  const ui = harness(state([task('a', { deadline: '2099-01-01' })])); await ui.settle();
  try {
    radarView(ui);
    assert.equal(rows(ui).length, 0);
    assert.ok(ui.text().includes('当前没有需要特别注意的事项'));
  } finally { ui.close(); }
});

test('snoozing hides an issue, persists it, and it returns after the snooze expires', async () => {
  const ui = harness(state([task('a', { deadline: '2026-11-01' })])); await ui.settle();
  try {
    radarView(ui);
    assert.equal(rows(ui).length, 1);
    ui.click('3 天后'); ui.settle();
    assert.equal(rows(ui).length, 0, 'hidden while snoozed');
    assert.ok(ui.text().includes('已稍后或忽略'));
    const extras = ui.storage.json('@local/work-panel:workspace-extras:v1');
    assert.ok(extras && extras.radarState && Object.keys(extras.radarState.snoozed).length === 1, 'snooze persisted to workspace extras');
    const issueId = Object.keys(extras.radarState.snoozed)[0];
    assert.match(issueId, /^overdue:/, 'issue ids are stable keys for snooze/dismiss');
    ui.close();
    // Re-mount with the same storage but an already expired snooze: the issue
    // must come back on its own, without any special user action.
    const storage = ui.storage;
    const rewound = JSON.parse(JSON.stringify(extras));
    rewound.radarState.snoozed[issueId] = '2026-11-01T00:00:00.000Z';
    storage.setItem('@local/work-panel:workspace-extras:v1', JSON.stringify(rewound));
    const next = harness(state([task('a', { deadline: '2026-11-01' })]), storage);
    try {
      await next.settle(); radarView(next);
      assert.equal(rows(next).length, 1, 'an expired snooze surfaces the issue again');
    } finally { next.close(); }
  } finally { ui.close(); }
});

test('dismissing is permanent and can be reversed explicitly', async () => {
  const ui = harness(state([task('a', { deadline: '2026-11-01' })])); await ui.settle();
  try {
    radarView(ui);
    ui.click('忽略'); await ui.settle();
    assert.equal(rows(ui).length, 0);
    assert.ok(ui.text().includes('恢复已隐藏的 1 条'));
    ui.click('恢复已隐藏的 1 条'); await ui.settle();
    assert.equal(rows(ui).length, 1, 'restoring clears the dismissal');
    const extras = ui.storage.json('@local/work-panel:workspace-extras:v1');
    assert.deepEqual(extras.radarState.dismissed, {}, 'dismissal cleared in storage');
  } finally { ui.close(); }
});

test('a stale task is described as lacking records, not as lacking effort', async () => {
  const old = '2026-09-01T00:00:00.000Z';
  const ui = harness(state([task('a', { deadline: '2099-01-01', updatedAt: old, createdAt: old })])); await ui.settle();
  try {
    radarView(ui);
    const body = ui.text();
    assert.ok(body.includes('暂无近期记录'), 'uses the record-based phrasing');
    for (const banned of ['没有工作', '未工作', '没有任何进展']) {
      assert.ok(!body.includes(banned), 'must not infer effort: ' + banned);
    }
  } finally { ui.close(); }
});

test('AI explanation is labelled as advice and does not alter the issue', async () => {
  const ui = harness(state([task('a', { deadline: '2026-11-01' })])); await ui.settle();
  try {
    radarView(ui);
    ui.click('AI 解释');
    const request = ui.nextRequest('chat');
    assert.ok(request.body.context && request.body.context.radar, 'bounded radar evidence is sent');
    assert.equal(request.body.context.radar.kind, 'overdue');
    await ui.respond(request, { reply: '建议先确认是否需要延期。', actions: [] });
    const body = ui.text();
    assert.ok(body.includes('建议先确认是否需要延期'));
    assert.ok(body.includes('仅供参考，不是事实判定'));
    assert.equal(rows(ui).length, 1, 'explaining changes nothing');
  } finally { ui.close(); }
});

test('automation is disabled by default and no scheduled generation is promised', async () => {
  const ui = harness(state([task('a')])); await ui.settle();
  try {
    const extras = ui.storage.json('@local/work-panel:workspace-extras:v1');
    assert.ok(!extras || !extras.autoSettings || extras.autoSettings.enabled !== true, 'no enabled automation on a fresh install');
  } finally { ui.close(); }
});

test('automation controls stay off by default and enable only on an explicit click', async () => {
  const ui = harness(state([task('a')])); await ui.settle();
  try {
    ui.click('数据');
    assert.ok(ui.text().includes('自动生成工作报告'));
    assert.ok(ui.text().includes('未开启 · 点击开启'));
    assert.ok(ui.text().includes('当前未开启，不会产生任何自动生成'));
    assert.equal(ui.requests.length, 0, 'opening the page must not call the model');
    ui.click('未开启 · 点击开启'); await ui.settle();
    const extras = ui.storage.json('@local/work-panel:workspace-extras:v1');
    assert.equal(extras.autoSettings.enabled, true, 'explicit opt-in persists');
    assert.ok(ui.text().includes('已开启 · 点击关闭'));
    // Turning it off again must be equally explicit and durable.
    ui.click('已开启 · 点击关闭'); await ui.settle();
    const after = ui.storage.json('@local/work-panel:workspace-extras:v1');
    assert.equal(after.autoSettings.enabled, false);
  } finally { ui.close(); }
});

test('an unsupported time zone is reported instead of generating at a wrong time', async () => {
  const ui = harness(state([task('a')])); await ui.settle();
  try {
    ui.click('数据');
    const zone = ui.nodes().find(node => node.type === 'input' && node.props.type === 'text' && node.props.value === 'Asia/Shanghai');
    assert.ok(zone, 'time zone field exists');
    ui.fire(zone, 'onChange', { target: { value: 'Mars/Olympus' } }); await ui.settle();
    ui.click('未开启 · 点击开启'); await ui.settle();
    await ui.click('立即生成一次'); await ui.settle();
    assert.equal(ui.requests.length, 0, 'must not call the model with an unusable zone');
    assert.ok(ui.text().includes('时区无法识别'), 'explains why nothing happened');
  } finally { ui.close(); }
});

test('manual generation creates a draft without touching tasks or the open editor', async () => {
  // A manual run targets the period the user is viewing (the week of
  // 11-09..11-15), so the evidence must belong to that week.
  const carried = state([task('a', { status: 'done', completedAt: NOW_ISO })],
    { logs: [{ id: 'l1', taskId: 'a', at: NOW_ISO, kind: 'progress', text: '完成主体工作' }] });
  const ui = harness(carried); await ui.settle();
  try {
    ui.click('数据');
    ui.click('未开启 · 点击开启'); await ui.settle();
    ui.button('立即生成一次').props.onClick(); await ui.settle(); await ui.settle();
    const request = ui.nextRequest('report');
    assert.equal(request.body.kind, 'week');
    await ui.respond(request, { report: { body: '## 一、本期主要成果\n自动草稿正文' } });
    const reports = ui.storage.json('@local/work-panel:reports:v1') || [];
    const auto = reports.filter(r => r.auto === true);
    assert.equal(auto.length, 1, 'one machine-generated draft stored');
    assert.ok(auto[0].body.includes('自动草稿正文'));
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1')[0].status, 'done', 'task status untouched');
    assert.ok(ui.text().includes('已生成'));
  } finally { ui.close(); }
});

test('a user-edited draft is never overwritten by a later automatic run', async () => {
  const carried = state([task('a', { status: 'done', completedAt: NOW_ISO })],
    { logs: [{ id: 'l1', taskId: 'a', at: NOW_ISO, kind: 'progress', text: '完成主体工作' }] });
  const ui = harness(carried); await ui.settle();
  let next;
  try {
    ui.click('数据');
    ui.click('未开启 · 点击开启'); await ui.settle();
    ui.button('立即生成一次').props.onClick(); await ui.settle(); await ui.settle();
    await ui.respond(ui.nextRequest('report'), { report: { body: '自动版本' } });
    const reports = ui.storage.json('@local/work-panel:reports:v1');
    const autoId = reports.find(r => r.auto).id;
    // The user edits that draft by hand: it is no longer a machine draft.
    ui.storage.setItem('@local/work-panel:reports:v1', JSON.stringify(
      reports.map(r => r.id === autoId ? { ...r, body: '我手工改过的版本', auto: undefined } : r)));
    ui.close();
    next = harness(carried, ui.storage);
    await next.settle(); next.click('数据');
    next.button('立即生成一次').props.onClick(); await next.settle(); await next.settle();
    assert.equal(next.requests.filter(r => r.body.mode === 'report').length, 0, 'no model call that could overwrite');
    assert.ok(next.text().includes('已有你的手工草稿'));
    assert.equal(next.storage.json('@local/work-panel:reports:v1').find(r => r.id === autoId).body, '我手工改过的版本');
  } finally { if (next) next.close(); ui.close(); }
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`RADAR UI 1.5: ${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
