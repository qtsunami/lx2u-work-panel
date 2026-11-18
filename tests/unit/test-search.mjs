import assert from 'node:assert/strict';
import { searchWorkspace } from '../../src/shared/search.js';

const workspace = {
  tasks: [
    { id: 't1', title: 'Alpha 项目', description: '实现搜索', expected: '支持 [查找]', nextStep: '验证路径', blockedReason: '等待审核' },
    { id: 't2', title: '完成任务', status: 'done', description: 'ALPHA' },
    { id: 'deleted', title: 'alpha 删除任务', deletedAt: '2026-01-01' },
  ],
  logs: [
    { id: 'l1', taskId: 't1', text: '进度 alpha 完成', files: ['/tmp/Alpha.log'] },
    { id: 'ld', taskId: 'deleted', text: 'alpha secret log' },
    { id: 'lo', taskId: 'missing', text: 'alpha orphan log' },
  ],
  artifacts: [
    { id: 'a1', taskId: 't1', summary: 'Alpha 成果', links: ['https://example.test/alpha'], files: ['/成果/ALPHA.txt'] },
    { id: 'ad', taskId: 'deleted', summary: 'alpha secret artifact' },
  ],
  reports: [
    { id: 'r1', body: '历史 ALPHA 报告', projectName: '项目', refs: [{ type: 'task', taskId: 't1' }, { taskId: 't1' }, { taskId: 'deleted' }, { taskId: 'missing' }] },
    { id: 'r2', body: 'alpha 历史已删除任务', refs: [{ taskId: 'deleted' }] },
  ],
};
const before = structuredClone(workspace);
const result = searchWorkspace(workspace, ' Alpha ');
assert.equal(result.total, 6);
assert.deepEqual(result.tasks.map((item) => item.id), ['t1', 't2']);
assert.deepEqual(result.logs.map((item) => item.id), ['l1']);
assert.deepEqual(result.artifacts.map((item) => item.id), ['a1']);
assert.deepEqual(result.reports.map((item) => item.id), ['r1', 'r2']);
assert.equal(result.logs[0].taskId, 't1');
assert.equal(result.logs[0].taskTitle, 'Alpha 项目');
assert.deepEqual(result.reports[0].taskIds, ['t1']);
assert.deepEqual(result.reports[1].taskIds, []);
assert.deepEqual(result.logs[0].matches[0], { field: 'text', text: '进度 alpha 完成', start: 3, end: 8 });
assert.deepEqual(result.artifacts[0].matches.map((m) => m.field), ['summary', 'links[0]', 'files[0]']);
assert.deepEqual(workspace, before);
assert.equal(searchWorkspace(workspace, '[查找]').tasks[0].matches[0].field, 'expected');
assert.equal(searchWorkspace(workspace, '.*').total, 0);
assert.equal(searchWorkspace(workspace, '[').total, 1);
assert.equal(searchWorkspace(workspace, '等待审核').tasks[0].id, 't1');
assert.equal(searchWorkspace(workspace, '实现搜索').tasks[0].id, 't1');
assert.equal(searchWorkspace(workspace, '验证路径').tasks[0].id, 't1');
assert.equal(searchWorkspace(workspace, '/tmp/Alpha').logs[0].matches[0].field, 'files[0]');
assert.equal(searchWorkspace(workspace, '项目').reports[0].matches[0].field, 'projectName');
assert.equal(searchWorkspace(workspace, '不存在').total, 0);
for (const value of ['', '   ', null, 42]) assert.equal(searchWorkspace(workspace, value).total, 0);
assert.equal(searchWorkspace(null, 'alpha').total, 0);
assert.equal(searchWorkspace({ tasks: [null], logs: [null], artifacts: {}, reports: [null] }, 'a').total, 0);
const unicode = searchWorkspace({ tasks: [{ id: 'u', title: '😀ABC' }] }, 'abc').tasks[0].matches[0];
assert.equal(unicode.start, 2);
assert.equal(unicode.end, 5);
assert.deepEqual(searchWorkspace(workspace, 'alpha'), result);
console.log('search tests passed');
