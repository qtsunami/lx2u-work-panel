'use strict';
const assert = require('node:assert/strict');
const { harness, workspace, task, KEY, NOW } = require('../helpers/ui-harness.cjs');
const has = (node, cls) => String(node.props && node.props.className || '').split(/\s+/).includes(cls);
const text = (node) => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(text).join('') : '';
function state(description = '') {
  return workspace({
    tasks: [
      { ...task('a', 'p', '当前任务'), status: 'todo', progress: 0, completedAt: null, description, deadline: '', createdAt: NOW, updatedAt: NOW },
      { ...task('b', 'p', '历史任务'), status: 'todo', progress: 0, completedAt: null, description: '', deadline: '', createdAt: NOW, updatedAt: NOW },
    ],
  });
}
async function open(description = '') {
  const ui = harness(state(description)); await ui.settle();
  ui.fire(ui.one((node) => has(node, 'wp-row') && text(node).includes('当前任务'), 'row'), 'onClick');
  ui.fire(ui.one((node) => has(node, 'wp-md-block'), 'first block'), 'onClick');
  return ui;
}
const editor = (ui) => ui.byClass('wp-md-block-input');
function type(ui, value, caret, extra = {}) {
  ui.fire(editor(ui), 'onChange', { target: { value, selectionStart: caret, selectionEnd: caret }, ...extra });
}
const menuOpen = (ui) => ui.nodes().some((node) => has(node, 'wp-md-style-menu'));
const menuItems = (ui) => ui.nodes().filter((node) => has(node, 'wp-md-style-item'));
function chooseStyle(ui, label) {
  ui.fire(ui.one((node) => has(node, 'wp-md-style-item') && text(node).startsWith(label), 'style ' + label), 'onClick');
}
const openTab = (ui, label) => ui.fire(ui.one((node) => has(node, 'wp-detail-tab') && text(node) === label, label + ' tab'), 'onClick');
const stored = (ui) => ui.storage.json(KEY.tasks).find((item) => item.id === 'a').description;
(async () => {
  {
    const ui = await open(); try {
      type(ui, '标题 /', 4);
      assert.ok(menuOpen(ui), 'typing / after a space opens the style menu');
      assert.equal(menuItems(ui).length, 8, 'all style choices are offered');
      assert.equal(menuItems(ui)[0].props['aria-selected'], 'true', 'the first item is active for keyboard use');
      chooseStyle(ui, '无序列表'); await ui.settle();
      assert.equal(editor(ui).props.value, '- 标题', 'the trigger and its space are replaced by the list marker');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '- 标题');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      type(ui, '、列表', 1);
      assert.ok(menuOpen(ui), 'a line-start 、 also opens the menu');
      chooseStyle(ui, '二级标题'); await ui.settle();
      assert.equal(editor(ui).props.value, '## 列表');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      type(ui, '11/18', 5);
      assert.equal(menuOpen(ui), false, 'a slash inside a date must not open the menu');
      type(ui, '标题/内容', 4);
      assert.equal(menuOpen(ui), false, 'a slash mid-word must not open the menu');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      type(ui, '标题 /', 4);
      ui.fire(editor(ui), 'onKeyDown', { key: 'Escape', isComposing: false, preventDefault() {} });
      assert.equal(menuOpen(ui), false, 'Escape closes the menu');
      assert.equal(editor(ui).props.value, '标题 /', 'Escape leaves the typed text untouched');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      type(ui, '/', 1);
      ui.fire(editor(ui), 'onKeyDown', { key: 'ArrowDown', isComposing: false, preventDefault() {} });
      const active = menuItems(ui).findIndex((node) => node.props['aria-selected'] === 'true');
      assert.equal(active, 1, 'ArrowDown moves the active item');
      ui.fire(editor(ui), 'onKeyDown', { key: 'Enter', isComposing: false, preventDefault() {} });
      await ui.settle();
      assert.equal(editor(ui).props.value, '## ', 'Enter applies the active style');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      type(ui, '标题 /', 4, { nativeEvent: { isComposing: true } });
      assert.equal(menuOpen(ui), false, 'an IME composition never opens the menu');
      ui.fire(editor(ui), 'onCompositionStart');
      type(ui, '标题 /', 4);
      assert.equal(menuOpen(ui), false, 'the composing state suppresses the trigger');
      ui.fire(editor(ui), 'onCompositionEnd', { target: { value: '标题 /', selectionStart: 4 } });
      assert.ok(menuOpen(ui), 'the committed punctuation is detected after composition');
    } finally { ui.close(); }
  }
  {
    const ui = await open('标题 /abc'); try {
      type(ui, '标题 /', 4);
      assert.equal(menuOpen(ui), false, 'deleting text never opens the menu');
      type(ui, '见附件 /', 5, { nativeEvent: { inputType: 'insertFromPaste' } });
      assert.equal(menuOpen(ui), false, 'pasting text never opens the menu');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      type(ui, '标题 /', 4);
      assert.ok(menuOpen(ui));
      ui.click('H1'); await ui.settle();
      assert.equal(menuOpen(ui), false, 'a toolbar command closes the stale menu');
      assert.equal(editor(ui).props.value, '# 标题 /', 'the trigger text is preserved when the toolbar is used');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      type(ui, '标题 /', 4);
      assert.ok(menuOpen(ui));
      openTab(ui, '记录');
      assert.equal(menuOpen(ui), false, 'switching tabs closes the menu');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      type(ui, '关联 /', 4);
      chooseStyle(ui, '关联任务'); await ui.settle();
      assert.ok(ui.nodes().some((node) => node.type === 'input' && String(node.props.placeholder).includes('搜索任务标题')));
      const names = ui.nodes().filter((node) => has(node, 'wp-md-picker-item')).map(text);
      assert.ok(!names.includes('当前任务'), 'the picker never offers the current task');
      ui.fire(ui.one((node) => has(node, 'wp-md-picker-item') && text(node) === '历史任务', 'picker item'), 'onClick'); await ui.settle();
      assert.equal(editor(ui).props.value, '关联[[task:b]]', 'the trigger is replaced by the chosen task reference');
    } finally { ui.close(); }
  }
  console.log('STYLE MENU UI: 10 block-editor scenarios passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
