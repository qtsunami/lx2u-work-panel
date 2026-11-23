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
function type(ui, value, caret, extra = {}) {
  ui.fire(input(ui), 'onChange', { target: { value, selectionStart: caret, selectionEnd: caret }, ...extra });
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
      ui.fire(ui.byClass('wp-md-block-editing'), 'onBlur', {}); await ui.settle();
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
      type(ui, '待办 /', 4);
      chooseStyle(ui, '复选框'); await ui.settle();
      assert.equal(input(ui).props.value, '待办', 'the style menu keeps only the task body in the textarea');
      assert.equal(ui.byClass('wp-md-check').props['aria-checked'], 'false', 'the active task has a live checkbox');
      ui.fire(ui.byClass('wp-md-block-editing'), 'onBlur', {}); await ui.settle();
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
      assert.equal(input(ui).props.value, '标题', 'the trigger is removed and the list marker is outside the textarea');
      assert.equal(text(ui.byClass('wp-md-marker')), '•');
      type(ui, '标题/内容', 4);
      assert.equal(menuOpen(ui), false, 'a slash inside a word never triggers');
    } finally { ui.close(); }
  }
  {
    const ui = await open('已有内容'); try {
      focusBlock(ui, 0);
      type(ui, '已有内容 /', 6);
      chooseStyle(ui, '关联任务'); await ui.settle();
      ui.fire(ui.one((node) => node.type === 'input' && String(node.props.placeholder).includes('搜索任务标题'), 'picker input'), 'onChange', { target: { value: '历史' } });
      ui.fire(ui.one((node) => has(node, 'wp-md-picker-item') && text(node) === '历史任务', 'picker item'), 'onClick'); await ui.settle();
      assert.equal(input(ui).props.value, '已有内容[[task:b]]', 'the reference is inserted into the focused block');
      ui.fire(ui.byClass('wp-md-block-editing'), 'onBlur', {}); await ui.settle();
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
      type(ui, '甲 /乙丙', 3);
      assert.ok(menuOpen(ui), 'a trigger inserted at the caret opens the style menu');
      chooseStyle(ui, '关联任务'); await ui.settle();
      ui.fire(ui.one((node) => has(node, 'wp-md-picker-item') && text(node) === '历史任务', 'picker item'), 'onClick'); await ui.settle();
      assert.equal(ui.byClass('wp-md-block-input').props.value, '甲[[task:b]]乙丙', 'the reference is inserted at the caret');
    } finally { ui.close(); }
  }
  {
    const ui = await open(''); try {
      focusBlock(ui, 0);
      type(ui, '-', 1);
      assert.equal(input(ui).props.value, '-', 'a bare hyphen is still plain text');
      assert.ok(has(input(ui), 'wp-md-size-paragraph'));
      type(ui, '- ', 2);
      assert.equal(input(ui).props.value, '', 'space converts the hyphen to a body-only bullet live');
      assert.equal(text(ui.byClass('wp-md-marker')), '•');
      assert.equal(input(ui).props.ref.current.selectionStart, 0, 'conversion restores the DOM caret at body start');
      type(ui, '[ ]', 3);
      assert.equal(input(ui).props.value, '[ ]', 'without a trailing space the checkbox syntax stays in the bullet body');
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-check')).length, 0);
      type(ui, '[ ] ', 4);
      assert.equal(input(ui).props.value, '', 'a trailing space converts the bullet to a live task');
      assert.equal(ui.byClass('wp-md-check').props['aria-checked'], 'false');
      assert.equal(input(ui).props.ref.current.selectionStart, 0);
      type(ui, '执行任务', 4);
      ui.fire(ui.byClass('wp-md-check'), 'onMouseDown');
      ui.fire(ui.byClass('wp-md-check'), 'onClick');
      assert.equal(input(ui).props.value, '执行任务', 'toggling the active checkbox preserves body and edit mode');
      assert.equal(ui.byClass('wp-md-check').props['aria-checked'], 'true');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '- [x] 执行任务', 'typing and toggling persist exactly one Markdown prefix');
      type(ui, '执行任务！', 5);
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '- [x] 执行任务！', 'subsequent body input preserves the checked state');
      ui.fire(input(ui), 'onKeyDown', { key: 'Enter', target: { value: '执行任务！', selectionStart: 5, selectionEnd: 5 } });
      assert.equal(input(ui).props.value, '', 'Enter focuses the next task body');
      assert.equal(input(ui).props.ref.current.selectionStart, 0);
      assert.deepEqual(ui.nodes().filter((node) => has(node, 'wp-md-check')).map((node) => node.props['aria-checked']), ['true', 'false'], 'continued tasks start unchecked');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '- [x] 执行任务！\n- [ ] ');
      ui.fire(input(ui), 'onKeyDown', { key: 'Enter', target: { value: '', selectionStart: 0, selectionEnd: 0 } });
      assert.ok(has(input(ui), 'wp-md-size-paragraph'), 'Enter in an empty task exits the structure');
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-check')).length, 1);
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '- [x] 执行任务！\n\n', 'exiting removes the empty task marker');
    } finally { ui.close(); }
  }
  for (const source of ['- 甲乙丙', '2. 甲乙丙', '- [x] 甲乙丙', '> 甲乙丙']) {
    const ui = await open(source); try {
      focusBlock(ui, 0);
      assert.equal(input(ui).props.value, '甲乙丙', 'items and quotes expose only their body: ' + source);
      assert.equal(input(ui).props.ref.current.selectionStart, 3, 'focus maps source end to body end');
      ui.fire(input(ui), 'onKeyDown', { key: 'Enter', target: { value: '甲乙丙', selectionStart: 1, selectionEnd: 2 } });
      assert.equal(input(ui).props.value, '丙', 'Enter uses body selection offsets and removes the selected text');
      assert.equal(input(ui).props.ref.current.selectionStart, 0, 'continued structure starts at body offset zero');
      ui.fire(input(ui), 'onKeyDown', { key: 'Backspace', target: { value: '丙', selectionStart: 0, selectionEnd: 0 } });
      assert.ok(has(input(ui), 'wp-md-size-paragraph'), 'Backspace at body start removes structure rather than merging');
      assert.equal(blocks(ui).length, 2);
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), source.slice(0, -3) + '甲\n丙');
    } finally { ui.close(); }
  }
  for (const level of [1, 2, 3]) {
    const ui = await open(''); try {
      focusBlock(ui, 0);
      const prefix = '#'.repeat(level) + ' ';
      type(ui, prefix + '标题', prefix.length + 2);
      assert.equal(input(ui).props.value, prefix + '标题', 'focused headings retain their marks');
      assert.ok(has(input(ui), 'wp-md-size-h' + level), 'heading typography applies immediately');
      type(ui, prefix + '标题续', prefix.length + 3);
      assert.equal(input(ui).props.value, prefix + '标题续', 'continued typing does not hide heading marks');
      ui.fire(input(ui), 'onKeyDown', { key: 'Enter', target: { value: prefix + '标题续', selectionStart: prefix.length + 3, selectionEnd: prefix.length + 3 } });
      assert.equal(input(ui).props.value, '', 'heading Enter focuses a plain paragraph');
      assert.ok(has(input(ui), 'wp-md-size-paragraph'));
      assert.equal(text(ui.byClass('wp-md-block-heading' + level)), '标题续', 'newline renders the previous heading without marks');
      focusBlock(ui, 0);
      assert.equal(input(ui).props.value, prefix + '标题续', 'refocusing restores the heading marks');
      ui.fire(ui.byClass('wp-md-block-editing'), 'onBlur');
      assert.equal(text(ui.byClass('wp-md-block-heading' + level)), '标题续', 'blur hides marks for every heading level');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), prefix + '标题续\n');
    } finally { ui.close(); }
  }
  for (const source of ['- 甲乙丙', '- [ ] 甲乙丙', '  - [x] 甲乙丙', '> 甲乙丙']) {
    const ui = await open(source); try {
      focusBlock(ui, 0);
      type(ui, '甲 、乙丙', 3);
      assert.ok(menuOpen(ui), 'the 、 trigger works at a body caret inside structured blocks');
      chooseStyle(ui, '关联任务');
      ui.fire(ui.one((node) => has(node, 'wp-md-picker-item') && text(node) === '历史任务', 'picker item'), 'onClick');
      assert.equal(input(ui).props.value, '甲[[task:b]]乙丙', 'task references use body caret coordinates');
      assert.equal(input(ui).props.ref.current.selectionStart, '甲[[task:b]]'.length, 'inserted reference maps source caret back to body');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), source.slice(0, -3) + '甲[[task:b]]乙丙', 'reference insertion preserves prefix and indentation');
    } finally { ui.close(); }
  }
  {
    const ui = await open('  - [ ] 原文'); try {
      focusBlock(ui, 0);
      assert.equal(ui.byClass('wp-md-edit-row').props.style.paddingLeft, '14px', 'indentation is rendered outside the textarea');
      const pasted = '甲\n- [x] 乙\n> 丙';
      type(ui, pasted, pasted.length, { nativeEvent: { inputType: 'insertFromPaste' } });
      assert.equal(input(ui).props.value, '丙', 'multiline paste focuses the final body-only quote');
      assert.ok(has(input(ui), 'wp-md-size-quote'));
      assert.equal(input(ui).props.ref.current.selectionStart, 1, 'pasted final marker is excluded from the DOM caret');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '  - [ ] 甲\n- [x] 乙\n> 丙', 'paste preserves original indentation and adds its prefix only to the first line');
    } finally { ui.close(); }
  }
  {
    const ui = await open('- [ ] 甲乙\n尾段'); try {
      focusBlock(ui, 0);
      const container = ui.byClass('wp-md-blocks');
      const target = { value: '甲乙', selectionStart: 1, selectionEnd: 1 };
      ui.fire(input(ui), 'onKeyDown', { key: 'Enter', target });
      assert.equal(input(ui).props.value, '乙');
      ui.fire(container, 'onKeyDown', { key: 'Enter', target, currentTarget: container });
      assert.equal(input(ui).props.value, '乙', 'bubbled textarea Enter must not move focus to the final block');
      assert.equal(input(ui).props.ref.current.selectionStart, 0);
      ui.fire(ui.byClass('wp-md-blocks'), 'onKeyDown', { key: 'Enter', target: container, currentTarget: container });
      assert.equal(input(ui).props.value, '尾段', 'direct container Enter still activates the final block');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '- [ ] 甲\n- [ ] 乙\n尾段', 'bubbling does not split or rewrite any extra block');
    } finally { ui.close(); }
  }
  {
    const ui = await open('- [ ] 正文'); try {
      focusBlock(ui, 0);
      const checkbox = ui.byClass('wp-md-check');
      ui.fire(ui.byClass('wp-md-block-editing'), 'onBlur', {
        relatedTarget: checkbox, currentTarget: { contains: (target) => target === checkbox },
      });
      assert.equal(input(ui).props.value, '正文', 'moving focus to the active checkbox keeps the editing wrapper mounted');
      ui.fire(ui.byClass('wp-md-check'), 'onClick');
      assert.equal(input(ui).props.value, '正文', 'keyboard checkbox activation preserves body-only editing');
      assert.equal(ui.byClass('wp-md-check').props['aria-checked'], 'true');
      ui.fire(ui.byClass('wp-md-block-editing'), 'onBlur', {
        relatedTarget: {}, currentTarget: { contains: () => false },
      });
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-block-input')).length, 0, 'focus leaving the whole wrapper exits editing');
      assert.equal(text(ui.byClass('wp-md-item-text')), '正文');
      ui.timers.advance(600); await ui.settle();
      assert.equal(stored(ui), '- [x] 正文');
    } finally { ui.close(); }
  }
  console.log('MARKDOWN UI: render, body-only input, progressive task, heading lifecycle, caret/ref, paste, Enter bubbling and wrapper focus scenarios passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
