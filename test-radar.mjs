import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IssueRadar, scanIssues } from './radar.js';

// Every clock value here is fixed and passed in, exactly as the browser build
// receives it. The suite never relies on the real current time.
const NOW = new Date(2026, 4, 20, 10, 0, 0, 0).getTime(); // 2026-05-20 10:00 local
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const daysAgo = (days) => iso(NOW - days * DAY);
const msAgo = (ms) => iso(NOW - ms);
const task = (id, extra = {}) => ({ id, title: '任务' + id, status: 'todo', ...extra });
const workspace = (tasks, extra = {}) => ({ tasks, projects: [], logs: [], artifacts: [], reports: [], inboxAck: [], reportEdits: {}, ...extra });
const clone = (value) => JSON.parse(JSON.stringify(value));
const radar = new IssueRadar();
const scan = (input) => radar.scan({ nowMs: NOW, ...input });
const kinds = (result) => result.items.map((item) => item.kind);
const ids = (result) => result.items.map((item) => item.id);
const one = (result) => { assert.equal(result.items.length, 1, '期望恰好一条问题'); return result.items[0]; };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- deadline-soon / overdue ------------------------------------------------

test('date-only deadline today counts as due today with high severity', () => {
  const issue = one(scan({ workspace: workspace([task('a', { deadline: '2026-05-20' })]) }));
  assert.equal(issue.kind, 'deadline-soon');
  assert.equal(issue.severity, 'high');
  assert.equal(issue.taskId, 'a');
  assert.equal(issue.evidence.dateOnly, true);
  assert.equal(issue.evidence.remainingDays, 0);
  assert.match(issue.fact, /今天到期/);
});

test('date-only deadline today is not overdue at 10:00 because the day ends at 23:59', () => {
  const result = scan({ workspace: workspace([task('a', { deadline: '2026-05-20' })]) });
  assert.deepEqual(kinds(result), ['deadline-soon']);
  assert.equal(result.items[0].evidence.dueAt, iso(new Date(2026, 4, 20, 23, 59, 59, 999).getTime()));
});

test('remaining exactly 3 calendar days still triggers at medium severity', () => {
  const issue = one(scan({ workspace: workspace([task('a', { deadline: '2026-05-23' })]) }));
  assert.equal(issue.kind, 'deadline-soon');
  assert.equal(issue.severity, 'medium');
  assert.equal(issue.evidence.remainingDays, 3);
});

test('remaining 4 calendar days does not trigger', () => {
  const result = scan({ workspace: workspace([task('a', { deadline: '2026-05-24' })]) });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.counts, { byKind: {}, bySeverity: {} });
});

test('deadline 1ms in the future is due-soon while exactly now is still due-soon', () => {
  const plusOne = scan({ workspace: workspace([task('a', { deadline: iso(NOW + 1) })]) });
  assert.deepEqual(kinds(plusOne), ['deadline-soon']);
  assert.equal(plusOne.items[0].severity, 'high');
  const exact = scan({ workspace: workspace([task('b', { deadline: iso(NOW) })]) });
  assert.deepEqual(kinds(exact), ['deadline-soon']);
  assert.equal(exact.items[0].evidence.remainingMs, 0);
});

test('deadline 1ms in the past flips to overdue with high severity', () => {
  const issue = one(scan({ workspace: workspace([task('a', { deadline: iso(NOW - 1) })]) }));
  assert.equal(issue.kind, 'overdue');
  assert.equal(issue.severity, 'high');
  assert.equal(issue.evidence.remainingMs, -1);
  // 1ms 不足 1 小时，事实句如实说「不足 1 小时」，不夸大成「1 小时」。
  assert.match(issue.fact, /已过截止时间但不足 1 小时/);
});

test('a date-only overdue deadline counts calendar days, so 17th is 3 days overdue on the 20th', () => {
  const issue = one(scan({ workspace: workspace([task('a', { deadline: '2026-05-17' })]) }));
  assert.equal(issue.kind, 'overdue');
  assert.equal(issue.evidence.overdueDays, 3);
  assert.equal(issue.evidence.dateOnly, true);
  assert.match(issue.fact, /已逾期 3 天/);
});

