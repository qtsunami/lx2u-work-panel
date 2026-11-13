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
const gotoDone = (ui) => {
  const nav = ui.nodes().find(n => n.type === 'button' && has(n, 'wp-nav-item')
    && (n.children || []).some(c => c && has(c, 'wp-nav-label') && text(c) === '已完成/废弃'));
  assert.ok(nav, 'the 已完成/废弃 nav entry exists');
  ui.fire(nav, 'onClick');
};

const expandGroup = (ui, label) => {
  const group = ui.nodes().find(n => has(n, 'wp-group') && text(n).includes(label));
  if (group) { const toggle = (group.children || []).find(c => c && c.type === 'button'); if (toggle) ui.fire(toggle, 'onClick'); }
};

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

test('the side panel sits flush against the menu with no gap or overlap', async () => {
  const ui = harness(state([task('a')], { projects: [{ id: 'p1', name: '项目一', status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO }] }));
  await ui.settle();
  try {
    const row = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    // Far from the right edge so no flipping happens.
    ui.fire(row, 'onContextMenu', { clientX: 100, clientY: 60, preventDefault() {} });
    const menu = ui.nodes().find(n => has(n, 'wp-row-menu'));
    openMoveSubmenu(ui); await ui.settle();
    const sub = ui.nodes().find(n => has(n, 'wp-row-submenu-side'));
    assert.ok(sub, 'side panel open');
    const menuLeft = Number(String(menu.props.style.left).replace('px', ''));
    const subLeft = Number(String(sub.props.style.left).replace('px', ''));
    // Widths are declared in CSS; assert the relationship the layout relies on.
    const MENU_W = 150;
    assert.equal(subLeft, menuLeft + MENU_W, 'panel starts exactly at the menu edge, got ' + subLeft + ' vs ' + (menuLeft + MENU_W));
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
    assert.ok(!ui.storage.json('@local/work-panel:tasks:v1')[0].deletedAt, 'not deleted before confirmation');
    assert.ok(ui.text().includes('删除这个任务？'), 'confirmation appears');
    ui.click('删除'); await ui.settle();
    assert.ok(ui.storage.json('@local/work-panel:tasks:v1')[0].deletedAt, 'soft-deleted after confirming');
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

test('deleting from the task detail asks first, and cancel keeps the task', async () => {
  const ui = harness(state([task('a')])); await ui.settle();
  try {
    ui.fire(ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a')), 'onClick');
    ui.click('移入回收站'); await ui.settle();
    assert.ok(ui.text().includes('删除这个任务？'), 'confirmation dialog shown');
    assert.ok(!ui.storage.json('@local/work-panel:tasks:v1')[0].deletedAt, 'nothing deleted yet');
    ui.click('取消'); await ui.settle();
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1')[0].deletedAt, null, 'cancel keeps the task');
    assert.ok(!ui.text().includes('删除这个任务？'), 'dialog closed');
    // The cancel cleared the selection, so re-open the task before confirming.
    ui.fire(ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a')), 'onClick');
    ui.click('移入回收站'); await ui.settle();
    ui.click('删除'); await ui.settle();
    assert.ok(ui.storage.json('@local/work-panel:tasks:v1')[0].deletedAt, 'confirmed delete applies');
  } finally { ui.close(); }
});

test('the confirmation names the task so a mis-click is obvious', async () => {
  const ui = harness(state([task('a')])); await ui.settle();
  try {
    ui.fire(ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a')), 'onClick');
    ui.click('移入回收站'); await ui.settle();
    assert.ok(ui.text().includes('「任务 a」'), 'the exact task title is shown');
    assert.ok(ui.text().includes('可随时恢复'), 'explains that it is recoverable');
  } finally { ui.close(); }
});

test('a task can be dropped, shown closed with a cross, and restored', async () => {
  const ui = harness(state([task('a'), task('b')])); await ui.settle();
  try {
    const rowOf = (label) => ui.nodes().find(n => has(n, 'wp-row') && text(n).includes(label));
    ui.fire(rowOf('任务 a'), 'onContextMenu', { clientX: 10, clientY: 10, preventDefault() {} });
    ui.click('标记为废弃'); await ui.settle();
    const dropped = ui.storage.json('@local/work-panel:tasks:v1').find(t => t.id === 'a');
    assert.equal(dropped.status, 'dropped', 'stored as dropped');
    assert.equal(dropped.completedAt, null, 'a drop is not a completion');
    // It lives with completed tasks, not in the open list.
    assert.ok(!ui.text().includes('任务 a'), 'gone from the open list');
    gotoDone(ui); await ui.settle();
    expandGroup(ui, '已完成');
    assert.ok(ui.text().includes('任务 a'), 'listed under 已完成');
    const crossRow = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 a'));
    assert.ok(ui.nodes().some(n => has(n, 'wp-check-dropped')), 'shows the dropped (cross) affordance');
    assert.ok(!ui.nodes().some(n => has(n, 'wp-row-check') && n.props['aria-checked'] === 'true'
      && text(ui.nodes().find(p => has(p, 'wp-row') && text(p).includes('任务 a')) || {}).includes('任务 a')), 'not presented as checked');
    // Restore from the cross itself.
    const cross = ui.nodes().find(n => has(n, 'wp-check-dropped') && has(n, 'wp-row-check'));
    ui.fire(cross, 'onClick'); await ui.settle();
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1').find(t => t.id === 'a').status, 'todo', 'restored to todo');
  } finally { ui.close(); }
});

test('completed and dropped tasks are visually distinguishable in the closed list', async () => {
  const done = task('d', { status: 'done', completedAt: NOW_ISO });
  const dropped = task('x', { status: 'dropped', droppedAt: NOW_ISO });
  const ui = harness(state([done, dropped])); await ui.settle();
  try {
    gotoDone(ui); await ui.settle();
    expandGroup(ui, '已完成');
    const checks = ui.nodes().filter(n => has(n, 'wp-row-check'));
    const doneCheck = checks.find(n => has(n, 'wp-checked') && !has(n, 'wp-check-dropped'));
    const dropCheck = checks.find(n => has(n, 'wp-check-dropped'));
    assert.ok(doneCheck, 'completed task keeps the filled check');
    assert.ok(dropCheck, 'dropped task gets the cross treatment');
    assert.notEqual(dropCheck.props.className, doneCheck.props.className, 'the two affordances differ');
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

const autoFixture = () => state([task('a', { status: 'done', completedAt: NOW_ISO })],
  { logs: [{ id: 'l1', taskId: 'a', at: NOW_ISO, kind: 'progress', text: '完成主体工作' }] });
const startAuto = async (ui) => {
  ui.click('数据'); ui.click('未开启 · 点击开启'); await ui.settle();
  ui.button('立即生成一次').props.onClick(); await ui.settle(); await ui.settle();
  return ui.nextRequest('report');
};

test('auto report result is discarded when a user edits or saves the target during generation', async () => {
  for (const save of [false, true]) {
    const ui = harness(autoFixture()); await ui.settle();
    try {
      const request = await startAuto(ui);
      ui.reports(); ui.edit('我正在写的报告');
      if (save) ui.click('保存草稿');
      await ui.respond(request, { report: { body: '过期的 AI 答复' } });
      const reports = ui.storage.json('@local/work-panel:reports:v1', []);
      assert.ok(!reports.some(r => r.body === '过期的 AI 答复'), 'AI reply never overwrites human work');
      if (save) assert.ok(reports.some(r => r.body === '我正在写的报告'));
      else assert.ok(JSON.stringify(ui.storage.json('@local/work-panel:report-edits:v1', {})).includes('我正在写的报告'),
        'unsaved human text remains in the edit buffer');
      const extras = ui.storage.json('@local/work-panel:workspace-extras:v1', {});
      assert.ok(!extras.autoState || extras.autoState.lastRunOk !== true, 'stale result cannot mark success');
    } finally { ui.close(); }
  }
});

test('auto report result is discarded when settings change before the reply', async () => {
  const ui = harness(autoFixture()); await ui.settle();
  try {
    const request = await startAuto(ui);
    const zone = ui.nodes().find(n => n.type === 'input' && n.props.value === 'Asia/Shanghai');
    assert.ok(zone, 'the zone setting is editable');
    ui.fire(zone, 'onChange', { target: { value: 'UTC' } }); await ui.settle();
    await ui.respond(request, { report: { body: '失效配置的报告' } });
    assert.equal(ui.storage.json('@local/work-panel:reports:v1', []).length, 0);
    assert.ok(!ui.storage.json('@local/work-panel:workspace-extras:v1').autoState.lastRunOk);
  } finally { ui.close(); }
});

test('auto draft and numeric run time persist together; a failed report write cannot claim success', async () => {
  const ui = harness(autoFixture()); await ui.settle();
  try {
    const request = await startAuto(ui);
    ui.storage.fail('set', '@local/work-panel:reports:v1');
    await ui.respond(request, { report: { body: '不能持久化的报告' } });
    assert.equal(ui.storage.json('@local/work-panel:reports:v1', []).length, 0);
    const failure = ui.storage.json('@local/work-panel:workspace-extras:v1').autoState;
    assert.notEqual(failure.lastRunOk, true, 'no false success after write failure');
    assert.equal(typeof failure.lastRunAt, 'number', 'run time uses milliseconds, not ISO string');
  } finally { ui.close(); }
  const good = harness(autoFixture()); await good.settle();
  try {
    const request = await startAuto(good);
    await good.respond(request, { report: { body: '有效自动草稿' } });
    const draft = good.storage.json('@local/work-panel:reports:v1')[0];
    const success = good.storage.json('@local/work-panel:workspace-extras:v1').autoState;
    assert.equal(draft.auto, true);
    assert.equal(success.lastRunOk, true);
    assert.equal(typeof success.lastRunAt, 'number');
    assert.ok(good.text().includes('最近结果') && !good.text().includes('尚未运行过'));
  } finally { good.close(); }
});

test('five-minute timer reads fresh success state and does not regenerate the same period', async () => {
  const ui = harness(autoFixture()); await ui.settle();
  try {
    ui.click('数据');
    const time = ui.nodes().find(n => n.type === 'input' && n.props.type === 'time' && n.props.value === '18:00');
    ui.fire(time, 'onChange', { target: { value: '12:00' } });
    const weekday = ui.nodes().find(n => n.type === 'select' && n.props.value === '5');
    assert.ok(weekday, 'weekday setting exists');
    ui.fire(weekday, 'onChange', { target: { value: '4' } });
    ui.click('未开启 · 点击开启'); await ui.settle();
    const request = ui.nextRequest('report');
    await ui.respond(request, { report: { body: '定时草稿' } });
    ui.timers.advance(5 * 60 * 1000); await ui.settle();
    assert.equal(ui.requests.filter(r => r.body.mode === 'report').length, 1, 'fresh success blocks duplicate model request');
  } finally { ui.close(); }
});

test('auto report response after workspace replacement cannot rewrite the replacement', async () => {
  const ui = harness(autoFixture()); await ui.settle();
  try {
    const request = await startAuto(ui);
    ui.click('覆盖');
    const replacement = state([task('replacement')]);
    const done = ui.import({ app: 'work-panel', schema: 1, version: '1.5.10', exportedAt: NOW_ISO, ...replacement });
    await done; await ui.settle();
    await ui.respond(request, { report: { body: '旧工作区自动结果' } });
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1')[0].id, 'replacement');
    assert.equal(ui.storage.json('@local/work-panel:reports:v1', []).length, 0);
    assert.ok(!ui.storage.json('@local/work-panel:workspace-extras:v1', {}).autoState?.lastRunOk);
  } finally { ui.close(); }
});

test('auto report result after the panel closes is not saved', async () => {
  const ui = harness(autoFixture()); await ui.settle();
  const request = await startAuto(ui);
  ui.close();
  request.respond({ report: { body: '关闭后的自动结果' } });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(ui.storage.json('@local/work-panel:reports:v1', []).length, 0);
});

test('timer uses schedule edits made after activation, not an old render closure', async () => {
  const ui = harness(autoFixture()); await ui.settle();
  try {
    ui.click('数据'); ui.click('未开启 · 点击开启'); await ui.settle();
    assert.equal(ui.requests.filter(r => r.body.mode === 'report').length, 0, 'Thursday is not default Friday schedule');
    const time = ui.nodes().find(n => n.type === 'input' && n.props.type === 'time' && n.props.value === '18:00');
    ui.fire(time, 'onChange', { target: { value: '12:00' } });
    const weekday = ui.nodes().find(n => n.type === 'select' && n.props.value === '5');
    ui.fire(weekday, 'onChange', { target: { value: '4' } }); await ui.settle();
    ui.timers.advance(5 * 60 * 1000); await ui.settle();
    const request = ui.nextRequest('report');
    assert.ok(request, 'the updated Thursday noon setting is used by the original timer');
    await ui.respond(request, { report: { body: '更新后的计划' } });
  } finally { ui.close(); }
});

test('a stale in-flight request does not block the new settings or release their lock', async () => {
  const ui = harness(autoFixture()); await ui.settle();
  try {
    const oldRequest = await startAuto(ui);
    const zone = ui.nodes().find(n => n.type === 'input' && n.props.value === 'Asia/Shanghai');
    ui.fire(zone, 'onChange', { target: { value: 'UTC' } }); await ui.settle();
    ui.button('立即生成一次').props.onClick(); await ui.settle();
    const newer = ui.nextRequest('report');
    assert.notEqual(newer, oldRequest, 'new settings can start while old network call remains pending');
    await ui.respond(oldRequest, { report: { body: '过时结果' } });
    assert.equal(ui.storage.json('@local/work-panel:reports:v1', []).length, 0, 'old request cannot write');
    await ui.respond(newer, { report: { body: '新设置结果' } });
    assert.equal(ui.storage.json('@local/work-panel:reports:v1')[0].body, '新设置结果');
  } finally { ui.close(); }
});

test('pausing in flight discards the pending auto result and errors', async () => {
  const ui = harness(autoFixture()); await ui.settle();
  try {
    const request = await startAuto(ui);
    ui.click('暂停'); await ui.settle();
    await ui.respond(request, { report: { body: '暂停前的报告' } });
    assert.equal(ui.storage.json('@local/work-panel:reports:v1', []).length, 0);
    assert.equal(ui.storage.json('@local/work-panel:workspace-extras:v1').autoState.paused, true);
    assert.ok(!ui.storage.json('@local/work-panel:workspace-extras:v1').autoState.lastRunOk);
  } finally { ui.close(); }
});

test('automatic status write failure rolls back draft, marker and success together', async () => {
  for (const key of ['@local/work-panel:report-edits:v1', '@local/work-panel:workspace-extras:v1']) {
    const ui = harness(autoFixture()); await ui.settle();
    try {
      const request = await startAuto(ui);
      ui.storage.fail('set', key);
      await ui.respond(request, { report: { body: '中途失败不能留草稿' } });
      assert.equal(ui.storage.json('@local/work-panel:reports:v1', []).length, 0, 'rolled back report when ' + key + ' failed');
      const extra = ui.storage.json('@local/work-panel:workspace-extras:v1');
      assert.notEqual(extra.autoState.lastRunOk, true, 'rolled back success marker');
      assert.deepEqual(Array.from(extra.autoState.generatedKeys || []), [], 'no generated key persisted');
    } finally { ui.close(); }
  }
});

test('failed activation is not queued for a later retry or reloaded as enabled', async () => {
  const ui = harness(autoFixture()); await ui.settle();
  try {
    ui.click('数据');
    ui.storage.fail('set', '@local/work-panel:workspace-extras:v1');
    ui.click('未开启 · 点击开启'); await ui.settle();
    assert.ok(ui.text().includes('未开启 · 点击开启'), 'UI did not accept failed switch');
    assert.equal(ui.storage.json('@local/work-panel:workspace-extras:v1', {}).autoSettings?.enabled, undefined);
    ui.close();
    const next = harness(autoFixture(), ui.storage); await next.settle();
    try { next.click('数据'); assert.ok(next.text().includes('未开启 · 点击开启')); }
    finally { next.close(); }
  } finally { ui.close(); }
});

test('quick add leaves deadline empty unless a date is explicitly chosen, including after reuse', async () => {
  const ui = harness(state()); await ui.settle();
  try {
    ui.change('wp-quick-input', '无期限任务'); ui.click('添加任务'); await ui.settle();
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1').find(t => t.title === '无期限任务').deadline, '');
    ui.click('选择日期 / 时间'); ui.click('今天'); ui.click('确定');
    ui.change('wp-quick-input', '显式今天'); ui.click('添加任务'); await ui.settle();
    assert.notEqual(ui.storage.json('@local/work-panel:tasks:v1').find(t => t.title === '显式今天').deadline, '');
    ui.change('wp-quick-input', '再次无期限'); ui.click('添加任务'); await ui.settle();
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1').find(t => t.title === '再次无期限').deadline, '');
    ui.click('选择日期 / 时间'); ui.click('今天'); ui.click('清除期限');
    ui.change('wp-quick-input', '清除期限任务'); ui.click('添加任务'); await ui.settle();
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1').find(t => t.title === '清除期限任务').deadline, '');
  } finally { ui.close(); }
});

test('untouched date has no selected day, and time selection after midnight uses the new day', async () => {
  const ui = harness(state()); await ui.settle();
  try {
    const initial = ui.byClass('wp-quick-cal');
    assert.ok(initial.children.some(n => n && n.type && n.type.name === 'CalDayIcon' && n.props.day === null),
      'empty deadline icon has no misleading day number');
    ui.timers.now = 24 * 60 * 60 * 1000;
    ui.click('选择日期 / 时间');
    assert.ok(!ui.nodes().some(n => has(n, 'wp-cal-day') && has(n, 'wp-selected')), 'opening the picker does not silently select today');
    const time = ui.nodes().find(n => n.type === 'select' && has(n, 'wp-cal-time-select'));
    assert.ok(time, 'date picker time input exists');
    ui.fire(time, 'onChange', { target: { value: '14:00' } }); ui.click('确定');
    ui.change('wp-quick-input', '过午夜的定时任务'); ui.click('添加任务'); await ui.settle();
    assert.equal(ui.storage.json('@local/work-panel:tasks:v1')[0].deadline, '2026-11-13T14:00',
      'time selection uses the new date, never the stale previous-day default');
  } finally { ui.timers.now = 0; ui.close(); }
});

test('dropped tasks are closed in filters, radar and project health, not completed', async () => {
  const tasks = [task('d', { projectId: 'p1', status: 'dropped', deadline: '2026-11-01', droppedAt: NOW_ISO }),
    task('c', { projectId: 'p1', status: 'done', deadline: '2026-11-01', completedAt: NOW_ISO }),
    task('o', { projectId: 'p1', status: 'todo', deadline: '2026-11-01' })];
  const ui = harness(state(tasks, { projects: [{ id: 'p1', name: '项目', status: 'active', createdAt: NOW_ISO, updatedAt: NOW_ISO }] }));
  await ui.settle();
  try {
    const nav = ui.nodes().find(n => n.type === 'button' && has(n, 'wp-nav-item') && text(n).includes('已完成/废弃'));
    assert.ok(nav && text(nav).includes('2'), 'closed view count includes one completed and one dropped');
    const overdueNav = ui.nodes().find(n => n.type === 'button' && has(n, 'wp-nav-item') && text(n).includes('已逾期'));
    assert.ok(overdueNav && text(overdueNav).includes('1'), 'only open task counts as overdue');
    gotoDone(ui); await ui.settle(); expandGroup(ui, '已完成/废弃');
    assert.ok(ui.text().includes('任务 d') && ui.text().includes('任务 c'), 'both live in the closed view');
    ui.click('项目'); await ui.settle();
    assert.ok(ui.text().includes('已废弃'), 'project health distinguishes dropped work');
  } finally { ui.close(); }
});

test('detail cross restores a dropped task rather than falsely completing it', async () => {
  const ui = harness(state([task('d', { status: 'dropped', droppedAt: NOW_ISO })])); await ui.settle();
  try {
    gotoDone(ui); await ui.settle(); expandGroup(ui, '已完成/废弃');
    const row = ui.nodes().find(n => has(n, 'wp-row') && text(n).includes('任务 d'));
    ui.fire(row, 'onClick');
    const check = ui.byClass('wp-detail-check');
    assert.ok(has(check, 'wp-check-dropped') && check.props['aria-checked'] === 'mixed', 'detail shows a cross');
    assert.ok(check.children.some(n => n && n.type && n.type.name === 'CrossIcon'), 'cross icon is rendered');
    assert.ok(ui.text().includes('恢复为待办'), 'detail has a discoverable recovery action');
    ui.fire(check, 'onClick'); await ui.settle();
    const stored = ui.storage.json('@local/work-panel:tasks:v1')[0];
    assert.equal(stored.status, 'todo'); assert.equal(stored.droppedAt, null); assert.equal(stored.completedAt, null);
  } finally { ui.close(); }
});

test('ignore-all requires a count-specific confirmation; cancel changes nothing', async () => {
  const receipts = [{ id: 'r1', text: '成果一' }, { id: 'r2', text: '成果二' }];
  const acks = [];
  const ui = harness(state(), undefined, { inboxItems: receipts, ackHook: (body) => { acks.push(body.ids); return { ok: true }; } });
  await ui.settle();
  try {
    ui.click('执行回传'); ui.click('全部忽略'); await ui.settle();
    assert.ok(ui.text().includes('忽略 2 条？不会采纳为记录，处理后不可恢复。'));
    assert.deepEqual(acks, []); assert.deepEqual(ui.storage.json('@local/work-panel:inbox-ack:v1', []), []);
    ui.click('取消'); assert.deepEqual(acks, []);
    ui.click('全部忽略'); ui.click('确认忽略'); await ui.settle();
    assert.equal(acks.length, 1); assert.deepEqual(acks[0].sort(), ['r1', 'r2']);
    assert.ok(ui.storage.json('@local/work-panel:inbox-ack:v1').includes('r1'));
  } finally { ui.close(); }
});

test('ignore-all cannot acknowledge receipts that arrived after confirmation', async () => {
  const receipts = [{ id: 'r1', text: '成果一' }, { id: 'r2', text: '成果二' }];
  const acks = [];
  const ui = harness(state(), undefined, { inboxItems: receipts, ackHook: (body) => { acks.push(body.ids); return { ok: true }; } });
  await ui.settle();
  try {
    ui.click('执行回传'); ui.click('全部忽略');
    ui.fire(ui.nodes().find(n => n.type === 'button' && text(n) === '忽略'), 'onClick'); await ui.settle();
    ui.click('确认忽略'); await ui.settle();
    assert.ok(ui.text().includes('收件箱已变化'));
    assert.ok(acks.every(ids => !ids.includes('r2')), 'r2 was not silently ignored');
  } finally { ui.close(); }
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
