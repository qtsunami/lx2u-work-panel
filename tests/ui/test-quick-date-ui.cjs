'use strict';
const assert = require('node:assert/strict');
const { harness } = require('../helpers/ui-harness.cjs');
const KEY = '@local/work-panel:tasks:v1';
const initial = () => ({ tasks: [], projects: [], logs: [], artifacts: [], reports: [], inboxAck: [], reportEdits: {} });
const cls = (node, value) => String(node.props?.className || '').split(/\s+/).includes(value);
const text = node => typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(text).join('') : '';
const tests = [];
const test = (name, run) => tests.push({ name, run });
async function open() { const ui = harness(initial()); await ui.settle(); return ui; }
const marks = ui => ui.nodes().filter(n => n.type === 'mark' && cls(n, 'wp-quick-date-mark'));
test('first text date updates picker and exactly one word is highlighted', async () => {
  const ui = await open(); try {
    ui.change('wp-quick-input', '明天写方案，后天评审');
    assert.deepEqual(marks(ui).map(text), ['明天']);
    assert.ok(ui.text().includes('2026-11-13'));
    ui.click('选择日期 / 时间');
    const selected = ui.nodes().find(n => cls(n, 'wp-cal-day') && cls(n, 'wp-selected'));
    assert.equal(text(selected), '13'); ui.click('确定');
    ui.click('添加任务'); await ui.settle();
    assert.equal(ui.storage.json(KEY)[0].deadline, '2026-11-13');
    assert.equal(ui.storage.json(KEY)[0].title, '明天写方案，后天评审');
    assert.equal(marks(ui).length, 0); assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
});
test('weekdays are natural-week based and earlier weekday beats later relative token', async () => {
  const ui = await open(); try {
    ui.change('wp-quick-input', '本周一整理，明天复查');
    assert.deepEqual(marks(ui).map(text), ['本周一']);
    ui.click('添加任务'); await ui.settle(); assert.equal(ui.storage.json(KEY)[0].deadline, '2026-11-09');
    ui.change('wp-quick-input', '下周五提交'); ui.click('添加任务'); await ui.settle();
    assert.equal(ui.storage.json(KEY).find(t => t.title === '下周五提交').deadline, '2026-11-20');
  } finally { ui.close(); }
});
test('deleting or replacing first date updates or clears only the inferred deadline', async () => {
  const ui = await open(); try {
    ui.change('wp-quick-input', '昨天整理，后天提交');
    ui.change('wp-quick-input', '整理，后天提交'); assert.deepEqual(marks(ui).map(text), ['后天']);
    ui.change('wp-quick-input', '整理并提交'); assert.equal(marks(ui).length, 0);
    ui.click('添加任务'); await ui.settle(); assert.equal(ui.storage.json(KEY)[0].deadline, '');
  } finally { ui.close(); }
});
test('manual calendar selection and clear win until date expression changes', async () => {
  const ui = await open(); try {
    ui.change('wp-quick-input', '明天整理'); ui.click('选择日期 / 时间'); ui.click('今天'); ui.click('确定');
    ui.change('wp-quick-input', '明天整理新方案'); ui.click('添加任务'); await ui.settle();
    assert.equal(ui.storage.json(KEY)[0].deadline, '2026-11-12');
    ui.change('wp-quick-input', '明天整理'); ui.click('选择日期 / 时间'); ui.click('清除期限');
    ui.change('wp-quick-input', '明天整理新方案'); ui.click('添加任务'); await ui.settle();
    assert.equal(ui.storage.json(KEY)[0].deadline, '');
    ui.change('wp-quick-input', '明天整理'); ui.click('选择日期 / 时间'); ui.click('今天'); ui.click('确定');
    ui.change('wp-quick-input', '大后天整理'); ui.click('添加任务'); await ui.settle();
    assert.equal(ui.storage.json(KEY).find(t => t.title === '大后天整理').deadline, '2026-11-15');
  } finally { ui.close(); }
});
test('IME composition only updates date when committed and does not submit', async () => {
  const ui = await open(); try {
    ui.fire(ui.byClass('wp-quick-input'), 'onCompositionStart'); ui.change('wp-quick-input', '明天写方案');
    assert.equal(text(ui.byClass('wp-quick-cal')), '截止时间');
    ui.fire(ui.byClass('wp-quick-input'), 'onKeyDown', { key: 'Enter', isComposing: true });
    assert.equal(ui.storage.json(KEY).length, 0);
    ui.fire(ui.byClass('wp-quick-input'), 'onCompositionEnd', { target: { value: '明天写方案' } });
    ui.click('添加任务'); await ui.settle(); assert.equal(ui.storage.json(KEY)[0].deadline, '2026-11-13');
  } finally { ui.close(); }
});
test('crossing midnight never silently changes the displayed inferred deadline', async () => {
  const ui = await open(); try {
    ui.change('wp-quick-input', '明天写方案');
    ui.timers.now = 24 * 60 * 60 * 1000;
    ui.change('wp-quick-input', '明天写新方案');
    ui.click('添加任务'); await ui.settle();
    assert.equal(ui.storage.json(KEY)[0].deadline, '2026-11-13');
  } finally { ui.timers.now = 0; ui.close(); }
});
test('highlight mirrors horizontal scrolling and uses text nodes rather than HTML', async () => {
  const ui = await open(); try {
    ui.change('wp-quick-input', '<img onerror=alert(1)>明天');
    const node = ui.byClass('wp-quick-input');
    ui.fire(node, 'onScroll', { target: { scrollLeft: 80 } });
    const mirror = ui.byClass('wp-quick-highlight'); assert.equal(mirror.props['aria-hidden'], true);
    assert.equal(mirror.props.ref.current.scrollLeft, 80, 'native input scroll is mirrored');
    assert.equal(marks(ui).length, 1); assert.equal(text(marks(ui)[0]), '明天');
    assert.ok(!ui.nodes().some(n => n.type === 'img'));
  } finally { ui.close(); }
});
(async () => {
  let failed = 0;
  for (const { name, run } of tests) { try { await run(); console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } }
  console.log(`QUICK DATE UI: ${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