test('a timed deadline 30 minutes late is not inflated into a whole hour', () => {
  const result = scan({ workspace: workspace([task('a', { deadline: '2026-05-20T09:30' })]) });
  const issue = one(result);
  assert.equal(issue.kind, 'overdue');
  assert.equal(issue.evidence.dateOnly, false);
  assert.equal(issue.evidence.overdueDays, 0);
  assert.equal(issue.evidence.overdueHours, 0);
  assert.match(issue.fact, /已过截止时间但不足 1 小时/);
  assert.doesNotMatch(issue.fact, /已逾期 \d+ 小时/);
});

test('a timed deadline 90 minutes late reports exactly 1 hour', () => {
  const result = scan({ workspace: workspace([task('a', { deadline: '2026-05-20T08:30' })]) });
  const issue = one(result);
  assert.equal(issue.evidence.overdueHours, 1);
  assert.match(issue.fact, /已逾期 1 小时/);
});

test('a timed deadline exactly one day late reports 1 day', () => {
  const result = scan({ workspace: workspace([task('a', { deadline: '2026-05-19T10:00' })]) });
  const issue = one(result);
  assert.equal(issue.kind, 'overdue');
  assert.equal(issue.evidence.overdueDays, 1);
  assert.match(issue.fact, /已逾期 1 天/);
});

test('done tasks never produce deadline-soon or overdue', () => {
  const result = scan({ workspace: workspace([
    task('a', { deadline: '2026-05-19', status: 'done', completedAt: daysAgo(1) }),
    task('b', { deadline: '2026-05-20', status: 'done', completedAt: daysAgo(1) }),
  ]) });
  // done-no-artifact is expected here; the deadline signals must not appear.
  assert.deepEqual(kinds(result), ['done-no-artifact', 'done-no-artifact']);
});

test('deleted tasks never produce deadline-soon or overdue', () => {
  const result = scan({ workspace: workspace([task('a', { deadline: '2026-05-17', deletedAt: daysAgo(2) })]) });
  assert.deepEqual(result.items, []);
});

test('tasks without a deadline and unparseable deadlines produce no signal', () => {
  const result = scan({ workspace: workspace([
    task('a'),
    task('b', { deadline: '' }),
    task('c', { deadline: '下周五' }),
    task('d', { deadline: '2026-13-40' }),
  ]) });
  assert.deepEqual(result.items, []);
});

// ---- blocked-long ----------------------------------------------------------

test('blocked reason with an update exactly 7 days old triggers blocked-long', () => {
  const issue = one(scan({ workspace: workspace([task('a', { blockedReason: '等待对方提供接口文档', updatedAt: daysAgo(7) })]) }));
  assert.equal(issue.kind, 'blocked-long');
  assert.equal(issue.severity, 'medium');
  assert.equal(issue.evidence.blockedReason, '等待对方提供接口文档');
  assert.equal(issue.evidence.daysSinceUpdate, 7);
  assert.match(issue.fact, /等待对方提供接口文档/);
});

test('blocked reason 7 days minus 1ms old does not trigger', () => {
  const result = scan({ workspace: workspace([task('a', { blockedReason: '等待评审', updatedAt: msAgo(7 * DAY - 1) })]) });
  assert.deepEqual(result.items, []);
});

test('whitespace-only blocked reason is not a blocker', () => {
  const result = scan({ workspace: workspace([task('a', { blockedReason: '   ', updatedAt: daysAgo(30) })]) });
  assert.equal(result.items.filter((issue) => issue.kind === 'blocked-long').length, 0);
});

test('blocked task without a usable updatedAt asserts no elapsed time', () => {
  const result = scan({ workspace: workspace([task('a', { blockedReason: '等待确认' })]) });
  assert.deepEqual(result.items, []);
});

test('done or deleted blocked tasks are excluded', () => {
  const result = scan({ workspace: workspace([
    task('a', { blockedReason: '阻塞', updatedAt: daysAgo(30), status: 'done', completedAt: daysAgo(30) }),
    task('b', { blockedReason: '阻塞', updatedAt: daysAgo(30), deletedAt: daysAgo(1) }),
  ]) });
  assert.equal(result.items.filter((issue) => issue.kind === 'blocked-long').length, 0);
});

// ---- no-record -------------------------------------------------------------

