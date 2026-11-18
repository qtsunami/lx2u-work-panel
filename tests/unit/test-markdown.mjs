import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, toggleCheckboxAtLine, markdownToPlainText, applyBlockPrefix, insertTaskRef, styleTriggerAt, removeStyleTrigger } from '../../src/shared/markdown.js';

const blocks = parseMarkdown('# 一级\n## 二级\n### 三级\n#### 超纲\n正文\n\n- 项目 A\n- [x] 已完成\n- [ ] 未完成\n\n1. 第一\n2. 第二\n> 引用一\n> 引用二');
assert.deepEqual(blocks.map((b) => b.type), ['heading', 'heading', 'heading', 'paragraph', 'list', 'list', 'quote']);
assert.equal(blocks[2].level, 3);
// '#### 超纲' is not a heading (only 1-3 #), so it joins the following paragraph.
assert.equal(blocks[3].text, '#### 超纲\n正文');
assert.deepEqual(blocks[4].items.map((i) => [i.text, i.checked]), [['项目 A', null], ['已完成', true], ['未完成', false]]);
assert.equal(blocks[5].ordered, true);
assert.deepEqual(blocks[5].items.map((i) => i.text), ['第一', '第二']);
assert.equal(blocks[6].text, '引用一\n引用二');
assert.equal(blocks[4].items[1].line, 7, 'source line is kept for checkbox writes');

assert.deepEqual(parseInline('前 **粗** *斜* `码` [链接](https://a.com) [[task:t-1]] 后'), [
  { type: 'text', text: '前 ' },
  { type: 'strong', text: '粗' },
  { type: 'text', text: ' ' },
  { type: 'em', text: '斜' },
  { type: 'text', text: ' ' },
  { type: 'code', text: '码' },
  { type: 'text', text: ' ' },
  { type: 'link', text: '链接', href: 'https://a.com' },
  { type: 'text', text: ' ' },
  { type: 'task', id: 't-1' },
  { type: 'text', text: ' 后' },
]);
assert.deepEqual(parseInline('<img src=x onerror=alert(1)>'), [{ type: 'text', text: '<img src=x onerror=alert(1)>' }]);
assert.deepEqual(parseInline(''), []);

assert.equal(toggleCheckboxAtLine('- [ ] 甲\n- [x] 乙', 0), '- [x] 甲\n- [x] 乙');
assert.equal(toggleCheckboxAtLine('- [ ] 甲\n- [x] 乙', 1), '- [ ] 甲\n- [ ] 乙');
assert.equal(toggleCheckboxAtLine('普通段落', 0), null);
assert.equal(toggleCheckboxAtLine('- [ ] 甲', 5), null);
assert.equal(toggleCheckboxAtLine('1. [ ] 甲', 0), '1. [x] 甲');

assert.equal(markdownToPlainText('# 标题\n\n- [x] 完成 **粗体** [[task:t-1]]'), '标题 完成 粗体');
assert.equal(markdownToPlainText('[文档](https://a.com)'), '文档');

const added = applyBlockPrefix('甲\n乙', 0, 0, '## ');
assert.equal(added.text, '## 甲\n乙');
assert.equal(added.selectionStart, 3);
assert.equal(applyBlockPrefix(added.text, 3, 3, '## ').text, '甲\n乙');
const multi = applyBlockPrefix('甲\n乙', 0, 3, '- ');
assert.equal(multi.text, '- 甲\n- 乙');
assert.equal(applyBlockPrefix('  甲', 2, 2, '- ').text, '  - 甲', 'existing indent is preserved for nested items');
assert.equal(applyBlockPrefix('# 标题', 2, 2, '## ').text, '## 标题', 'a heading changes level instead of stacking');
assert.equal(applyBlockPrefix('- [ ] 甲', 2, 2, '- ').text, '甲', 'toggling a bullet off also removes the checkbox marker');

const inserted = insertTaskRef('甲乙', 1, 1, 't-9');
assert.equal(inserted.text, '甲[[task:t-9]]乙');
assert.equal(inserted.selectionStart, inserted.text.indexOf(']]') + 2);
assert.equal(insertTaskRef('甲乙', 0, 2, 't-9').text, '[[task:t-9]]');

// Style triggers: line start or right after a space/tab only.
assert.deepEqual(styleTriggerAt('/', 1), { index: 0, trigger: '/', removeStart: 0 });
assert.deepEqual(styleTriggerAt('标题 /', 4), { index: 3, trigger: '/', removeStart: 2 });
assert.deepEqual(styleTriggerAt('标题 、', 4), { index: 3, trigger: '、', removeStart: 2 });
assert.deepEqual(styleTriggerAt('标题\t/', 4), { index: 3, trigger: '/', removeStart: 2 });
assert.deepEqual(styleTriggerAt('甲\n、', 3), { index: 2, trigger: '、', removeStart: 2 });
assert.equal(styleTriggerAt('11/18', 5), null, 'a slash inside a date never triggers');
assert.equal(styleTriggerAt('标题/内容', 4), null, 'a slash mid-word never triggers');
assert.deepEqual(styleTriggerAt('/标题', 1), { index: 0, trigger: '/', removeStart: 0 }, 'line start triggers');
assert.equal(styleTriggerAt('标题', 2), null);
assert.equal(styleTriggerAt('', 0), null);
assert.equal(styleTriggerAt(null, 0), null);

assert.equal(removeStyleTrigger('标题 /', 3), '标题', 'trigger and the preceding space are removed');
assert.equal(removeStyleTrigger('标题/', 2), '标题');
assert.equal(removeStyleTrigger('、甲', 0), '甲');
assert.equal(removeStyleTrigger('甲', 5), '甲');

assert.deepEqual(parseMarkdown(undefined), []);
assert.deepEqual(parseMarkdown(''), []);
assert.equal(markdownToPlainText(null), '');
console.log('markdown tests passed');
