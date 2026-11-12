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
const openMoveSubmenu = (ui) => {
  const parent = ui.nodes().find(n => n.type === 'button' && has(n, 'wp-row-menu-parent'));
  assert.ok(parent, 'the move parent entry exists');
  assert.ok(text(parent).includes('移动到'), 'parent is labelled 移动到');
  ui.fire(parent, 'onClick');
};

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

test('repeated reminders for one task are grouped and can be cleared at once', async () => {
  // One task that is both overdue and long-blocked: two separate signals, still
  // individually actionable, but shown as one grouped row.
  const old = '2026-09-01T00:00:00.000Z';
  const ui = harness(state([task('a', { deadline: '2026-11-01', blockedReason: '等对方回复', updatedAt: old })]));
  await ui.settle();
  try {
    radarView(ui);
    assert.equal(rows(ui).length, 1, 'one grouped row for the task');
    const body = ui.text();
    // This fixture legitimately yields three signals: overdue, long-blocked and
    // no recent record. All are disclosed and all are cleared by the batch action.
    assert.ok(body.includes('同一任务还有 2 条提示'), 'the other signals are disclosed, not hidden');
    assert.ok(body.includes('全部 3 天后') && body.includes('全部忽略'), 'batch actions offered');
    ui.click('全部忽略'); await ui.settle();
    assert.equal(rows(ui).length, 0, 'both signals cleared together');
    const extras = ui.storage.json('@local/work-panel:workspace-extras:v1');
    assert.equal(Object.keys(extras.radarState.dismissed).length, 3, 'every grouped id dismissed and persisted');
  } finally { ui.close(); }
});

test('a single-signal task shows no grouping controls', async () => {
  const ui = harness(state([task('a', { deadline: '2026-11-01' })])); await ui.settle();
  try {
    radarView(ui);
    assert.equal(rows(ui).length, 1);
    assert.ok(!ui.text().includes('同一任务还有'));
    assert.ok(!ui.text().includes('全部忽略'));
  } finally { ui.close(); }
});