test('14 days without any record reports 暂无近期记录 and claims nothing about progress', () => {
  const issue = one(scan({ workspace: workspace([task('a', { updatedAt: daysAgo(14) })]) }));
  assert.equal(issue.kind, 'no-record');
  assert.equal(issue.severity, 'low');
  assert.equal(issue.evidence.daysSinceActivity, 14);
  assert.match(issue.fact, /暂无近期记录/);
  assert.doesNotMatch(issue.fact, /没有进展|未工作|停滞/);
  assert.ok(issue.actions.includes('add-record'));
});

test('13 days 23 hours of silence does not trigger no-record', () => {
  const result = scan({ workspace: workspace([task('a', { updatedAt: msAgo(14 * DAY - 1) })]) });
  assert.deepEqual(result.items, []);
});

test('a recent work log keeps an old task out of no-record', () => {
  const result = scan({
    workspace: workspace([task('a', { updatedAt: daysAgo(40) })], {
      logs: [{ id: 'l1', taskId: 'a', text: '已推进一版', at: daysAgo(2) }],
    }),
  });
  assert.deepEqual(result.items, []);
});

test('a recent artifact also counts as a record', () => {
  const result = scan({
    workspace: workspace([task('a', { updatedAt: daysAgo(40) })], {
      artifacts: [{ id: 'f1', taskId: 'a', summary: '说明文档', at: msAgo(DAY) }],
    }),
  });
  assert.deepEqual(result.items, []);
});

test('task with no timestamps at all is not reported as lacking records', () => {
  const result = scan({ workspace: workspace([task('a')]) });
  assert.deepEqual(result.items, []);
});

test('no-record evidence lists every traceable timestamp', () => {
  const issue = one(scan({
    workspace: workspace([task('a', { updatedAt: daysAgo(20) })], {
      logs: [{ id: 'l1', taskId: 'a', text: '旧记录', at: daysAgo(18) }],
    }),
  }));
  assert.equal(issue.evidence.updatedAt, daysAgo(20));
  assert.equal(issue.evidence.lastLogAt, daysAgo(18));
  assert.equal(issue.evidence.lastActivityAt, daysAgo(18));
  assert.equal(issue.evidence.daysSinceActivity, 18);
});

test('done or deleted tasks never produce no-record', () => {
  const result = scan({ workspace: workspace([
    task('a', { updatedAt: daysAgo(90), status: 'done', completedAt: daysAgo(90) }),
    task('b', { updatedAt: daysAgo(90), deletedAt: daysAgo(80) }),
  ]) });
  assert.equal(result.items.filter((issue) => issue.kind === 'no-record').length, 0);
  assert.equal(result.hidden.dismissed, 0);
});

// ---- pending-receipt -------------------------------------------------------

test('a non-empty inbox count produces one task-less pending-receipt issue', () => {
  const issue = one(scan({ workspace: workspace([]), inbox: 3 }));
  assert.equal(issue.kind, 'pending-receipt');
  assert.equal(issue.taskId, null);
  assert.equal(issue.severity, 'medium');
  assert.equal(issue.evidence.pendingCount, 3);
});

test('inbox items carry the oldest and latest receipt timestamps', () => {
  const issue = one(scan({
    workspace: workspace([]),
    inbox: [
      { id: 'i1', text: '回传一', receivedAt: daysAgo(3) },
      { id: 'i2', text: '回传二', receivedAt: daysAgo(1) },
    ],
  }));
  assert.equal(issue.evidence.pendingCount, 2);
  assert.equal(issue.evidence.oldestReceivedAt, daysAgo(3));
  assert.equal(issue.evidence.latestReceivedAt, daysAgo(1));
});

test('empty inbox, zero count and missing inbox produce no pending-receipt', () => {
  for (const inbox of [undefined, 0, [], { items: [] }, -1]) {
    assert.deepEqual(scan({ workspace: workspace([]), inbox }).items, [], 'inbox=' + JSON.stringify(inbox));
  }
});

test('pending-receipt accepts an inbox object shape', () => {
  const issue = one(scan({ workspace: workspace([]), inbox: { items: [{ id: 'i1', text: '回传', receivedAt: daysAgo(1) }] } }));
  assert.equal(issue.kind, 'pending-receipt');
  assert.equal(issue.evidence.pendingCount, 1);
});

