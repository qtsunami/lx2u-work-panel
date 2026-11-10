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
  legacyDone.description, legacyDone.project, legacyDone.expected, legacyDone.nextStep,
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

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' (' + pass + ' passed)');
process.exit(fail === 0 ? 0 : 1);