test('typing in a task field never shows the sync banner or shifts the header', async () => {
  const ui = harness(state([task('a')])); await ui.settle();
  try {
    ui.fire(ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a')), 'onClick');
    const title = ui.byClass('wp-detail-title-input');
    assert.ok(title, 'title field is open');
    // Type one character at a time, exactly as a user would.
    for (const value of ['任务 a1', '任务 a12', '任务 a123']) {
      ui.fire(title, 'onChange', { target: { value } });
      // The banner is the layout-shifting element; a quiet sync must not render it.
      assert.equal(ui.nodes().filter(n => has(n, 'wp-host-sync')).length, 0, 'no banner while typing: ' + value);
      assert.equal(ui.byClass('wp-detail-title-input').props.value, value, 'the field stays responsive');
    }
    // A small inline indicator may appear instead, and it must not participate in layout.
    const dots = ui.nodes().filter(n => has(n, 'wp-sync-dot'));
    assert.ok(dots.length <= 1, 'at most one quiet indicator');
    ui.timers.advance(500); await ui.settle();
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1')[0].title, '任务 a123', 'the final value is persisted');
  } finally { ui.close(); }
});

test('quiet background sync never re-renders the panel or shows warning UI', async () => {
  const ui = harness(state([task('a')])); await ui.settle();
  try {
    ui.fire(ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a')), 'onClick');
    // Typing drives the real write -> changed() -> syncing path.
    ui.fire(ui.byClass('wp-detail-title-input'), 'onChange', { target: { value: '任务 a 改' } });
    assert.equal(ui.nodes().filter(n => has(n, 'wp-host-sync')).length, 0, 'no banner while typing');
    ui.timers.advance(600); await ui.settle();
    assert.equal(ui.nodes().filter(n => has(n, 'wp-host-sync')).length, 0, 'no banner after the debounce and sync');
    // No per-write indicator at all: nothing in the header changes while typing.
    assert.equal(ui.nodes().filter(n => has(n, 'wp-sync-dot')).length, 0, 'no sync indicator element');
    assert.equal(ui.nodes().filter(n => has(n, 'wp-host-sync')).length, 0, 'no sync banner element');
  } finally { ui.close(); }
});

test('a debounced edit is not lost when the selection changes immediately', async () => {
  const ui = harness(state([task('a'), task('b')])); await ui.settle();
  try {
    ui.fire(ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a')), 'onClick');
    ui.fire(ui.byClass('wp-detail-title-input'), 'onChange', { target: { value: '改过的标题' } });
    // Switch away before the debounce fires.
    ui.fire(ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 b')), 'onClick');
    await ui.settle();
    const titles = ui.storage.json('@local/work-panel:tasks:v1').map(t => t.title).sort();
    assert.ok(titles.includes('改过的标题'), 'the switched-away edit was flushed, not dropped');
  } finally { ui.close(); }
});

test('the row menu opens at the pointer and to its right', async () => {
  const ui = harness(state([task('a')])); await ui.settle();
  try {
    const row = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    ui.fire(row, 'onContextMenu', { clientX: 120, clientY: 80, preventDefault() {} });
    const menu = ui.nodes().find(n => has(n, 'wp-row-menu'));
    assert.ok(menu, 'menu opens');
    const left = Number(String(menu.props.style.left).replace('px', ''));
    const top = Number(String(menu.props.style.top).replace('px', ''));
    assert.ok(left >= 120, 'never placed left of the pointer, got ' + left);
    assert.ok(left > 120 && left < 120 + 260, 'placed just to the right, got ' + left);
    assert.ok(top >= 80, 'never above the pointer');
  } finally { ui.close(); }
});

test('priority is a colored flag row with the current level highlighted', async () => {
  const ui = harness(state([task('a', { urgency: 'high' })])); await ui.settle();
  try {
    const row = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    ui.fire(row, 'onContextMenu', { clientX: 20, clientY: 20, preventDefault() {} });
    const flags = ui.nodes().filter(n => has(n, 'wp-row-menu-flag'));
    assert.equal(flags.length, 4, 'four priority flags');
    assert.ok(flags.every(f => has(f, 'wp-flag-high') || has(f, 'wp-flag-medium') || has(f, 'wp-flag-low') || has(f, 'wp-flag-none')),
      'each flag carries its own color class');
    assert.ok(flags.some(f => has(f, 'wp-flag-high') && has(f, 'wp-active')), 'current priority is highlighted');
    const low = flags.find(f => has(f, 'wp-flag-low'));
    ui.fire(low, 'onClick'); await ui.settle();
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1')[0].urgency, 'low', 'clicking a flag applies it');
  } finally { ui.close(); }
});

test('moving opens a submenu that pins and checks the current project', async () => {
  const seeded = state([task('a', { projectId: 'p2' })],
    { projects: [
      { id: 'p1', name: '项目一', status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO },
      { id: 'p2', name: '项目二', status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO },
      { id: 'p3', name: '项目三', status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO },
    ] });
  const ui = harness(seeded); await ui.settle();
  try {
    const row = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    ui.fire(row, 'onContextMenu', { clientX: 20, clientY: 20, preventDefault() {} });
    assert.equal(ui.nodes().filter(n => has(n, 'wp-row-submenu')).length, 0, 'submenu is collapsed first');
    openMoveSubmenu(ui); await ui.settle();
    const sub = ui.nodes().find(n => has(n, 'wp-row-submenu'));
    assert.ok(sub, 'submenu opens on demand');
    const items = ui.nodes().filter(n => has(n, 'wp-row-submenu-item'));
    const names = items.map(n => {
      const span = (n.children || []).find(c => c && has(c, 'wp-row-submenu-name'));
      return span ? text(span) : '';
    });
    // 未分组 first, then the current project immediately after it.
    assert.equal(names[0], '未分组', 'ungrouped is always offered');
    assert.equal(names[1], '项目二', 'current project is pinned to the front, got ' + JSON.stringify(names));
    const current = items[1];
    assert.ok(has(current, 'wp-active'), 'current project is highlighted');
    assert.ok((current.children || []).some(c => c && has(c, 'wp-row-submenu-check')), 'current project is checked');
  } finally { ui.close(); }
});

test('the move submenu opens as a side panel to the right, not a dropdown inside', async () => {
  const ui = harness(state([task('a')], { projects: [
    { id: 'p1', name: '项目一', status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO },
    { id: 'p2', name: '项目二', status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO },
  ] })); await ui.settle();
  try {
    const row = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    ui.fire(row, 'onContextMenu', { clientX: 100, clientY: 100, preventDefault() {} });
    const menuBefore = ui.nodes().find(n => has(n, 'wp-row-menu'));
    const beforeChildren = (menuBefore.children || []).length;
    openMoveSubmenu(ui); await ui.settle();
    const menuAfter = ui.nodes().find(n => has(n, 'wp-row-menu'));
    const sub = ui.nodes().find(n => has(n, 'wp-row-submenu-side'));
    assert.ok(sub, 'the submenu is a side panel');
    // It must NOT be nested inside the main menu, or it would push the rest down.
    let inside = false;
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node === sub) { inside = true; return; }
      (node.children || []).forEach(walk);
    };
    walk(menuAfter);
    assert.equal(inside, false, 'the side panel is not a child of the menu (no dropdown growth)');
    assert.equal((menuAfter.children || []).length, beforeChildren, 'the menu does not grow');
    const menuLeft = Number(String(menuAfter.props.style.left).replace('px', ''));
    const subLeft = Number(String(sub.props.style.left).replace('px', ''));
    assert.ok(subLeft > menuLeft, 'panel sits to the right of the menu, got ' + subLeft + ' vs ' + menuLeft);
    assert.equal(sub.props.className.includes('wp-row-submenu'), true);
  } finally { ui.close(); }
});

test('the side panel top aligns with the 移动到 row it belongs to', async () => {
  const ui = harness(state([task('a')], { projects: [{ id: 'p1', name: '项目一', status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO }] }));
  await ui.settle();
  try {
    const row = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    ui.fire(row, 'onContextMenu', { clientX: 100, clientY: 40, preventDefault() {} });
    openMoveSubmenu(ui); await ui.settle();
    const sub = ui.nodes().find(n => has(n, 'wp-row-submenu-side'));
    assert.ok(sub, 'side panel open');
    const subTop = Number(String(sub.props.style.top).replace('px', ''));
    // The harness gives every measured element top=72; the panel must adopt the
    // measured row top rather than a hardcoded offset from the pointer.
    assert.equal(subTop, 72, 'panel top comes from the measured row, got ' + subTop);
  } finally { ui.close(); }
});

test('the project submenu is searchable when there are many projects', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: 'p' + i, name: '项目' + i, status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO }));
  const ui = harness(state([task('a')], { projects: many })); await ui.settle();
  try {
    const row = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    ui.fire(row, 'onContextMenu', { clientX: 20, clientY: 20, preventDefault() {} });
    openMoveSubmenu(ui); await ui.settle();
    const search = ui.nodes().find(n => has(n, 'wp-row-submenu-search'));
    assert.ok(search, 'search field appears for a long list');
    ui.fire(search, 'onChange', { target: { value: '项目7' } }); await ui.settle();
    const names = ui.nodes().filter(n => has(n, 'wp-row-submenu-item')).map(n => {
      const span = (n.children || []).find(c => c && has(c, 'wp-row-submenu-name'));
      return span ? text(span) : '';
    });
    assert.ok(names.includes('项目7'), 'the match stays');
    assert.ok(!names.includes('项目1'), 'non-matches are filtered out, got ' + JSON.stringify(names));
    const target = ui.nodes().filter(n => has(n, 'wp-row-submenu-item')).find(n => {
      const span = (n.children || []).find(c => c && has(c, 'wp-row-submenu-name'));
      return span && text(span) === '项目7';
    });
    ui.fire(target, 'onClick'); await ui.settle();
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1')[0].projectId, 'p7', 'the filtered choice applies');
  } finally { ui.close(); }
});