// ---- done-no-artifact ------------------------------------------------------

test('done task without any artifact reference is reported at low severity', () => {
  const issue = one(scan({ workspace: workspace([task('a', { status: 'done', completedAt: daysAgo(2) })]) }));
  assert.equal(issue.kind, 'done-no-artifact');
  assert.equal(issue.severity, 'low');
  assert.match(issue.fact, /暂无成果引用/);
  assert.ok(issue.actions.includes('add-record'));
});

test('artifact with files suppresses done-no-artifact', () => {
  const result = scan({
    workspace: workspace([task('a', { status: 'done', completedAt: daysAgo(2) })], {
      artifacts: [{ id: 'f1', taskId: 'a', files: ['/tmp/report.md'] }],
    }),
  });
  assert.deepEqual(result.items, []);
});

test('artifact with links suppresses done-no-artifact', () => {
  const result = scan({
    workspace: workspace([task('a', { status: 'done', completedAt: daysAgo(2) })], {
      artifacts: [{ id: 'f1', taskId: 'a', links: ['https://example.com/pr/1'] }],
    }),
  });
  assert.deepEqual(result.items, []);
});

test('artifact with only a summary does not count as a reference', () => {
  const issue = one(scan({
    workspace: workspace([task('a', { status: 'done', completedAt: daysAgo(2) })], {
      artifacts: [{ id: 'f1', taskId: 'a', summary: '做完了但没留下位置', files: [], links: [] }],
    }),
  }));
  assert.equal(issue.kind, 'done-no-artifact');
  assert.equal(issue.evidence.artifactCount, 1);
  assert.equal(issue.evidence.referenceCount, 0);
});

test('open tasks and deleted done tasks produce no done-no-artifact', () => {
  const result = scan({ workspace: workspace([
    task('a'),
    task('b', { status: 'done', completedAt: daysAgo(1), deletedAt: daysAgo(1) }),
  ]) });
  assert.deepEqual(result.items, []);
});

test('completedAt alone is enough to classify a task as done', () => {
  const issue = one(scan({ workspace: workspace([{ id: 'a', title: '任务a', completedAt: daysAgo(1) }]) }));
  assert.equal(issue.kind, 'done-no-artifact');
});

// ---- user state: snooze / dismiss -----------------------------------------

test('snoozed issue is hidden until its until timestamp and counted as hidden', () => {
  const result = scan({
    workspace: workspace([task('a', { deadline: '2026-05-20' })]),
    state: { snoozed: { 'deadline-soon:a': iso(NOW + DAY) } },
  });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.hidden, { snoozed: 1, dismissed: 0 });
  assert.deepEqual(result.counts, { byKind: {}, bySeverity: {} });
});

test('snooze expires exactly at until so the issue reappears', () => {
  const result = scan({
    workspace: workspace([task('a', { deadline: '2026-05-20' })]),
    state: { snoozed: { 'deadline-soon:a': iso(NOW) } },
  });
  assert.deepEqual(kinds(result), ['deadline-soon']);
  assert.deepEqual(result.hidden, { snoozed: 0, dismissed: 0 });
});

test('issue reappears once the snooze window has passed by 1ms', () => {
  const result = scan({
    workspace: workspace([task('a', { deadline: '2026-05-20' })]),
    state: { snoozed: { 'deadline-soon:a': iso(NOW - 1) } },
  });
  assert.deepEqual(kinds(result), ['deadline-soon']);
});

test('an unparseable snooze value never hides a real issue', () => {
  const result = scan({
    workspace: workspace([task('a', { deadline: '2026-05-20' })]),
    state: { snoozed: { 'deadline-soon:a': '下周' } },
  });
  assert.deepEqual(kinds(result), ['deadline-soon']);
  assert.equal(result.hidden.snoozed, 0);
});

test('dismissed issue stays hidden with no expiry', () => {
  const result = scan({
    workspace: workspace([task('a', { deadline: '2026-05-19' })]),
    state: { dismissed: { 'overdue:a': true } },
  });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.hidden, { snoozed: 0, dismissed: 1 });
});

