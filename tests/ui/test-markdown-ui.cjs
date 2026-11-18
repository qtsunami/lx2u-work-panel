'use strict';
const assert = require('node:assert/strict');
const { harness, workspace, task, KEY, NOW } = require('../helpers/ui-harness.cjs');
const has = (node, cls) => String(node.props && node.props.className || '').split(/\s+/).includes(cls);
const text = (node) => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(text).join('') : '';
const MARKDOWN = [
  '# 标题一',
  '## 标题二',
  '### 标题三',
  '正文 **粗体** 与 *斜体* 以及 `代码`',
  '- 无序项',
  '- [x] 已完成项',
  '- [ ] 未完成项',
  '1. 有序一',
  '> 引用内容',
  '关联 [[task:b]] 与不安全 [坏链接](javascript:alert(1))',
].join('\n');
function state(description = MARKDOWN) {
  return workspace({
    tasks: [
      { ...task('a', 'p', '当前任务'), status: 'todo', progress: 0, completedAt: null, description, deadline: '', createdAt: NOW, updatedAt: NOW },
      { ...task('b', 'p', '历史任务'), status: 'todo', progress: 0, completedAt: null, description: '', deadline: '', createdAt: NOW, updatedAt: NOW },
    ],
  });
}
async function open(description = MARKDOWN) {
  const ui = harness(state(description)); await ui.settle();
  ui.fire(ui.one((node) => has(node, 'wp-row') && text(node).includes('当前任务'), 'current row'), 'onClick');
  return ui;
}
const blocks = (ui) => ui.nodes().filter((node) => has(node, 'wp-md-block') || has(node, 'wp-md-block-editing'));
const input = (ui) => ui.byClass('wp-md-block-input');
function focusBlock(ui, index) { ui.fire(blocks(ui)[index], 'onClick'); }
function type(ui, value, caret) {
  ui.fire(input(ui), 'onChange', { target: { value, selectionStart: caret, selectionEnd: caret } });
}
const stored = (ui) => ui.storage.json(KEY.tasks).find((item) => item.id === 'a').description;
const menuOpen = (ui) => ui.nodes().some((node) => has(node, 'wp-md-style-menu'));
const menuItems = (ui) => ui.nodes().filter((node) => has(node, 'wp-md-style-item'));
function chooseStyle(ui, label) {
  ui.fire(ui.one((node) => has(node, 'wp-md-style-item') && text(node).startsWith(label), label), 'onClick');
}
(async () => {
  {
    const ui = await open(); try {
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-block')).length, 10, 'one block per source line');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-block-heading1')), 'H1 renders as a heading block');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-block-heading2')), 'H2 renders');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-block-heading3')), 'H3 renders');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-block-quote')), 'quote renders');
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-check')).length, 2, 'two checkbox items');
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-check')).map((node) => node.props['aria-checked']).join(','), 'true,false');
      assert.ok(ui.nodes().some((node) => node.type === 'strong' && text(node) === '粗体'));
      assert.ok(ui.nodes().some((node) => node.type === 'em' && text(node) === '斜体'));
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-code') && text(node) === '代码'));
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-ref') && text(node) === '历史任务'));
      assert.equal(ui.nodes().filter((node) => node.type === 'a' && String(node.props.href).startsWith('javascript')).length, 0);
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-link-broken')));
      assert.ok(!text(ui.byClass('wp-md-blocks')).includes('## '), 'markers are hidden in rendered blocks');
      assert.equal(stored(ui), MARKDOWN, 'viewing never rewrites the source');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      focusBlock(ui, 1);
      assert.equal(input(ui).props.value, '## 标题二', 'the focused block shows its raw Markdown');
      assert.ok(has(input(ui), 'wp-md-size-h2'), 'the editor is styled as a heading immediately');
    } finally { ui.close(); }
  }
  {
    const ui = await open('普通文本'); try {
      focusBlock(ui, 0);
      type(ui, '## 新标题', 6);
      assert.ok(has(input(ui), 'wp-md-size-h2'), 'typing ## applies the heading style in place');
      assert.equal(stored(ui), '普通文本', 'saving is still debounced');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '## 新标题');
      ui.fire(input(ui), 'onBlur', {}); await ui.settle();
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-block-heading2')), 'blur renders the heading');
      assert.ok(!text(ui.byClass('wp-md-blocks')).includes('##'), 'markers disappear after blur');
    } finally { ui.close(); }
  }
  {
    const ui = await open('第一行'); try {
      focusBlock(ui, 0);
      type(ui, '第一行加长', 3);
      ui.fire(input(ui), 'onKeyDown', { key: 'Enter', isComposing: false, target: { value: '第一行加长', selectionStart: 3, selectionEnd: 3 } });
      await ui.settle();
      assert.equal(input(ui).props.value, '加长', 'focus moves to the new block');
      ui.fire(input(ui), 'onKeyDown', { key: 'Backspace', isComposing: false, target: { value: '加长', selectionStart: 0, selectionEnd: 0 } });
      await ui.settle();
      assert.equal(input(ui).props.value, '第一行加长', 'Backspace at the start merges the blocks again');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '第一行加长');
    } finally { ui.close(); }
  }
  {
    const ui = await open('待办'); try {
      focusBlock(ui, 0);
      ui.click('复选框'); await ui.settle();
      assert.equal(input(ui).props.value, '- [ ] 待办', 'the toolbar converts the focused block');
      ui.fire(input(ui), 'onBlur', {}); await ui.settle();
      ui.fire(ui.one((node) => has(node, 'wp-md-check'), 'checkbox'), 'onClick'); await ui.settle();
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '- [x] 待办', 'clicking the rendered checkbox rewrites the line');
    } finally { ui.close(); }
  }
  {
    const ui = await open('标题'); try {
      focusBlock(ui, 0);
      type(ui, '标题 /', 4);
      assert.ok(menuOpen(ui), 'typing / after a space opens the style menu');
      assert.equal(menuItems(ui).length, 8);
      chooseStyle(ui, '无序列表'); await ui.settle();
      assert.equal(input(ui).props.value, '- 标题', 'the trigger is replaced by the list marker');
      type(ui, '标题/内容', 4);
      assert.equal(menuOpen(ui), false, 'a slash inside a word never triggers');
    } finally { ui.close(); }
  }
  {
    const ui = await open('已有内容'); try {
      focusBlock(ui, 0);
      ui.click('关联任务'); await ui.settle();
      ui.fire(ui.one((node) => node.type === 'input' && String(node.props.placeholder).includes('搜索任务标题'), 'picker input'), 'onChange', { target: { value: '历史' } });
      ui.fire(ui.one((node) => has(node, 'wp-md-picker-item') && text(node) === '历史任务', 'picker item'), 'onClick'); await ui.settle();
      assert.equal(input(ui).props.value, '已有内容[[task:b]]', 'the reference is inserted into the focused block');
      ui.fire(input(ui), 'onBlur', {}); await ui.settle();
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-ref') && text(node) === '历史任务'));
    } finally { ui.close(); }
  }
  {
    const ui = await open('<img src=x onerror=alert(1)> 文本'); try {
      assert.equal(ui.nodes().filter((node) => node.type === 'img').length, 0, 'raw HTML never becomes an element');
      assert.ok(text(ui.byClass('wp-md-blocks')).includes('<img src=x onerror=alert(1)>'));
    } finally { ui.close(); }
  }
  {
    const ui = await open('[[task:missing]]'); try {
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-ref-broken') && text(node) === '任务已失效'));
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-row-desc')).length, 0, 'a marker-only description stays out of the row summary');
    } finally { ui.close(); }
  }
  {
    const ui = await open(''); try {
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-placeholder')), 'an empty description offers a click target');
      focusBlock(ui, 0);
      type(ui, '新内容', 3);
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '新内容');
    } finally { ui.close(); }
  }
  {
    const ui = await open(''); try {
      focusBlock(ui, 0);
      type(ui, '甲\n乙\n丙', 5);
      await ui.settle();
      assert.equal(input(ui).props.value, '丙', 'pasting several lines focuses the last new block');
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-block') || has(node, 'wp-md-block-editing')).length, 3);
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '甲\n乙\n丙');
    } finally { ui.close(); }
  }
  {
    const ui = await open('第一段\n\n第二段'); try {
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-placeholder')).length, 0, 'blank lines are spacers, not repeated placeholders');
      const container = ui.byClass('wp-md-blocks');
      assert.equal(container.props.role, 'group');
      assert.equal(container.props.tabIndex, 0, 'the description is keyboard reachable');
      const first = blocks(ui)[0];
      assert.equal(first.props.tabIndex, 0, 'rendered blocks can be focused');
    } finally { ui.close(); }
  }
  {
    const ui = await open('[文档](https://example.com)'); try {
      ui.fire(ui.one((node) => node.type === 'a', 'link'), 'onClick', { stopPropagation: () => {} });
      await ui.settle();
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-block-input')).length, 0, 'following a link does not enter edit mode');
    } finally { ui.close(); }
  }
  {
    const ui = await open('甲乙丙'); try {
      ui.fire(ui.one((node) => has(node, 'wp-md-block')), 'onClick');
      const input = ui.byClass('wp-md-block-input');
      input.props.ref.current.selectionStart = 1; input.props.ref.current.selectionEnd = 1;
      ui.click('关联任务'); await ui.settle();
      ui.fire(ui.one((node) => has(node, 'wp-md-picker-item') && text(node) === '历史任务', 'picker item'), 'onClick'); await ui.settle();
      assert.equal(ui.byClass('wp-md-block-input').props.value, '甲[[task:b]]乙丙', 'the reference is inserted at the caret');
    } finally { ui.close(); }
  }
  console.log('MARKDOWN UI: 15 block-editor scenarios passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
