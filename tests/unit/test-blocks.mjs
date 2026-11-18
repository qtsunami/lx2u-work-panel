import assert from 'node:assert/strict';
import { blockStyle, parseBlocks, serializeBlocks, markerLength, stripMarker, setBlockType, splitBlock, mergeBlocks, toggleBlockCheckbox, orderedNumber } from '../../src/shared/blocks.js';

const text = [
  '# 标题',
  '## 二级',
  '正文 **粗体**',
  '',
  '- 项目',
  '- [x] 完成',
  '- [ ] 未完成',
  '1. 第一',
  '> 引用',
].join('\n');

const blocks = parseBlocks(text);
assert.equal(blocks.length, 9);
assert.equal(serializeBlocks(blocks), text, 'round trip is lossless, blank lines included');
assert.deepEqual(blocks.map((b) => b.type), ['heading', 'heading', 'paragraph', 'paragraph', 'item', 'item', 'item', 'item', 'quote']);
assert.equal(blocks[1].level, 2);
assert.equal(blocks[5].checked, true);
assert.equal(blocks[6].checked, false);
assert.equal(blocks[7].ordered, true);
assert.equal(blocks[8].content, '引用');

assert.deepEqual(parseBlocks(''), [{ source: '', type: 'paragraph', content: '', ordered: false, checked: null }]);
assert.equal(serializeBlocks(parseBlocks('')), '');
assert.equal(serializeBlocks(parseBlocks('a\n\nb')), 'a\n\nb');

assert.equal(markerLength('## 标题'), 3);
assert.equal(markerLength('  - [ ] 甲'), 8);
assert.equal(markerLength('正文'), 0);
assert.equal(stripMarker('## 标题'), '标题');
assert.equal(stripMarker('  - [x] 甲'), '  甲');

assert.equal(setBlockType('正文', 'heading', 2), '## 正文');
assert.equal(setBlockType('# 正文', 'heading', 2), '## 正文');
assert.equal(setBlockType('## 正文', 'heading', 2), '正文', 'same level toggles back to text');
assert.equal(setBlockType('- 甲', 'ordered'), '1. 甲');
assert.equal(setBlockType('1. 甲', 'task'), '- [ ] 甲');
assert.equal(setBlockType('- [x] 甲', 'quote'), '> 甲');
assert.equal(setBlockType('正文', 'bullet'), '- 正文');
assert.equal(setBlockType('  正文', 'bullet'), '  - 正文', 'indent is kept');
assert.equal(setBlockType('## 正文', 'paragraph'), '正文');
// Regression: indentation + marker must never drop body text (markerLength already counts indent).
assert.equal(setBlockType('  - 任务', 'task'), '  - [ ] 任务');
assert.equal(setBlockType('  - [ ] 任务', 'bullet'), '  - 任务');
assert.equal(setBlockType('    1. 第一项', 'bullet'), '    - 第一项');
assert.equal(setBlockType('  - 任务', 'heading', 2), '  ## 任务');
assert.equal(setBlockType('  正文', 'task'), '  - [ ] 正文');
assert.equal(setBlockType('  - [x] 甲', 'task'), '  甲', 'same type toggles the marker off without losing text');


assert.deepEqual(splitBlock('## 标题', 4), { left: '## 标', right: '题' }, 'headings start a paragraph');
assert.deepEqual(splitBlock('- 甲', 2), { left: '- ', right: '- 甲' }, 'lists continue');
assert.deepEqual(splitBlock('1. 甲', 0), { left: '1. ', right: '1. 甲' });
assert.deepEqual(splitBlock('- [ ] 甲', 0), { left: '- [ ] ', right: '- [ ] 甲' }, 'a split task item is unchecked');
assert.deepEqual(splitBlock('> 引用', 0), { left: '> ', right: '> 引用' });assert.deepEqual(splitBlock('  - 子项', 6), { left: '  - 子项', right: '  - ' }, 'nested list keeps its indentation');
assert.deepEqual(splitBlock('- ', 2), { left: '', right: '' }, 'Enter on an empty item leaves the list');


assert.equal(mergeBlocks('## 甲', '乙'), '## 甲乙');
assert.equal(mergeBlocks('## 甲', '- 乙'), '## 甲乙');

assert.equal(toggleBlockCheckbox('- [ ] 甲'), '- [x] 甲');
assert.equal(toggleBlockCheckbox('- [x] 甲'), '- [ ] 甲');
assert.equal(toggleBlockCheckbox('1. [ ] 甲'), '1. [x] 甲');
assert.equal(toggleBlockCheckbox('普通'), null);

const ordered = parseBlocks('1. 甲\n1. 乙\n正文\n1. 丙');
assert.equal(orderedNumber(ordered, 0), 1);
assert.equal(orderedNumber(ordered, 1), 2);
assert.equal(orderedNumber(ordered, 3), 1, 'a paragraph resets the numbering');
console.log('blocks tests passed');