test('dismiss only honours an explicit true flag', () => {
  const result = scan({
    workspace: workspace([task('a', { deadline: '2026-05-19' })]),
    state: { dismissed: { 'overdue:a': 'yes' } },
  });
  assert.deepEqual(kinds(result), ['overdue']);
  assert.equal(result.hidden.dismissed, 0);
});

test('snoozing one kind does not hide another kind of the same task', () => {
  const result = scan({
    workspace: workspace([task('a', { deadline: '2026-05-19', blockedReason: '等待确认', updatedAt: daysAgo(10) })]),
    state: { snoozed: { 'overdue:a': iso(NOW + DAY) } },
  });
  assert.deepEqual(kinds(result), ['blocked-long']);
  assert.equal(result.hidden.snoozed, 1);
});

// ---- multiple signals, ordering, counts, limits ---------------------------

test('one task yields one item per kind instead of a merged entry', () => {
  const result = scan({
    workspace: workspace([task('a', { deadline: '2026-05-19', blockedReason: '等待外部依赖', updatedAt: daysAgo(9) })]),
  });
  assert.deepEqual(kinds(result), ['overdue', 'blocked-long']);
  assert.deepEqual(result.counts.byKind, { overdue: 1, 'blocked-long': 1 });
  assert.deepEqual(result.counts.bySeverity, { high: 1, medium: 1 });
});

test('items are ordered by severity before any other key', () => {
  const result = scan({
    workspace: workspace([
      task('low', { updatedAt: daysAgo(30) }),
      task('med', { deadline: '2026-05-23' }),
      task('high', { deadline: '2026-05-19' }),
    ]),
  });
  assert.deepEqual(result.items.map((item) => item.severity), ['high', 'medium', 'low']);
});

test('equal severity falls back to the fixed kind order', () => {
  const result = scan({
    workspace: workspace([
      task('blocked', { blockedReason: '等待接口', updatedAt: daysAgo(9) }),
      task('soon', { deadline: '2026-05-23' }),
    ]),
  });
  assert.deepEqual(kinds(result), ['deadline-soon', 'blocked-long']);
});

test('repeated scans of the same snapshot are deeply identical', () => {
  const input = { workspace: workspace([
    task('a', { deadline: '2026-05-23' }),
    task('b', { updatedAt: daysAgo(30) }),
    task('c', { deadline: '2026-05-19', blockedReason: '阻塞', updatedAt: daysAgo(8) }),
  ]), nowMs: NOW };
  assert.deepEqual(radar.scan(input), radar.scan(input));
});

test('task input order is preserved for otherwise identical issues', () => {
  const result = scan({
    workspace: workspace([
      task('z', { updatedAt: daysAgo(20) }),
      task('y', { updatedAt: daysAgo(20) }),
    ]),
  });
  assert.deepEqual(ids(result), ['no-record:z', 'no-record:y']);
});

test('limit trims the list but keeps totals and counts complete', () => {
  const tasks = Array.from({ length: 5 }, (_, index) => task('t' + index, { updatedAt: daysAgo(20 + index) }));
  const result = scan({ workspace: workspace(tasks), limit: 2 });
  assert.equal(result.items.length, 2);
  assert.equal(result.total, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.counts.byKind['no-record'], 5);
});

test('default limit caps output at 50 issues', () => {
  const tasks = Array.from({ length: 60 }, (_, index) => task('t' + index, { updatedAt: daysAgo(20) }));
  const result = scan({ workspace: workspace(tasks) });
  assert.equal(result.items.length, 50);
  assert.equal(result.total, 60);
  assert.equal(result.truncated, true);
  assert.equal(result.counts.byKind['no-record'], 60);
});

test('limit 0 returns no items while still reporting the totals', () => {
  const result = scan({ workspace: workspace([task('a', { updatedAt: daysAgo(20) })]), limit: 0 });
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 1);
  assert.equal(result.truncated, true);
});

test('out-of-range and non-numeric limits fall back to the configured default', () => {
  const tasks = Array.from({ length: 3 }, (_, index) => task('t' + index, { updatedAt: daysAgo(20) }));
  for (const limit of [undefined, null, -5, '3', Number.NaN]) {
    assert.equal(scan({ workspace: workspace(tasks), limit }).items.length, 3, 'limit=' + String(limit));
  }
});

