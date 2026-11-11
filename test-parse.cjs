// Unit test for work-panel conversational parsing (loads the real client.js).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');

const React = {
  useState: () => [undefined, () => {}],
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useEffect: () => {},
  createElement: () => ({}),
};
const mockRequire = (spec) => {
  if (spec === 'react') return React;
  throw new Error('unexpected require: ' + spec);
};

let captured;
const sandbox = {
  window: { __ModuleLoader__: { load: (reg) => { captured = reg; } } },
  console,
  Date,
  JSON,
  Math,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
if (!captured) throw new Error('module loader was not called');
const plugin = captured.factory(mockRequire);
const dbg = plugin.__debug;

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log('  ok  ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + '\n        got: ' + a + '\n        exp: ' + e); }
}

const now = new Date(2026, 10, 10, 8, 0); // 2026-11-10Tue 08:00 local

console.log('\n# formatDeadline');
check('format', dbg.formatDeadline('2026-11-10T10:00'), '2026年11月10日 周二 10:00');
check('format-dateonly', dbg.formatDeadline('2026-11-10'), '2026年11月10日 周二');
check('format-empty', dbg.formatDeadline(''), '');

console.log('\n# detectIntent');
check('list-什么任务', dbg.detectIntent('我有哪些任务'), 'list');
check('list-今天做什么', dbg.detectIntent('今天要做什么'), 'list');
check('list-完成情况', dbg.detectIntent('完成情况怎么样'), 'list');
check('greeting', dbg.detectIntent('你好'), 'greeting');
check('create', dbg.detectIntent('明天10点前完成报告'), 'create');

console.log('\n# parseTask');
check('relative-tomorrow', dbg.parseTask('明天10点前完成季度报告，紧急', now), {
  title: '完成季度报告', deadline: '2026-11-11T10:00', urgency: 'high', status: 'todo', progress: 0,
});
check('weekday-friday', dbg.parseTask('本周五下午6点前提交方案', now), {
  title: '提交方案', deadline: '2026-11-13T18:00', urgency: 'medium', status: 'todo', progress: 0,
});
check('no-deadline', dbg.parseTask('整理会议纪要', now), {
  title: '整理会议纪要', deadline: '', urgency: 'medium', status: 'todo', progress: 0,
});
check('explicit-date', dbg.parseTask('2026-11-10 10:00 完成报告', now), {
  title: '完成报告', deadline: '2026-11-10T10:00', urgency: 'medium', status: 'todo', progress: 0,
});
check('create-prefix', dbg.parseTask('创建任务：整理会议纪要', now), {
  title: '整理会议纪要', deadline: '', urgency: 'medium', status: 'todo', progress: 0,
});
check('done', dbg.parseTask('已完成：整理会议纪要', now), {
  title: '整理会议纪要', deadline: '', urgency: 'medium', status: 'done', progress: 100,
});
check('doing', dbg.parseTask('进行中：写周报', now), {
  title: '写周报', deadline: '', urgency: 'medium', status: 'doing', progress: 0,
});
check('low-urgency', dbg.parseTask('有空时整理会议纪要', now), {
  title: '整理会议纪要', deadline: '', urgency: 'low', status: 'todo', progress: 0,
});
check('greeting-null', dbg.parseTask('你好', now), null);
check('empty-title-null', dbg.parseTask('创建任务', now), null);
check('list-null', dbg.parseTask('我有哪些任务', now), null);

console.log('\n# progress -> status state machine');
check('0 stays todo', dbg.progressTransition({ status: 'todo', progress: 0 }, 0), { progress: 0, status: 'todo' });
check('0->50 becomes doing', dbg.progressTransition({ status: 'todo', progress: 0 }, 50), { progress: 50, status: 'doing' });
check('50->100 becomes done', dbg.progressTransition({ status: 'doing', progress: 50 }, 100), { progress: 100, status: 'done' });
check('done is locked', dbg.progressTransition({ status: 'done', progress: 100 }, 40), null);
check('doing -> 0 becomes todo', dbg.progressTransition({ status: 'doing', progress: 50 }, 0), { progress: 0, status: 'todo' });
check('status done => 100', dbg.statusTransition({ status: 'doing', progress: 20 }, 'done'), { status: 'done', progress: 100 });
check('status doing maps to todo', dbg.statusTransition({ status: 'done', progress: 100 }, 'doing'), { status: 'todo', progress: 0 });
check('status todo => 0', dbg.statusTransition({ status: 'doing', progress: 40 }, 'todo'), { status: 'todo', progress: 0 });
check('reopen unlocks', dbg.reopenedState(), { status: 'todo', progress: 0 });

console.log('\n# buildConfirmation');
check('confirm', dbg.buildConfirmation({
  title: '完成报告', deadline: '2026-11-11T10:00', urgency: 'high', status: 'todo',
}), '已创建任务 ✅\n标题：完成报告\n截止：2026年11月11日 周三 10:00\n紧急程度：高\n状态：待办');

console.log('\n# buildTaskListReply');
check('list-empty', dbg.buildTaskListReply([]), '目前还没有任务，在上方快速添加，或直接告诉我要做什么。');
console.log(dbg.buildTaskListReply([
  { title: '完成报告', status: 'todo', deadline: '2026-11-11T10:00' },
  { title: '整理纪要', status: 'done', deadline: '' },
]));

console.log('\n# buildTaskFromModel');
const t1 = dbg.buildTaskFromModel({ title: '完成报告', deadline: '2026-11-10T10:00', urgency: 'high', status: 'doing', progress: 40 });
check('model-full', [t1.title, t1.deadline, t1.urgency, t1.status, t1.progress], ['完成报告', '2026-11-10T10:00', 'high', 'todo', 0]);
check('model-empty-title', dbg.buildTaskFromModel({ title: '  ' }), null);
const t2 = dbg.buildTaskFromModel({ title: 'X', progress: 100, status: 'todo' });
check('model-progress-100', [t2.status, t2.progress], ['todo', 0]);
const t3 = dbg.buildTaskFromModel({ title: 'Y', deadline: 'bad', urgency: 'weird', status: 'nope', progress: -5 });
check('model-sanitized', [t3.deadline, t3.urgency, t3.status, t3.progress], [dbg.todayDate(), 'medium', 'todo', 0]);

console.log('\n# formatRelativeTime');
const relNow = new Date(2026, 10, 10, 10, 0); // 2026-11-10 10:00
check('far->monthday', dbg.formatRelativeTime('2026-11-25T10:00', relNow), { text: '11月25日', icon: false });
check('10days->remaining', dbg.formatRelativeTime('2026-11-20T10:00', relNow), { text: '剩余 10天', icon: false });
check('6days->remaining', dbg.formatRelativeTime('2026-11-16T10:00', relNow), { text: '剩余 6天', icon: false });
check('8h->remaining icon', dbg.formatRelativeTime('2026-11-10T18:00', relNow), { text: '剩余 8小时', icon: true });
check('dateonly today', dbg.formatRelativeTime('2026-11-10', relNow), { text: '今天', icon: false });
check('overdue days', dbg.formatRelativeTime('2026-11-08T10:00', relNow), { text: '过期2天', icon: false, overdue: true });
check('overdue hours', dbg.formatRelativeTime('2026-11-10T06:00', relNow), { text: '过期4小时', icon: false, overdue: true });
check('empty->null', dbg.formatRelativeTime('', relNow), null);
check('normalize-empty->today', dbg.normalizeDeadline(''), dbg.todayDate());

console.log('\n# formatQuickLabel');
const qNow = new Date(2026, 10, 10, 10, 0); // 2026-11-10 Tue
check('today', dbg.formatQuickLabel('2026-11-10', '', qNow), '今天');
check('tomorrow', dbg.formatQuickLabel('2026-11-11', '', qNow), '明天');
check('day-after', dbg.formatQuickLabel('2026-11-12', '', qNow), '后天');
check('yesterday', dbg.formatQuickLabel('2026-11-09', '', qNow), '昨天');
check('day-before', dbg.formatQuickLabel('2026-11-08', '', qNow), '前天');
check('this-friday', dbg.formatQuickLabel('2026-11-13', '', qNow), '周五');
check('this-sunday', dbg.formatQuickLabel('2026-11-15', '', qNow), '周日');
check('next-monday', dbg.formatQuickLabel('2026-11-16', '', qNow), '下周一');
check('far-date', dbg.formatQuickLabel('2026-12-01', '', qNow), '12月1日');
check('today+time', dbg.formatQuickLabel('2026-11-10', '10:00', qNow), '今天 10:00');
check('next-monday+time', dbg.formatQuickLabel('2026-11-16', '11:30', qNow), '下周一 11:30');
check('far+time', dbg.formatQuickLabel('2026-12-01', '20:00', qNow), '12月1日 20:00');

console.log('\n# formatTaskDate');
check('task-date-only', dbg.formatTaskDate('2026-11-10', qNow), '今天');
check('task-date-time', dbg.formatTaskDate('2026-11-10T10:00', qNow), '今天 10:00');
check('task-next-week', dbg.formatTaskDate('2026-11-16T11:30', qNow), '下周一 11:30');
check('task-empty', dbg.formatTaskDate('', qNow), '未设置');

console.log('\n# v2 migration: withV2Fields');
const legacyDone = dbg.withV2Fields({
  id: 't-old', title: '旧任务', status: 'done', progress: 100,
  createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-03-04T05:06:07.000Z',
});
check('legacy done keeps status', legacyDone.status, 'done');
check('legacy done derives completedAt from updatedAt', legacyDone.completedAt, '2026-03-04T05:06:07.000Z');
check('v2 defaults filled', [
  legacyDone.description, legacyDone.projectId, legacyDone.expected, legacyDone.nextStep,
  legacyDone.blockedReason, legacyDone.deletedAt,
], ['', '', '', '', '', null]);
const legacyDoing = dbg.withV2Fields({ id: 't-d', title: 'X', status: 'doing', progress: 40, createdAt: 'a', updatedAt: 'b' });
check('legacy doing -> todo', [legacyDoing.status, legacyDoing.progress], ['todo', 0]);
check('todo has no completedAt', legacyDoing.completedAt, null);
check('migration keeps existing completedAt', dbg.withV2Fields({
  id: 't-c', title: 'Y', status: 'done', completedAt: '2026-05-05T00:00:00.000Z',
  createdAt: 'c', updatedAt: 'd',
}).completedAt, '2026-05-05T00:00:00.000Z');
check('empty strings survive', dbg.withV2Fields({ id: 't-e', title: 'Z', status: 'todo', description: undefined }).description, '');

console.log('\n# newTask');
const nt = dbg.newTask({ title: '新任务', deadline: '2026-11-11' });
check('new task is normalized', [nt.status, nt.urgency, nt.expected, nt.deletedAt, typeof nt.id], ['todo', 'medium', '', null, 'string']);
check('new task done gets completedAt', dbg.newTask({ title: 'A', status: 'done' }).status, 'done');
check('new task done has completedAt', typeof dbg.newTask({ title: 'A', status: 'done' }).completedAt, 'string');

console.log('\n# work records');
const entry = dbg.makeLogEntry('t-1', '  写完方案  ', 'progress', 'manual', '2026-11-10T10:00:00.000Z');
check('entry trimmed', entry.text, '写完方案');
check('entry kind', entry.kind, 'progress');
check('unknown kind falls back', dbg.makeLogEntry('t-1', 'x', 'nope').kind, 'note');
check('entry has id', typeof entry.id, 'string');
const logSet = [
  { id: 'l2', taskId: 't-1', at: '2026-11-11T10:00:00.000Z', kind: 'issue', text: 'B' },
  { id: 'l1', taskId: 't-1', at: '2026-11-10T10:00:00.000Z', kind: 'progress', text: 'A' },
  { id: 'l3', taskId: 't-2', at: '2026-11-12T10:00:00.000Z', kind: 'progress', text: 'C' },
];
check('logsOf is filtered + oldest first', dbg.logsOf(logSet, 't-1').map((l) => l.id), ['l1', 'l2']);
check('latestLog is newest of that task', dbg.latestLog(logSet, 't-1').id, 'l2');
check('latestLog empty', dbg.latestLog(logSet, 't-none'), null);

console.log('\n# artifacts');
check('links split on newline/comma', dbg.parseLinks('http://a.com\nhttp://b.com,http://c.com'), ['http://a.com', 'http://b.com', 'http://c.com']);
check('links ignore empty', dbg.parseLinks('  , http://a.com ,'), ['http://a.com']);
check('artifact normalizes links', dbg.makeArtifact('t-1', ' 结果 ', 'http://a.com').links, ['http://a.com']);
check('artifact summary trimmed', dbg.makeArtifact('t-1', ' 结果 ', '').summary, '结果');
// Acceptance: saving an artifact carries no status, so it can never complete a task.
check('artifact has no status field', 'status' in dbg.makeArtifact('t-1', 'x', ''), false);
const artSet = [
  { id: 'a1', taskId: 't-1', at: '2026-11-11T10:00:00.000Z', summary: 'B', links: [] },
  { id: 'a2', taskId: 't-1', at: '2026-11-10T10:00:00.000Z', summary: 'A', links: [] },
  { id: 'a3', taskId: 't-2', at: '2026-11-12T10:00:00.000Z', summary: 'C', links: [] },
];
check('artifactsOf filtered + oldest first', dbg.artifactsOf(artSet, 't-1').map((a) => a.id), ['a2', 'a1']);

console.log('\n# safeHref');
check('http allowed', dbg.safeHref('http://a.com'), 'http://a.com');
check('https allowed', dbg.safeHref(' https://a.com '), 'https://a.com');
check('javascript rejected', dbg.safeHref('javascript:alert(1)'), '');
check('data rejected', dbg.safeHref('data:text/html,x'), '');

console.log('\n# takeTaskSnapshot (report refs keep id + snapshot)');
const snapTask = dbg.withV2Fields({
  id: 't-1', title: '上线插件', status: 'done', urgency: 'high', deadline: '2026-11-10',
  expected: 'v1 发布', nextStep: '', blockedReason: '',
  completedAt: '2026-11-10T12:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z',
});
const snap = dbg.takeTaskSnapshot(snapTask, logSet);
check('snapshot captures title/status', [snap.title, snap.status], ['上线插件', 'done']);
check('snapshot keeps completedAt', snap.completedAt, '2026-11-10T12:00:00.000Z');
check('snapshot captures last records', snap.recent.map((r) => r.text), ['A', 'B']);
// Frozen decision: later edits to the task must not rewrite an existing snapshot.
snapTask.title = '上线插件 v1.1';
check('snapshot is immutable after task edit', snap.title, '上线插件');

console.log('\n# AI duplicate guard');
const baseTasks = [
  { id: 't-1', title: '完成报告', status: 'todo', urgency: 'medium', deadline: '2026-11-10', description: '', expected: '', nextStep: '', blockedReason: '', deletedAt: null, completedAt: null, progress: 0 },
  { id: 't-2', title: '整理会议纪要', status: 'done', urgency: 'low', deadline: '', description: '', expected: '', nextStep: '', blockedReason: '', deletedAt: null, completedAt: '2026-11-09T00:00:00.000Z', progress: 100 },
];
check('exact duplicate', dbg.findDuplicateTask(baseTasks, '完成报告').id, 't-1');
check('normalized duplicate', dbg.findDuplicateTask(baseTasks, ' 完成 报告！ ').id, 't-1');
check('substring duplicate', dbg.findDuplicateTask(baseTasks, '完成季度报告').id, 't-1');
check('unrelated title', dbg.findDuplicateTask(baseTasks, '写周报'), null);
check('deleted task ignored', dbg.findDuplicateTask([{ ...baseTasks[0], deletedAt: 'x' }], '完成报告'), null);
check('empty title', dbg.findDuplicateTask(baseTasks, '   '), null);

console.log('\n# applyActions: create');
const emptyState = { tasks: baseTasks.slice(), logs: [], artifacts: [] };
const created = dbg.applyActions(emptyState, [{ op: 'create', title: '写周报', deadline: '2026-11-14T18:00', urgency: 'high' }], '2026-11-11T00:00:00.000Z');
check('create added', created.next.tasks.length, 3);
check('create counted', created.applied, 1);
check('create normalized', [created.next.tasks[0].status, created.next.tasks[0].urgency, created.next.tasks[0].completedAt], ['todo', 'high', null]);
check('create deadline', created.next.tasks[0].deadline, '2026-11-14T18:00');
check('create prepended', created.next.tasks[0].title, '写周报');
const dup = dbg.applyActions(emptyState, [{ op: 'create', title: '完成 报告' }], 'now');
check('create duplicate skipped', [dup.applied, dup.next.tasks.length, dup.outcomes[0].reason], [0, 2, 'duplicate']);
check('duplicate not written', dup.next.tasks.length, 2);
const forced = dbg.applyActions(emptyState, [{ op: 'create', title: '完成 报告', force: true }], 'now');
check('create forced applies', forced.applied, 1);
check('empty create rejected', dbg.applyActions(emptyState, [{ op: 'create', title: '  ' }], 'now').outcomes[0].reason, 'missing-title');

console.log('\n# applyActions: update');
const upd = dbg.applyActions(emptyState, [{ op: 'update', taskId: 't-1', patch: { urgency: 'high', nextStep: '写提纲', bogus: 1 } }], '2026-11-11T00:00:00.000Z');
check('update applied', upd.applied, 1);
check('update fields', [upd.next.tasks[0].urgency, upd.next.tasks[0].nextStep], ['high', '写提纲']);
check('update strips unknown field', 'bogus' in upd.next.tasks[0], false);
check('update bumps updatedAt', upd.next.tasks[0].updatedAt, '2026-11-11T00:00:00.000Z');
check('update keeps original immutable', upd.before.tasks[0].urgency, 'medium');
check('no-op update skipped', dbg.applyActions(emptyState, [{ op: 'update', taskId: 't-1', patch: { urgency: 'medium' } }], 'now').outcomes[0].reason, 'no-change');
check('empty title not written', 'title' in (dbg.applyActions(emptyState, [{ op: 'update', taskId: 't-1', patch: { title: '  ' } }], 'now').outcomes[0]) , false);

console.log('\n# applyActions: status, log, artifact');
const completed = dbg.applyActions(emptyState, [{ op: 'complete', taskId: 't-1' }], '2026-11-11T01:00:00.000Z');
check('complete sets status+completedAt', [completed.next.tasks[0].status, completed.next.tasks[0].completedAt, completed.next.tasks[0].progress], ['done', '2026-11-11T01:00:00.000Z', 100]);
check('complete already done skipped', dbg.applyActions(emptyState, [{ op: 'complete', taskId: 't-2' }], 'now').outcomes[0].reason, 'no-change');
const reopened = dbg.applyActions({ tasks: [{ ...baseTasks[0], status: 'done', completedAt: 'x', progress: 100 }], logs: [], artifacts: [] }, [{ op: 'reopen', taskId: 't-1' }], 'now');
check('reopen clears completedAt', [reopened.next.tasks[0].status, reopened.next.tasks[0].completedAt], ['todo', null]);
const logged = dbg.applyActions(emptyState, [{ op: 'log', taskId: 't-1', kind: 'progress', text: '  推进了一步  ' }], '2026-11-11T02:00:00.000Z');
check('log appended', [logged.next.logs.length, logged.next.logs[0].source, logged.next.logs[0].text], [1, 'ai', '推进了一步']);
check('AI log marked and task not completed', [logged.next.logs[0].source, logged.next.tasks[0].status], ['ai', 'todo']);
const artifacted = dbg.applyActions(emptyState, [{ op: 'artifact', taskId: 't-1', summary: '报告 v1', links: ['https://a.com'] }], '2026-11-11T03:00:00.000Z');
check('artifact appended', artifacted.next.artifacts.length, 1);
check('artifact never completes task', [artifacted.next.tasks[0].status, artifacted.next.tasks[0].completedAt], ['todo', null]);

console.log('\n# applyActions: rejection paths');
const bad = dbg.applyActions(emptyState, [
  { op: 'complete', taskId: 't-x' },
  { op: 'nope', taskId: 't-1' },
  { op: 'log', taskId: 't-1', text: '  ' },
  { op: 'artifact', taskId: 't-1', summary: '', links: [] },
], 'now');
check('unknown task skipped', bad.outcomes[0].reason, 'missing-task');
check('unknown op skipped', bad.outcomes[1].reason, 'unknown-op');
check('empty log skipped', bad.outcomes[2].reason, 'empty-text');
check('empty artifact skipped', bad.outcomes[3].reason, 'empty');
check('rejections change nothing', [bad.next.tasks, bad.next.logs.length, bad.next.artifacts.length].map((x) => (Array.isArray(x) ? x.length : x)), [2, 0, 0]);
check('undo snapshot holds previous stores', bad.before.tasks.length, 2);
check('empty action list', dbg.applyActions(emptyState, [], 'now').applied, 0);

console.log('\n# describeAction (confirmation preview)');
const infoUpd = dbg.describeAction(baseTasks, { op: 'update', taskId: 't-1', patch: { urgency: 'high', deadline: '2026-11-12' } });
check('preview label', infoUpd.label, '修改');
check('preview title', infoUpd.title, '完成报告');
check('preview shows deadline diff first', infoUpd.lines[0].indexOf('截止时间：'), 0);
check('preview diff has arrow', infoUpd.lines[0].indexOf('→') > 0, true);
check('preview skips identical value', dbg.describeAction(baseTasks, { op: 'update', taskId: 't-1', patch: { urgency: 'medium' } }).lines.length, 0);
check('preview create duplicate flagged', dbg.describeAction(baseTasks, { op: 'create', title: '完成报告' }).duplicateOf, '完成报告');
check('preview forced create clears flag', dbg.describeAction(baseTasks, { op: 'create', title: '完成报告', force: true }).duplicateOf, null);
check('preview invalid task', (function () { const x = dbg.describeAction(baseTasks, { op: 'complete', taskId: 't-9' }); return [x.invalid, x.title]; })(), [true, '（找不到任务）']);
check('preview complete line', dbg.describeAction(baseTasks, { op: 'complete', taskId: 't-1' }).lines[0], '状态：待办 → 已完成');

console.log('\n# summarizeOutcomes');
check('summary clean', dbg.summarizeOutcomes({ applied: 2, outcomes: [{ status: 'applied' }] }), '已应用 2 项变更。');
check('summary with skips', dbg.summarizeOutcomes({
  applied: 1,
  outcomes: [{ status: 'skipped', reason: 'duplicate' }, { status: 'skipped', reason: 'no-change' }],
}), '已应用 1 项变更。跳过 2 项（与现有任务重复、与当前状态相同）。');

console.log('\n# report period');
const wed = new Date(2026, 10, 11); // 2026-11-11 Wednesday
const P = { start: '2026-11-09', end: '2026-11-15' };
check('week range from wed', dbg.weekRangeOf(wed), P);
check('week range from sunday', dbg.weekRangeOf(new Date(2026, 10, 15)), P);
check('week range from monday', dbg.weekRangeOf(new Date(2026, 10, 9)), P);
check('shift prev', dbg.shiftWeek(P, -1), { start: '2026-11-02', end: '2026-11-08' });
check('shift next', dbg.shiftWeek(P, 1), { start: '2026-11-16', end: '2026-11-22' });
check('period label', dbg.periodLabel(P), '11月9日 - 11月15日');
check('period key', dbg.periodKey(P), '2026-11-09_2026-11-15');
check('in period first day', dbg.inPeriod('2026-11-09T00:30', P), true);
check('in period last day', dbg.inPeriod('2026-11-15T23:00', P), true);
check('outside period', dbg.inPeriod('2026-11-16T00:00', P), false);
check('empty timestamp', dbg.inPeriod('', P), false);

console.log('\n# month period');
check('month range', dbg.monthRangeOf(new Date(2026, 10, 11)), { start: '2026-11-01', end: '2026-11-30' });
check('month range leap year', dbg.monthRangeOf(new Date(2028, 1, 5)), { start: '2028-02-01', end: '2028-02-29' });
check('shift month prev', dbg.shiftMonthPeriod({ start: '2026-11-01', end: '2026-11-30' }, -1), { start: '2026-10-01', end: '2026-10-31' });
check('shift month wraps year', dbg.shiftMonthPeriod({ start: '2026-12-01', end: '2026-12-31' }, 1), { start: '2027-01-01', end: '2027-01-31' });
check('periodFor week', dbg.periodFor('week', new Date(2026, 10, 11)), P);
check('periodFor month', dbg.periodFor('month', new Date(2026, 10, 11)), { start: '2026-11-01', end: '2026-11-30' });
check('shiftPeriod month', dbg.shiftPeriod('month', { start: '2026-11-01', end: '2026-11-30' }, -1), { start: '2026-10-01', end: '2026-10-31' });
check('shiftPeriod week', dbg.shiftPeriod('week', P, 1), { start: '2026-11-16', end: '2026-11-22' });
check('month label', dbg.periodLabelFor('month', { start: '2026-11-01', end: '2026-11-30' }), '2026年11月');
check('week label unchanged', dbg.periodLabelFor('week', P), '11月9日 - 11月15日');

console.log('\n# evidence collection');
const evTasks = [
  { id: 't-1', title: '上线插件', status: 'done', completedAt: '2026-11-10T04:00:00.000Z', deletedAt: null, expected: '', nextStep: '', blockedReason: '', urgency: 'high', deadline: '', description: '', createdAt: 'x', updatedAt: 'y' },
  { id: 't-2', title: '写周报', status: 'todo', completedAt: null, deletedAt: null, expected: '', nextStep: '', blockedReason: '', urgency: 'medium', deadline: '', description: '', createdAt: 'x', updatedAt: 'y' },
  { id: 't-3', title: '旧任务', status: 'done', completedAt: '2026-10-01T04:00:00.000Z', deletedAt: null, expected: '', nextStep: '', blockedReason: '', urgency: 'low', deadline: '', description: '', createdAt: 'x', updatedAt: 'y' },
  { id: 't-4', title: '已删除', status: 'todo', completedAt: null, deletedAt: '2026-11-10T00:00:00.000Z', expected: '', nextStep: '', blockedReason: '', urgency: 'low', deadline: '', description: '', createdAt: 'x', updatedAt: 'y' },
  { id: 't-5', title: '无记录', status: 'todo', completedAt: null, deletedAt: null, expected: '', nextStep: '', blockedReason: '', urgency: 'low', deadline: '', description: '', createdAt: 'x', updatedAt: 'y' },
];
const evLogs = [
  { id: 'l-1', taskId: 't-2', at: '2026-11-12T04:00:00.000Z', kind: 'progress', text: '写了开头' },
  { id: 'l-2', taskId: 't-3', at: '2026-10-02T04:00:00.000Z', kind: 'progress', text: '上个月' },
];
const evArtifacts = [
  { id: 'a-1', taskId: 't-2', at: '2026-11-13T04:00:00.000Z', summary: '周报草稿', links: [] },
];
const evidence = dbg.collectEvidence(evTasks, evLogs, evArtifacts, P);
check('evidence includes completed + progressed', evidence.map((e) => e.taskId), ['t-1', 't-2']);
check('completed flags', evidence.map((e) => e.completedThisPeriod), [true, false]);
check('unfinished keeps its records', evidence[1].logs.map((l) => l.id), ['l-1']);
check('unfinished keeps its artifacts', evidence[1].artifacts.map((a) => a.id), ['a-1']);
check('completed last month excluded', evidence.some((e) => e.taskId === 't-3'), false);
check('deleted task excluded', evidence.some((e) => e.taskId === 't-4'), false);
check('task without evidence excluded', evidence.some((e) => e.taskId === 't-5'), false);
check('evidence carries a snapshot', [typeof evidence[0].snapshot.title, evidence[0].snapshot.completedAt], ['string', '2026-11-10T04:00:00.000Z']);

const monthEvidence = dbg.collectEvidence(evTasks, evLogs, evArtifacts, { start: '2026-11-01', end: '2026-11-30' });
check('monthly evidence spans the weeks', monthEvidence.map((e) => e.taskId), ['t-1', 't-2']);
check('monthly evidence still excludes last month', monthEvidence.some((e) => e.taskId === 't-3'), false);

console.log('\n# report refs');
const body = [
  '## 一、本期主要成果',
  '- 上线插件已完成 [[task:t-1]]。',
  '- 周报写了开头 [[log:l-1]]。',
  '- 同一任务再提一次 [[task:t-1]]。',
  '- 编造的引用 [[task:t-9]]。',
].join('\n');
const refs = dbg.parseRefs(body, evidence);
check('refs deduped in document order', refs.map((r) => r.type + ':' + r.id), ['task:t-1', 'log:l-1']);
check('unknown ref ignored', refs.some((r) => r.id === 't-9'), false);
check('artifact ref resolves', dbg.parseRefs('见 [[artifact:a-1]]', evidence).map((r) => r.id), ['a-1']);
check('task ref label', dbg.refLabel(refs[0]), '任务「上线插件」（已完成）');
check('log ref label names its task', dbg.refLabel(refs[1]).indexOf('任务：写周报') > 0, true);
check('empty body has no refs', dbg.parseRefs('', evidence).length, 0);

console.log('\n# markdown export');
const md = dbg.markdownWithFootnotes(body, evidence);
check('markers replaced', md.indexOf('[[task:t-1]]'), -1);
check('dedupe keeps one footnote definition', (md.match(/\[\^1\]:/g) || []).length, 1);
check('footnotes appended', md.indexOf('\n\n[^1]: ') > 0, true);
check('unknown marker dropped from export', md.indexOf('t-9'), -1);
check('plain body without refs unchanged', dbg.markdownWithFootnotes('纯文本', evidence), '纯文本');

console.log('\n# recycle bin');
const rbTasks = [
  { id: 't-1', title: 'A', status: 'todo', deletedAt: null },
  { id: 't-2', title: 'B', status: 'done', deletedAt: '2026-11-10T00:00:00.000Z' },
  { id: 't-3', title: 'C', status: 'todo', deletedAt: null },
];
check('liveTasks excludes deleted', dbg.liveTasks(rbTasks).map((t) => t.id), ['t-1', 't-3']);
const softDeleted = dbg.markDeleted(rbTasks, 't-1', '2026-11-11T00:00:00.000Z');
check('markDeleted stamps deletedAt+updatedAt', [softDeleted[0].deletedAt, softDeleted[0].updatedAt], ['2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z']);
check('markDeleted keeps status', softDeleted[0].status, 'todo');
check('markDeleted is pure', rbTasks[0].deletedAt, null);
check('soft delete removes from live', dbg.liveTasks(softDeleted).map((t) => t.id), ['t-3']);
const restored = dbg.markRestored(softDeleted, 't-1', '2026-11-12T00:00:00.000Z');
check('markRestored clears deletedAt', [restored[0].deletedAt, restored[0].updatedAt], [null, '2026-11-12T00:00:00.000Z']);
check('restored task is live again', dbg.liveTasks(restored).map((t) => t.id), ['t-1', 't-3']);
const purged = dbg.purgeTaskData({
  tasks: [{ id: 't-1' }, { id: 't-2' }],
  logs: [{ id: 'l-1', taskId: 't-1' }, { id: 'l-2', taskId: 't-2' }],
  artifacts: [{ id: 'a-1', taskId: 't-1' }, { id: 'a-2', taskId: 't-2' }],
}, 't-1');
check('purge removes only that task', purged.tasks.map((t) => t.id), ['t-2']);
check('purge removes its logs only', purged.logs.map((l) => l.id), ['l-2']);
check('purge removes its artifacts only', purged.artifacts.map((a) => a.id), ['a-2']);

console.log('\n# report refs survive source deletion');
const draftRefs = {
  refs: [
    { type: 'task', id: 't-1', taskId: 't-1', snapshot: { title: '已删任务', status: 'done' } },
    { type: 'log', id: 'l-1', taskId: 't-1', snapshot: { title: '已删任务', status: 'done' }, entry: { at: '2026-11-10T00:00:00.000Z', kind: 'progress', text: '完成了' } },
  ],
};
check('fallback resolves from snapshot', dbg.resolveFromDraft(draftRefs, 'task', 't-1').item.title, '已删任务');
check('fallback unknown id', dbg.resolveFromDraft(draftRefs, 'task', 't-9'), null);
check('fallback without draft', dbg.resolveFromDraft(null, 'task', 't-1'), null);
const savedRefs = dbg.parseRefs('见 [[task:t-1]] 和 [[log:l-1]]', [], draftRefs);
check('refs resolve without live evidence', savedRefs.map((r) => r.type + ':' + r.id), ['task:t-1', 'log:l-1']);
check('saved ref is flagged', savedRefs[0].saved, true);
check('saved ref label uses snapshot', dbg.refLabel(savedRefs[0]), '任务「已删任务」（已完成）');
const mdDeleted = dbg.markdownWithFootnotes('见 [[task:t-1]]', [], draftRefs);
check('export still resolves a deleted source', mdDeleted.indexOf('[^1]: 任务「已删任务」') > 0, true);

console.log('\n# project entities');
check('projectKey trims and folds case', dbg.projectKey('  Work '), 'work');
const p1 = dbg.makeProject({ name: '工作台' });
check('makeProject defaults', [p1.status, p1.archivedAt, typeof p1.id], ['active', null, 'string']);

const legacyTasks = [
  { id: 'a', title: 'A', project: '工作台', deletedAt: null },
  { id: 'b', title: 'B', project: ' 工作台 ', deletedAt: null },
  { id: 'c', title: 'C', project: '客户', deletedAt: null },
  { id: 'd', title: 'D', deletedAt: null },
];
const legacyReports = [
  { id: 'r1', body: 'x', kind: 'week', projectScope: '工作台' },
  { id: 'r2', body: 'y', kind: 'week', projectScope: '不存在的项目' },
  { id: 'r3', body: 'z', kind: 'week' },
];
const migrated = dbg.migrateProjectRefs(legacyTasks, [], legacyReports);
check('migration creates one project per distinct name', migrated.projects.map((p) => p.name), ['工作台', '客户']);
check('migration removes the legacy field', migrated.tasks.some((t) => 'project' in t), false);
const wbId = migrated.projects[0].id;
check('same names share one project id', [migrated.tasks[0].projectId, migrated.tasks[1].projectId], [wbId, wbId]);
check('distinct projects get distinct ids', migrated.tasks[2].projectId === wbId, false);
check('tasks without a project stay untouched', 'projectId' in migrated.tasks[3], false);
check('reports map to id + name snapshot', [migrated.reports[0].projectId, migrated.reports[0].projectName], [wbId, '工作台']);
check('unmatched report keeps its name', [migrated.reports[1].projectId, migrated.reports[1].projectName], ['', '不存在的项目']);
check('report without a scope stays untouched', 'projectId' in migrated.reports[2], false);
check('migration is idempotent', dbg.migrateProjectRefs(migrated.tasks, migrated.projects, migrated.reports).changed, false);

const projBaseProjects = [dbg.makeProject({ name: '工作台' }), dbg.makeProject({ name: '客户' })];
const projBaseTasks = [
  { id: 't1', projectId: projBaseProjects[0].id },
  { id: 't2', projectId: projBaseProjects[1].id },
];
const renamed = dbg.renameProject(projBaseProjects, projBaseTasks, projBaseProjects[0].id, '工作台 v2');
check('rename updates the name once', renamed.projects[0].name, '工作台 v2');
check('rename keeps task references', renamed.tasks[0].projectId, projBaseProjects[0].id);
check('rename is not a merge', renamed.merged, false);
const merged = dbg.renameProject(projBaseProjects, projBaseTasks, projBaseProjects[0].id, '客户');
check('rename onto an existing name merges', merged.merged, true);
check('merge moves all tasks', merged.tasks.map((t) => t.projectId), [projBaseProjects[1].id, projBaseProjects[1].id]);
check('merge drops the source project', merged.projects.map((p) => p.name), ['客户']);
check('empty rename rejected', dbg.renameProject(projBaseProjects, projBaseTasks, projBaseProjects[0].id, '   ').error, 'empty-name');
check('missing project rejected', dbg.renameProject(projBaseProjects, projBaseTasks, 'nope', 'x').error, 'missing-project');

const archived = dbg.setProjectArchived(projBaseProjects, projBaseProjects[0].id, true, '2026-11-11T00:00:00.000Z');
check('archive sets status and stamp', [archived[0].status, archived[0].archivedAt], ['archived', '2026-11-11T00:00:00.000Z']);
check('unarchive clears the stamp', dbg.setProjectArchived(archived, projBaseProjects[0].id, false, 'x')[0].archivedAt, null);

const deletedProject = dbg.deleteProject(projBaseProjects, projBaseTasks, projBaseProjects[0].id);
check('delete keeps tasks', deletedProject.tasks.length, 2);
check('delete ungroups its tasks', deletedProject.tasks[0].projectId, '');
check('delete removes the project record', deletedProject.projects.map((p) => p.name), ['客户']);

check('counts skip deleted tasks and blanks', JSON.stringify(Array.from(dbg.countProjectTasks([
  { projectId: 'p1', deletedAt: null },
  { projectId: 'p1', deletedAt: 'x' },
  { projectId: 'p2', deletedAt: null },
  { projectId: '', deletedAt: null },
]).entries())), JSON.stringify([['p1', 1], ['p2', 1]]));

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' (' + pass + ' passed)');
process.exit(fail === 0 ? 0 : 1);
