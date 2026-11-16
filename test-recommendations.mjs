import assert from 'node:assert/strict';
import { recommendArtifacts } from './recommendations.js';
const workspace = {
  tasks: [
    { id: 'current', title: '客户方案设计', projectId: 'p' },
    { id: 'related', title: '客户方案初稿', projectId: 'p' },
    { id: 'same', title: '其他工作', projectId: 'p' },
    { id: 'text', title: '客户方案审查', projectId: 'q' },
    { id: 'unrelated', title: '整理午餐清单', projectId: 'q' },
    { id: 'deleted', title: '客户方案设计', projectId: 'p', deletedAt: 'y' },
  ],
  artifacts: [
    { id: 'a', taskId: 'related', summary: '初稿' },
    { id: 'b', taskId: 'same', summary: '记录' },
    { id: 'c', taskId: 'text', summary: '审核结果' },
    { id: 'd', taskId: 'unrelated', summary: '饮食' },
    { id: 'e', taskId: 'deleted', summary: '文件' },
    { id: 'f', taskId: 'current', summary: '已有成果' },
    { id: 'g', taskId: 'missing', summary: '无关联成果' },
  ],
};
const results = recommendArtifacts(workspace, 'current');
assert.deepEqual(results.map(x => x.artifact.id), ['a', 'b', 'c']);
assert.equal(results[0].reason, '同一项目，内容有相似词');
assert.equal(results[1].reason, '同一项目');
assert.equal(results[2].reason, '内容有相似词');
assert.equal(recommendArtifacts(workspace, 'current', 1).length, 1);
assert.deepEqual(recommendArtifacts(workspace, 'deleted'), []);
assert.deepEqual(recommendArtifacts(null, 'current'), []);
assert.deepEqual(recommendArtifacts({ tasks: [{ id: 'x', title: 'a' }, { id: 'y', title: 'b' }], artifacts: [{ id: 'z', taskId: 'y' }] }, 'x'), []);
console.log('RECOMMENDATIONS: PASS');