test('every issue carries the documented shape and traceable evidence', () => {
  const result = scan({
    workspace: workspace([
      task('a', { deadline: '2026-05-19', blockedReason: '等待确认', updatedAt: daysAgo(9) }),
      task('b', { updatedAt: daysAgo(30) }),
      task('done', { status: 'done', completedAt: daysAgo(1) }),
    ]),
    inbox: 2,
  });
  assert.ok(result.items.length >= 5);
  for (const issue of result.items) {
    assert.equal(typeof issue.id, 'string');
    assert.ok(issue.id.length > 0);
    assert.ok(['high', 'medium', 'low'].includes(issue.severity));
    assert.ok(issue.taskId === null || typeof issue.taskId === 'string');
    assert.equal(typeof issue.title, 'string');
    assert.ok(issue.title.length > 0);
    assert.equal(typeof issue.fact, 'string');
    assert.match(issue.fact, /。$/, '事实句应为完整陈述句');
    assert.ok(issue.evidence && typeof issue.evidence === 'object');
    assert.ok(Array.isArray(issue.actions) && issue.actions.length > 0);
    assert.ok(issue.actions.includes('open'));
    assert.ok(issue.actions.includes('snooze'));
    assert.ok(issue.actions.includes('dismiss'));
  }
  const taskIssues = result.items.filter((issue) => issue.taskId !== null);
  for (const issue of taskIssues) assert.ok(issue.evidence.taskId === issue.taskId || issue.evidence.taskId === undefined);
});

// ---- robustness ------------------------------------------------------------

test('invalid input returns invalid-workspace instead of throwing', () => {
  for (const input of [undefined, null, 42, 'x', {}, { workspace: null }, { workspace: [] }, { workspace: {} }]) {
    const result = new IssueRadar().scan(input);
    assert.deepEqual(result.items, []);
    assert.equal(result.error, 'invalid-workspace', 'input=' + JSON.stringify(input));
    assert.deepEqual(result.counts, { byKind: {}, bySeverity: {} });
    assert.deepEqual(result.hidden, { snoozed: 0, dismissed: 0 });
  }
});

test('a workspace missing a required collection is rejected, not treated as empty', () => {
  for (const broken of [
    { logs: [], artifacts: [] },
    { tasks: [], artifacts: [] },
    { tasks: [], logs: [] },
  ]) {
    assert.equal(new IssueRadar().scan({ workspace: broken, nowMs: NOW }).error, 'invalid-workspace');
  }
});

test('a missing or non-finite nowMs is rejected with the same invalid-workspace code', () => {
  for (const nowMs of [undefined, null, 'now', Number.NaN, Infinity]) {
    const result = new IssueRadar().scan({ workspace: workspace([]), nowMs });
    assert.deepEqual(result.items, []);
    assert.equal(result.error, 'invalid-workspace', 'nowMs=' + String(nowMs));
  }
});

