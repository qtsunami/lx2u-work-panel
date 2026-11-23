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
      assert.equal(editor(ui).props.value, '标题', 'the trigger and its space disappear from the body-only textarea');
      assert.equal(text(ui.byClass('wp-md-marker')), '•', 'the list marker renders beside the editor');
      assert.equal(editor(ui).props.ref.current.selectionStart, 0, 'the source marker offset maps to body start');
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
      chooseStyle(ui, '一级标题'); await ui.settle();
      assert.equal(menuOpen(ui), false, 'applying a heading dismisses the menu');
      assert.equal(editor(ui).props.value, '# 标题', 'the heading command consumes the trigger rather than persisting it');
      assert.ok(has(editor(ui), 'wp-md-size-h1'), 'the menu applies H1 typography in place');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '# 标题', 'the menu heading persists without punctuation');
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
  for (const source of ['- 甲乙', '3. 甲乙', '- [x] 甲乙', '> 甲乙', '  - [ ] 甲乙']) {
    const ui = await open(source); try {
      assert.equal(editor(ui).props.value, '甲乙', 'the focused item or quote begins body-only');
      type(ui, '甲 /乙', 3);
      assert.ok(menuOpen(ui), 'a body caret opens the menu at the corresponding source offset');
      chooseStyle(ui, '三级标题');
      const indent = source.startsWith('  ') ? '  ' : '';
      assert.equal(editor(ui).props.value, indent + '### 甲乙', 'style conversion removes the body trigger, not a prefix character');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), indent + '### 甲乙', 'menu conversion does not stack structural markers');
    } finally { ui.close(); }
  }
  for (const source of ['- 甲乙', '- [ ] 甲乙', '  - [x] 甲乙', '> 甲乙']) {
    const ui = await open(source); try {
      type(ui, '甲 /乙', 3);
      chooseStyle(ui, '关联任务');
      ui.fire(ui.one((node) => has(node, 'wp-md-picker-item') && text(node) === '历史任务', 'picker item'), 'onClick');
      assert.equal(editor(ui).props.value, '甲[[task:b]]乙', 'menu reference replaces the trigger at the body caret');
      assert.equal(editor(ui).props.ref.current.selectionStart, '甲[[task:b]]'.length, 'reference caret excludes hidden structural markers');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), source.slice(0, -2) + '甲[[task:b]]乙', 'menu reference retains the original structure and checked state');
    } finally { ui.close(); }
  }
  for (const [label, prefix, marker] of [['无序列表', '- ', '•'], ['有序列表', '1. ', '1.'], ['复选框', '- [ ] ', null], ['引用', '> ', null]]) {
    const ui = await open('正文'); try {
      type(ui, '正文 /', 4);
      chooseStyle(ui, label);
      assert.equal(editor(ui).props.value, '正文', 'all non-heading menu styles expose only the body');
      assert.equal(editor(ui).props.ref.current.selectionStart, 0, 'style application maps the caret to body start');
      if (marker) assert.equal(text(ui.byClass('wp-md-marker')), marker);
      if (label === '复选框') assert.equal(ui.byClass('wp-md-check').props['aria-checked'], 'false');
      if (label === '引用') assert.ok(has(editor(ui), 'wp-md-size-quote'));
      type(ui, '新正文', 3);
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), prefix + '新正文', 'editing after style application preserves exactly one prefix');
    } finally { ui.close(); }
  }
  {
    const ui = await open('- [ ] 正文'); try {
      ui.fire(editor(ui), 'onCompositionStart');
      type(ui, '正文 /', 4);
      assert.equal(menuOpen(ui), false, 'body-only IME input suppresses the menu until committed');
      ui.fire(editor(ui), 'onCompositionEnd', { target: { value: '正文 /', selectionStart: 4 } });
      assert.ok(menuOpen(ui), 'composition commit maps the body caret to the task source');
      chooseStyle(ui, '引用');
      assert.equal(editor(ui).props.value, '正文');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '> 正文');
    } finally { ui.close(); }
  }
  for (const prefix of ['- ', '- [ ] ', '1. ', '  - [x] ', '> ', '# ', '## ', '### ']) {
    const ui = await open(prefix); try {
      const heading = prefix.startsWith('#');
      const value = heading ? prefix + '/' : '/';
      type(ui, value, value.length);
      assert.ok(menuOpen(ui), 'body-start slash opens a menu without exposing item markers');
      chooseStyle(ui, '关联任务');
      assert.equal(editor(ui).props.value, heading ? prefix : '', 'removing a body-start trigger preserves the structural separator');
      ui.fire(ui.one((node) => has(node, 'wp-md-picker-item') && text(node) === '历史任务', 'picker item'), 'onClick');
      assert.equal(editor(ui).props.value, (heading ? prefix : '') + '[[task:b]]', 'reference is inserted after the whole structural marker');
      assert.equal(editor(ui).props.ref.current.selectionStart, (heading ? prefix.length : 0) + '[[task:b]]'.length);
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), prefix + '[[task:b]]', 'body-start reference retains the original Markdown structure: ' + prefix);
    } finally { ui.close(); }
  }
  console.log('STYLE MENU UI: triggers, body-only conversions, item/quote caret mapping, references and IME scenarios passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
