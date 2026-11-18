'use strict';
const assert = require('node:assert/strict');
const { harness, workspace, task, KEY, NOW } = require('../helpers/ui-harness.cjs');
const has = (node, cls) => String(node.props && node.props.className || '').split(/\s+/).includes(cls);
const text = (node) => typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(text).join('') : '';
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
  const row = ui.one((node) => has(node, 'wp-row') && text(node).includes('当前任务'), 'current row');
  ui.fire(row, 'onClick');
  return ui;
}
const stored = (ui) => ui.storage.json(KEY.tasks).find((item) => item.id === 'a').description;
(async () => {
  {
    const ui = await open(); try {
      const editor = ui.byClass('wp-detail-desc-input');
      assert.equal(editor.props.value, MARKDOWN, 'edit mode shows the raw Markdown');
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-p')).length, 0, 'no preview while editing');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-tool')), 'toolbar exists');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      ui.click('预览');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-h1')), 'h1 renders');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-h2')), 'h2 renders');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-h3')), 'h3 renders');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-quote')), 'quote renders');
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-check')).length, 2, 'two checkbox items');
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-check')).map((node) => node.props['aria-checked']).join(','), 'true,false', 'checked state is preserved');
      assert.ok(ui.nodes().some((node) => node.type === 'strong' && text(node) === '粗体'));
      assert.ok(ui.nodes().some((node) => node.type === 'em' && text(node) === '斜体'));
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-code') && text(node) === '代码'));
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-ref') && text(node) === '历史任务'), 'task ref resolves to its title');
      assert.equal(ui.nodes().filter((node) => node.type === 'a' && String(node.props.href).startsWith('javascript')).length, 0, 'unsafe link never becomes an anchor');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-link-broken')), 'unsafe link stays plain text');
      assert.equal(stored(ui), MARKDOWN, 'previewing never rewrites the text');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      ui.click('预览');
      const checks = ui.nodes().filter((node) => has(node, 'wp-md-check'));
      ui.fire(checks[1], 'onClick'); await ui.settle();
      const next = stored(ui);
      assert.ok(next.includes('- [x] 未完成项'), 'unchecked item becomes checked');
      assert.ok(next.includes('- [x] 已完成项'), 'other checkbox item is untouched');
      assert.ok(next.includes('# 标题一') && next.includes('> 引用内容'), 'non-checkbox lines are preserved');
      // Persisted through the normal debounce path, so the host sees the toggle too.
      ui.timers.advance(600); await ui.settle();
      assert.ok(ui.server.workspace.tasks.find((item) => item.id === 'a').description.includes('- [x] 未完成项'));
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      const editor = ui.byClass('wp-detail-desc-input');
      editor.props.ref.current.selectionStart = 0; editor.props.ref.current.selectionEnd = 0;
      ui.click('H2'); await ui.settle();
      assert.equal(editor.props.ref.current.selectionStart, 3, 'caret is moved past the inserted prefix');
      ui.timers.advance(600); await ui.settle();
      assert.ok(stored(ui).startsWith('## 标题一'), 'heading level is replaced, not stacked');
      ui.timers.advance(0);
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      const editor = ui.byClass('wp-detail-desc-input');
      editor.props.ref.current.selectionStart = MARKDOWN.length;
      editor.props.ref.current.selectionEnd = MARKDOWN.length;
      ui.click('关联任务');
      const input = ui.one((node) => node.type === 'input' && String(node.props.placeholder).includes('搜索任务标题'));
      ui.fire(input, 'onChange', { target: { value: '历史' } });
      ui.click('历史任务'); await ui.settle();
      ui.click('预览'); await ui.settle();
      assert.ok(stored(ui).trim().endsWith('[[task:b]]'), 'marker inserted at the caret');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-ref') && text(node) === '历史任务'));
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      const summary = ui.byClass('wp-row-desc');
      assert.ok(!text(summary).includes('#'), 'row summary strips heading markers');
      assert.ok(!text(summary).includes('[x]') && !text(summary).includes('[[task:'), 'row summary strips list and ref markers');
      assert.ok(text(summary).includes('标题一') && text(summary).includes('粗体'));
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      ui.change('wp-detail-desc-input', '<img src=x onerror=alert(1)> 新内容');
      ui.click('预览');
      assert.equal(ui.nodes().filter((node) => node.type === 'img').length, 0, 'raw HTML never becomes an element');
      assert.ok(ui.text().includes('<img src=x onerror=alert(1)>'), 'the literal text is still shown');
      assert.ok(stored(ui).includes('新内容'), 'switching to preview flushes the pending edit');
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      // Pending title edit must survive a preview checkbox write.
      const title = ui.byClass('wp-detail-title-input');
      ui.fire(title, 'onChange', { target: { value: '改过的标题' } });
      ui.click('预览');
      const checks = ui.nodes().filter((node) => has(node, 'wp-md-check'));
      ui.fire(checks[1], 'onClick'); await ui.settle();
      assert.equal(ui.storage.json(KEY.tasks).find((item) => item.id === 'a').title, '改过的标题', 'the flushed title is not rolled back');
      assert.ok(ui.storage.json(KEY.tasks).find((item) => item.id === 'a').description.includes('- [x] 未完成项'));
    } finally { ui.close(); }
  }
  {
    const ui = await open(); try {
      const editor = ui.byClass('wp-detail-desc-input');
      editor.props.ref.current.selectionStart = 4; editor.props.ref.current.selectionEnd = 4;
      ui.click('关联任务');
      const names = ui.nodes().filter((node) => has(node, 'wp-md-picker-item')).map(text);
      assert.ok(!names.includes('当前任务'), 'the picker never offers the current task');
      assert.ok(names.includes('历史任务'));
    } finally { ui.close(); }
  }
  {
    const ui = await open('[看图](https://example.com/a) 与 //evil.example/x 以及 [坏](data:text/html,x)'); try {
      ui.click('预览');
      const links = ui.nodes().filter((node) => node.type === 'a');
      assert.equal(links.length, 1, 'only the https link becomes an anchor');
      assert.equal(links[0].props.href, 'https://example.com/a');
      assert.equal(links[0].props.rel, 'noreferrer noopener');
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-md-link-broken')).length, 1, 'the data: link stays text');
      assert.ok(ui.text().includes('//evil.example/x'), 'protocol-relative URLs stay literal text');
    } finally { ui.close(); }
  }
  {
    const ui = await open('[[task:missing]]'); try {
      ui.click('预览');
      assert.ok(ui.nodes().some((node) => has(node, 'wp-md-ref-broken') && text(node) === '任务已失效'), 'a deleted or unknown task reference degrades visibly');
    } finally { ui.close(); }
  }
  {
    const ui = await open('[[task:b]]'); try {
      assert.equal(ui.nodes().filter((node) => has(node, 'wp-row-desc')).length, 0, 'a marker-only description shows no raw syntax in the row');
    } finally { ui.close(); }
  }
  console.log('MARKDOWN UI: 12 scenarios passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