test('malformed records inside a valid workspace never throw', () => {
  const result = scan({
    workspace: {
      tasks: [null, 42, {}, { id: '' }, { id: 'ok', title: null, deadline: 5 }],
      logs: [null, { taskId: 'ok' }, { id: 'x' }],
      artifacts: [null, { taskId: 'ok', files: 'not-an-array' }],
    },
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.error, undefined);
});

test('scanning never mutates the caller snapshot and never reads the ambient clock', () => {
  const snapshot = workspace([task('a', { deadline: '2026-05-19', blockedReason: '等待', updatedAt: daysAgo(9) })], {
    logs: [{ id: 'l1', taskId: 'a', text: '记录', at: daysAgo(1) }],
  });
  const before = clone(snapshot);
  const realNow = Date.now;
  Date.now = () => { throw new Error('radar must not read Date.now()'); };
  try {
    const result = scan({ workspace: snapshot });
    assert.ok(result.items.length >= 1);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(snapshot, before);
});

test('constructor options tune thresholds and are validated defensively', () => {
  const custom = new IssueRadar({ dueSoonDays: 0, blockedLongDays: 30, limit: 1, noRecordDays: 'x' });
  assert.equal(custom.options.dueSoonDays, 0);
  assert.equal(custom.options.blockedLongDays, 30);
  assert.equal(custom.options.limit, 1);
  assert.equal(custom.options.noRecordDays, 14, '非法阈值应回退到默认值');
  // 2 天后到期，但 dueSoonDays 已被调成 0，因此不再提前提醒。
  assert.deepEqual(custom.scan({ workspace: workspace([task('a', { deadline: '2026-05-21' })]), nowMs: NOW }).items, []);
  // 阻塞 40 天，超过被调到 30 天的阈值；limit 为 1 时只返回最高优先级的一条。
  const blocked = custom.scan({ workspace: workspace([task('b', { blockedReason: '等待', updatedAt: daysAgo(40) })]), nowMs: NOW });
  assert.deepEqual(kinds(blocked), ['blocked-long']);
  assert.equal(blocked.items.length, 1);
  assert.equal(blocked.total, 2);
  // 默认实例仍按 3 天 / 7 天 / 14 天 / 50 条执行。
  assert.deepEqual({ ...radar.options }, { limit: 50, dueSoonDays: 3, dueSoonHighDays: 1, blockedLongDays: 7, noRecordDays: 14 });
});

test('scanIssues one-shot helper matches the instance result', () => {
  const input = {
    workspace: workspace([
      task('a', { deadline: '2026-05-19' }),
      task('b', { status: 'done', completedAt: daysAgo(3) }),
    ]),
    nowMs: NOW,
    state: { dismissed: { 'done-no-artifact:b': true } },
  };
  assert.deepEqual(scanIssues(input), radar.scan(input));
  assert.equal(scanIssues(input).hidden.dismissed, 1);
});

test('an empty but valid workspace returns an empty, well-formed report', () => {
  const result = scan({ workspace: workspace([]) });
  assert.deepEqual(result, {
    items: [],
    counts: { byKind: {}, bySeverity: {} },
    hidden: { snoozed: 0, dismissed: 0 },
    total: 0,
    truncated: false,
  });
});

test('issue ids are stable across scans and unique within one report', () => {
  const input = {
    workspace: workspace([
      task('a', { deadline: '2026-05-19', blockedReason: '等待', updatedAt: daysAgo(9) }),
      task('b', { updatedAt: daysAgo(30) }),
    ]),
    nowMs: NOW,
    inbox: 1,
  };
  const first = radar.scan(input);
  const second = radar.scan(input);
  assert.deepEqual(ids(first), ids(second));
  assert.equal(new Set(ids(first)).size, ids(first).length);
  assert.ok(ids(first).includes('overdue:a'));
  assert.ok(ids(first).includes('blocked-long:a'));
  assert.ok(ids(first).includes('no-record:b'));
  assert.ok(ids(first).includes('pending-receipt:inbox'));
});

let passed = 0;
// Guard the embedding contract: client.js shares one top-level scope with this
// module, so a clashing declaration would break the whole plugin at load time.
test('radar.js 顶层声明不与 client.js 冲突（嵌入后共享同一作用域）', () => {
  const mine = readFileSync(new URL('./radar.js', import.meta.url), 'utf8');
  const raw = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  // This module's own text sits inside its generated region; ignore generated
  // regions so the module is not reported as clashing with itself.
  const client = raw.replace(/^[ \t]*\/\/ @generated [\w.-]+ begin[\s\S]*?^[ \t]*\/\/ @generated [\w.-]+ end[ \t]*$/gm, '');
  const ownTop = new Set([...mine.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const clientAny = new Set([...client.matchAll(/^[ \t]*(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const clash = [...ownTop].filter((name) => clientAny.has(name)).sort();
  assert.ok(ownTop.size > 0);
  assert.deepEqual(clash, [], '与 client.js 重名的顶层声明：' + clash.join(', '));
});

let failed = 0;
for (const { name, fn } of tests.filter((entry) => !process.argv[2] || entry.name.includes(process.argv[2]))) {
  try {
    await fn();
    console.log('PASS ' + name);
    passed++;
  } catch (error) {
    console.error('FAIL ' + name + '\n' + error.stack);
    failed++;
  }
}
console.log(`RADAR: ${passed} passed, ${failed} failed`);
if (failed || !passed) process.exitCode = 1;