test('a short project list needs no search field', async () => {
  const ui = harness(state([task('a')], { projects: [{ id: 'p1', name: '项目一', status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO }] }));
  await ui.settle();
  try {
    const row = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    ui.fire(row, 'onContextMenu', { clientX: 20, clientY: 20, preventDefault() {} });
    openMoveSubmenu(ui); await ui.settle();
    assert.equal(ui.nodes().filter(n => has(n, 'wp-row-submenu-search')).length, 0, 'no search field for a short list');
    assert.ok(ui.nodes().filter(n => has(n, 'wp-row-submenu-item')).length >= 2, 'options still listed');
  } finally { ui.close(); }
});

test('the row menu still moves a task and soft-deletes it', async () => {
  const ui = harness(state([task('a')], { projects: [{ id: 'p1', name: '项目一', status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO }] }));
  await ui.settle();
  try {
    const row = () => ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    ui.fire(row(), 'onContextMenu', { clientX: 10, clientY: 10, preventDefault() {} });
    openMoveSubmenu(ui); await ui.settle();
    const moveBtn = ui.nodes().filter(n => has(n, 'wp-row-submenu-item')).find(n => {
      const span = (n.children || []).find(c => c && has(c, 'wp-row-submenu-name'));
      return span && text(span) === '项目一';
    });
    ui.fire(moveBtn, 'onClick'); await ui.settle();
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1')[0].projectId, 'p1');
    ui.fire(row(), 'onContextMenu', { clientX: 10, clientY: 10, preventDefault() {} });
    ui.click('移到回收站'); await ui.settle();
    assert.ok(ui.storage.json('@local/work-panel:tasks:v1')[0].deletedAt, 'soft-deleted');
  } finally { ui.close(); }
});

test('Escape and outside clicks dismiss the row menu without changing data', async () => {
  const ui = harness(state([task('a')])); await ui.settle();
  try {
    const row = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    ui.fire(row, 'onContextMenu', { clientX: 5, clientY: 5, preventDefault() {} });
    assert.equal(ui.nodes().filter(n => has(n, 'wp-row-menu')).length, 1);
    for (const handler of ui.events.get('keydown') || []) handler({ key: 'Escape' });
    await ui.settle();
    assert.equal(ui.nodes().filter(n => has(n, 'wp-row-menu')).length, 0, 'Escape closes it');
    ui.fire(row, 'onContextMenu', { clientX: 5, clientY: 5, preventDefault() {} });
    for (const handler of ui.events.get('click') || []) handler({});
    await ui.settle();
    assert.equal(ui.nodes().filter(n => has(n, 'wp-row-menu')).length, 0, 'outside click closes it');
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1')[0].urgency, 'medium', 'no accidental edit');
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
