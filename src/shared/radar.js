// Canonical browser-safe source; the build may embed this class into client.js.
// Constraints kept on purpose: no import/require, no Node APIs, no browser
// globals and no ambient clock. Every time value arrives through `nowMs` or an
// ISO string, and nothing is written back into the workspace snapshot.
// Internal helpers carry a `radar` prefix so a single-file embedding cannot
// collide with unrelated top-level names in the shipped client.
//
// Contract:
//   const radar = new IssueRadar(options?);
//   radar.scan({ workspace, nowMs, state?, inbox?, limit? })
//     -> { items, counts: { byKind, bySeverity }, hidden: { snoozed, dismissed },
//          total, truncated, error? }
//   scan(input, options?) is the same thing as a one-shot function.
//
// A missing record is only ever reported as 「暂无近期记录」. The engine never
// turns absence of data into a claim about whether work happened.

// Only two top-level exports on purpose: a single-file embedding can strip
// `export class` / `export function` without touching any other statement.
const RADAR_KINDS = Object.freeze([
  'overdue',
  'deadline-soon',
  'blocked-long',
  'no-record',
  'pending-receipt',
  'done-no-artifact',
]);

const DEFAULT_RADAR_OPTIONS = Object.freeze({
  limit: 50,
  dueSoonDays: 3,
  dueSoonHighDays: 1,
  blockedLongDays: 7,
  noRecordDays: 14,
});

const RADAR_DAY_MS = 24 * 60 * 60 * 1000;
const RADAR_SEVERITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });
const RADAR_MAX_REASON = 40;
const RADAR_DEADLINE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?)?$/;

function radarIsObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function radarText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function radarPad2(value) {
  return (value < 10 ? '0' : '') + value;
}

function radarIsoOf(ms) {
  return new Date(ms).toISOString();
}

function radarLocalParts(ms) {
  const date = new Date(ms);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() };
}

function radarFormatDay(ms) {
  const parts = radarLocalParts(ms);
  return parts.year + '年' + parts.month + '月' + parts.day + '日';
}

function radarFormatDayTime(ms) {
  const parts = radarLocalParts(ms);
  return radarFormatDay(ms) + ' ' + radarPad2(parts.hour) + ':' + radarPad2(parts.minute);
}

// A date-only deadline means the end of that local day, which matches how the
// shipped client already labels and counts due/overdue tasks.
function radarFormatDeadline(due) {
  return due.dateOnly ? radarFormatDay(due.ms) + '（当日 23:59 截止）' : radarFormatDayTime(due.ms);
}

function radarFormatReason(reason) {
  return reason.length > RADAR_MAX_REASON ? reason.slice(0, RADAR_MAX_REASON) + '…' : reason;
}

function radarSameLocalDay(date, year, month, day) {
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// Whole local-calendar days between two instants. Built on Date.UTC so a
// daylight-saving shift cannot turn "3 days" into 2.958 or 3.042 days.
function radarDayIndex(ms) {
  const parts = radarLocalParts(ms);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / RADAR_DAY_MS);
}

// Returns { ms, dateOnly, source } or null. Never reads the clock, so tests and
// callers stay in control of "now". Unparseable deadlines simply yield no signal
// instead of a fabricated one.
function radarParseDeadline(value) {
  const source = radarText(value);
  if (!source) return null;
  const match = RADAR_DEADLINE_PATTERN.exec(source);
  if (!match) {
    // Explicit timezone designators keep the platform meaning of the instant.
    const ms = Date.parse(source);
    return Number.isFinite(ms) ? { ms, dateOnly: false, source } : null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (match[4] == null) {
    const date = new Date(year, month - 1, day, 23, 59, 59, 999);
    if (!radarSameLocalDay(date, year, month, day)) return null;
    return { ms: date.getTime(), dateOnly: true, source };
  }
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] == null ? 0 : Number(match[6]);
  const milli = match[7] == null ? 0 : Number(match[7]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second, milli);
  if (!radarSameLocalDay(date, year, month, day)) return null;
  return { ms: date.getTime(), dateOnly: false, source };
}

function radarParseTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const source = radarText(value);
  if (!source) return null;
  const ms = Date.parse(source);
  return Number.isFinite(ms) ? ms : null;
}

function radarIsDeleted(task) {
  const value = task.deletedAt;
  return value !== undefined && value !== null && value !== '' && value !== false;
}

// `status` is authoritative; completedAt is only consulted when status is absent
// or unknown, so a reopened task is never reclassified as done.
function radarIsDone(task) {
  if (task.status === 'done') return true;
  if (task.status === 'dropped') return false;
  if (task.status === 'todo') return false;
  return radarText(task.completedAt) !== '';
}

function radarActionableTask(task) {
  return radarIsObject(task) && radarText(task.id) !== '' && !radarIsDeleted(task)
    && task.status !== 'dropped' && !radarIsDone(task);
}

function radarTaskTitle(task) {
  return radarText(task.title) || '（未命名任务）';
}

function radarIndexByTask(records) {
  const map = new Map();
  for (const record of records) {
    if (!radarIsObject(record)) continue;
    const taskId = radarText(record.taskId);
    if (!taskId) continue;
    if (!map.has(taskId)) map.set(taskId, []);
    map.get(taskId).push(record);
  }
  return map;
}

function radarHasTextList(value) {
  return Array.isArray(value) && value.some((entry) => radarText(entry) !== '');
}

// A 成果引用 needs a file or a link. A summary alone describes the work but does
// not point at anything, so it does not count as a reference here.
function radarHasReference(artifact) {
  return radarIsObject(artifact) && (radarHasTextList(artifact.files) || radarHasTextList(artifact.links));
}

function radarNormalizeInbox(inbox) {
  if (inbox === undefined || inbox === null) return { count: 0, items: [] };
  if (typeof inbox === 'number') {
    return { count: Number.isFinite(inbox) ? Math.max(0, Math.floor(inbox)) : 0, items: [] };
  }
  if (Array.isArray(inbox)) return { count: inbox.length, items: inbox.filter(radarIsObject) };
  if (!radarIsObject(inbox)) return { count: 0, items: [] };
  if (Array.isArray(inbox.items)) return { count: inbox.items.length, items: inbox.items.filter(radarIsObject) };
  for (const key of ['pending', 'count', 'length']) {
    const value = inbox[key];
    if (typeof value === 'number' && Number.isFinite(value)) return { count: Math.max(0, Math.floor(value)), items: [] };
  }
  return { count: 0, items: [] };
}

// Invalid user state must never hide a real issue: an unparseable snooze value or
// a non-true dismiss flag is ignored instead of trusted.
function radarNormalizeState(state) {
  const snoozed = new Map();
  const dismissed = new Set();
  if (radarIsObject(state)) {
    if (radarIsObject(state.snoozed)) {
      for (const [id, until] of Object.entries(state.snoozed)) {
        if (!radarText(id)) continue;
        const untilMs = radarParseTimestamp(until);
        if (untilMs === null) continue;
        snoozed.set(id, untilMs);
      }
    }
    if (radarIsObject(state.dismissed)) {
      for (const [id, flag] of Object.entries(state.dismissed)) {
        if (radarText(id) && flag === true) dismissed.add(id);
      }
    }
  }
  return { snoozed, dismissed };
}

function radarVisibility(issueId, state, nowMs) {
  if (state.dismissed.has(issueId)) return 'dismissed';
  if (state.snoozed.has(issueId) && nowMs < state.snoozed.get(issueId)) return 'snoozed';
  return 'visible';
}

function radarResolveLimit(requested, fallback) {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 0) return Math.floor(requested);
  return fallback;
}

function radarPushIssue(out, item, sortAt) {
  out.push({ item, sortAt: Number.isFinite(sortAt) ? sortAt : 0, index: out.length });
}

// Two deliberately different granularities, because deadlines come in two forms:
//  * A date-only deadline belongs to a calendar day, so "已逾期 3 天" means three
//    calendar days past that day (what a user sees on a calendar). Subtracting
//    instants would claim 2 days at 10:00 and read as if time had gone backwards.
//  * A deadline with an explicit time is an instant, so whole elapsed days are the
//    honest unit and anything under a day is reported in hours.
// In both cases the number used in the sentence and in evidence is one variable.
function radarElapsedDays(elapsedMs) {
  return Math.floor(Math.max(0, elapsedMs) / RADAR_DAY_MS);
}

function radarElapsedHours(elapsedMs) {
  return Math.floor(Math.max(0, elapsedMs) / (60 * 60 * 1000));
}

function radarOverdueWording(dueDays, dueHours) {
  if (dueDays >= 1) return '已逾期 ' + dueDays + ' 天';
  // Rounding 30 minutes up to "1 小时" would overstate it, so state the floor.
  return dueHours >= 1 ? '已逾期 ' + dueHours + ' 小时' : '已过截止时间但不足 1 小时';
}

// For "how long has it been" facts (blocked / no record) the exact elapsed span is
// what the threshold was checked against, so the sentence mirrors that unit.
function radarElapsedWording(elapsedMs) {
  const days = radarElapsedDays(elapsedMs);
  if (days >= 1) return days + ' 天';
  const hours = radarElapsedHours(elapsedMs);
  return hours >= 1 ? hours + ' 小时' : '不足 1 小时';
}

function radarEmptyResult(error) {
  return {
    items: [],
    counts: { byKind: {}, bySeverity: {} },
    hidden: { snoozed: 0, dismissed: 0 },
    total: 0,
    truncated: false,
    error,
  };
}

function radarCollectDeadline(prepared, options, out) {
  const dueSoonDays = Math.max(0, Math.floor(options.dueSoonDays));
  const highDays = Math.min(Math.max(0, Math.floor(options.dueSoonHighDays)), dueSoonDays);
  const nowDay = radarDayIndex(prepared.nowMs);
  for (const task of prepared.tasks) {
    if (!radarActionableTask(task)) continue;
    const due = radarParseDeadline(task.deadline);
    if (!due) continue;
    const remainingMs = due.ms - prepared.nowMs;
    const dueDay = radarDayIndex(due.ms);
    // Calendar-day distance, so "剩余 3 天" means three calendar days rather than
    // 72 hours, and a date-only deadline "today" counts as day 0.
    let remainingDays = dueDay - nowDay;
    if (remainingMs < 0) remainingDays = -Math.max(1, nowDay - dueDay);
    const status = typeof task.status === 'string' ? task.status : null;
    const evidence = {
      taskId: task.id, status, deadline: due.source, dueAt: radarIsoOf(due.ms),
      dateOnly: due.dateOnly, remainingMs, remainingDays,
    };
    if (remainingMs < 0) {
      // Date-only: calendar days past the deadline day. Timed: whole elapsed days,
      // falling back to hours so "已逾期 1 天" is never claimed at 30 minutes.
      const overdueDays = due.dateOnly ? Math.max(1, nowDay - dueDay) : radarElapsedDays(-remainingMs);
      const overdueHours = radarElapsedHours(-remainingMs);
      radarPushIssue(out, {
        id: 'overdue:' + task.id,
        kind: 'overdue',
        severity: 'high',
        taskId: task.id,
        title: radarTaskTitle(task),
        fact: '截止时间为 ' + radarFormatDeadline(due) + '，' + radarOverdueWording(overdueDays, overdueHours)
          + '，任务仍未完成。',
        evidence: { ...evidence, overdueDays, overdueHours },
        actions: ['open', 'snooze', 'dismiss'],
      }, due.ms);
      continue;
    }
    if (remainingDays > dueSoonDays) continue;
    const severity = remainingDays <= highDays ? 'high' : 'medium';
    const fact = '截止时间为 ' + radarFormatDeadline(due) + '，'
      + (remainingDays === 0
        ? '今天到期，任务仍未完成。'
        : '还剩 ' + remainingDays + ' 天，任务未完成。');
    radarPushIssue(out, {
      id: 'deadline-soon:' + task.id,
      kind: 'deadline-soon',
      severity,
      taskId: task.id,
      title: radarTaskTitle(task),
      fact,
      evidence,
      actions: ['open', 'snooze', 'dismiss'],
    }, due.ms);
  }
}

function radarCollectBlocked(prepared, options, out) {
  const threshold = Math.max(0, options.blockedLongDays) * RADAR_DAY_MS;
  for (const task of prepared.tasks) {
    if (!radarActionableTask(task)) continue;
    const reason = radarText(task.blockedReason);
    if (!reason) continue;
    const updatedMs = radarParseTimestamp(task.updatedAt);
    if (updatedMs === null) continue; // No traceable update time: assert nothing.
    const elapsed = prepared.nowMs - updatedMs;
    if (elapsed < threshold) continue;
    const elapsedDays = radarElapsedDays(elapsed);
    radarPushIssue(out, {
      id: 'blocked-long:' + task.id,
      kind: 'blocked-long',
      severity: 'medium',
      taskId: task.id,
      title: radarTaskTitle(task),
      fact: '任务仍标记为阻塞，阻塞原因：「' + radarFormatReason(reason) + '」；最近一次更新为 '
        + radarFormatDay(updatedMs) + '，距今 ' + radarElapsedWording(elapsed) + '。',
      evidence: {
        taskId: task.id,
        status: typeof task.status === 'string' ? task.status : null,
        blockedReason: reason,
        updatedAt: radarIsoOf(updatedMs),
        daysSinceUpdate: elapsedDays,
      },
      actions: ['open', 'add-record', 'snooze', 'dismiss'],
    }, updatedMs);
  }
}

function radarCollectNoRecord(prepared, options, out) {
  const threshold = Math.max(0, options.noRecordDays) * RADAR_DAY_MS;
  for (const task of prepared.tasks) {
    if (!radarActionableTask(task)) continue;
    const updatedMs = radarParseTimestamp(task.updatedAt);
    let lastLogMs = null;
    for (const log of prepared.logs.get(task.id) || []) {
      const at = radarParseTimestamp(log.at);
      if (at !== null && (lastLogMs === null || at > lastLogMs)) lastLogMs = at;
    }
    let lastArtifactMs = null;
    for (const artifact of prepared.artifacts.get(task.id) || []) {
      const at = radarParseTimestamp(artifact.at);
      if (at !== null && (lastArtifactMs === null || at > lastArtifactMs)) lastArtifactMs = at;
    }
    const known = [updatedMs, lastLogMs, lastArtifactMs].filter((value) => value !== null);
    // With no usable time at all there is nothing to state as a fact.
    if (!known.length) continue;
    const lastMs = Math.max(...known);
    const elapsed = prepared.nowMs - lastMs;
    if (elapsed < threshold) continue;
    const elapsedDays = radarElapsedDays(elapsed);
    radarPushIssue(out, {
      id: 'no-record:' + task.id,
      kind: 'no-record',
      severity: 'low',
      taskId: task.id,
      title: radarTaskTitle(task),
      fact: '暂无近期记录：最近一次记录或更新为 ' + radarFormatDay(lastMs) + '，距今 '
        + radarElapsedWording(elapsed) + '；只表示缺少记录，不推断工作状态。',
      evidence: {
        taskId: task.id,
        updatedAt: updatedMs === null ? null : radarIsoOf(updatedMs),
        lastLogAt: lastLogMs === null ? null : radarIsoOf(lastLogMs),
        lastArtifactAt: lastArtifactMs === null ? null : radarIsoOf(lastArtifactMs),
        lastActivityAt: radarIsoOf(lastMs),
        daysSinceActivity: elapsedDays,
      },
      actions: ['open', 'add-record', 'snooze', 'dismiss'],
    }, lastMs);
  }
}

function radarCollectPendingReceipt(prepared, out) {
  const { count, items } = prepared.inbox;
  if (!(count > 0)) return;
  let oldestMs = null;
  let latestMs = null;
  for (const item of items) {
    const at = radarParseTimestamp(item.receivedAt);
    if (at === null) continue;
    if (oldestMs === null || at < oldestMs) oldestMs = at;
    if (latestMs === null || at > latestMs) latestMs = at;
  }
  radarPushIssue(out, {
    id: 'pending-receipt:inbox',
    kind: 'pending-receipt',
    severity: 'medium',
    taskId: null,
    title: '有 ' + count + ' 条回传待确认',
    fact: '回传收件箱有 ' + count + ' 条回传等待确认'
      + (oldestMs === null ? '。' : '；最早一条接收于 ' + radarFormatDay(oldestMs) + '。'),
    evidence: {
      pendingCount: count,
      oldestReceivedAt: oldestMs === null ? null : radarIsoOf(oldestMs),
      latestReceivedAt: latestMs === null ? null : radarIsoOf(latestMs),
    },
    actions: ['open', 'snooze', 'dismiss'],
  }, oldestMs === null ? 0 : oldestMs);
}

function radarCollectDoneNoArtifact(prepared, out) {
  for (const task of prepared.tasks) {
    if (!radarIsObject(task) || radarText(task.id) === '') continue;
    if (radarIsDeleted(task) || !radarIsDone(task)) continue;
    const artifacts = prepared.artifacts.get(task.id) || [];
    if (artifacts.some((artifact) => radarHasReference(artifact))) continue;
    const completedMs = radarParseTimestamp(task.completedAt);
    const updatedMs = radarParseTimestamp(task.updatedAt);
    const sortMs = completedMs !== null ? completedMs : (updatedMs !== null ? updatedMs : 0);
    radarPushIssue(out, {
      id: 'done-no-artifact:' + task.id,
      kind: 'done-no-artifact',
      severity: 'low',
      taskId: task.id,
      title: radarTaskTitle(task),
      fact: '任务已完成' + (completedMs === null ? '' : '（' + radarFormatDay(completedMs) + '）')
        + '，但暂无成果引用：没有记录任何文件或链接。',
      evidence: {
        taskId: task.id,
        status: typeof task.status === 'string' ? task.status : 'done',
        completedAt: completedMs === null ? null : radarIsoOf(completedMs),
        updatedAt: updatedMs === null ? null : radarIsoOf(updatedMs),
        artifactCount: artifacts.length,
        referenceCount: 0,
      },
      actions: ['open', 'add-record', 'snooze', 'dismiss'],
    }, sortMs);
  }
}

// Deterministic order: severity first, then the fixed kind order, then the
// underlying timestamps, then input order. Two identical inputs always produce
// the same list, which keeps rendering and tests stable.
function radarCompareEntries(left, right) {
  const severity = RADAR_SEVERITY_RANK[left.item.severity] - RADAR_SEVERITY_RANK[right.item.severity];
  if (severity) return severity;
  const kind = RADAR_KINDS.indexOf(left.item.kind) - RADAR_KINDS.indexOf(right.item.kind);
  if (kind) return kind;
  if (left.sortAt !== right.sortAt) return left.sortAt - right.sortAt;
  return left.index - right.index;
}

export class IssueRadar {
  constructor(options = {}) {
    const source = radarIsObject(options) ? options : {};
    const resolved = { ...DEFAULT_RADAR_OPTIONS };
    for (const key of Object.keys(DEFAULT_RADAR_OPTIONS)) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) resolved[key] = value;
    }
    resolved.limit = Math.floor(resolved.limit);
    this.options = Object.freeze(resolved);
  }

  scan(input) {
    const prepared = this._prepare(input);
    if (prepared.error) return radarEmptyResult(prepared.error);
    const candidates = [];
    radarCollectDeadline(prepared, this.options, candidates);
    radarCollectBlocked(prepared, this.options, candidates);
    radarCollectNoRecord(prepared, this.options, candidates);
    radarCollectPendingReceipt(prepared, candidates);
    radarCollectDoneNoArtifact(prepared, candidates);
    const counts = { byKind: {}, bySeverity: {} };
    const hidden = { snoozed: 0, dismissed: 0 };
    const visible = [];
    const seen = new Set();
    for (const entry of candidates) {
      const issue = entry.item;
      if (seen.has(issue.id)) continue; // One issue per kind per task.
      seen.add(issue.id);
      const visibility = radarVisibility(issue.id, prepared.state, prepared.nowMs);
      if (visibility === 'dismissed') { hidden.dismissed += 1; continue; }
      if (visibility === 'snoozed') { hidden.snoozed += 1; continue; }
      visible.push(entry);
    }
    // Counts describe every visible issue; the cap only trims the returned list.
    for (const entry of visible) {
      const kind = entry.item.kind;
      const severity = entry.item.severity;
      counts.byKind[kind] = (counts.byKind[kind] || 0) + 1;
      counts.bySeverity[severity] = (counts.bySeverity[severity] || 0) + 1;
    }
    visible.sort(radarCompareEntries);
    const returned = visible.slice(0, prepared.limit);
    return {
      items: returned.map((entry) => entry.item),
      counts,
      hidden,
      total: visible.length,
      truncated: visible.length > returned.length,
    };
  }

  _prepare(input) {
    // Any unusable input collapses to one documented code so the caller has a
    // single branch to render instead of guessing at several error strings.
    if (!radarIsObject(input)) return { error: 'invalid-workspace' };
    const workspace = input.workspace;
    if (!radarIsObject(workspace)) return { error: 'invalid-workspace' };
    if (!Array.isArray(workspace.tasks) || !Array.isArray(workspace.logs) || !Array.isArray(workspace.artifacts)) {
      return { error: 'invalid-workspace' };
    }
    const nowMs = input.nowMs;
    // The clock is mandatory: without it no threshold can be stated as a fact.
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return { error: 'invalid-workspace' };
    return {
      tasks: workspace.tasks,
      logs: radarIndexByTask(workspace.logs),
      artifacts: radarIndexByTask(workspace.artifacts),
      nowMs,
      inbox: radarNormalizeInbox(input.inbox),
      state: radarNormalizeState(input.state),
      limit: radarResolveLimit(input.limit, this.options.limit),
    };
  }
}

// One-shot form for callers that do not want to keep an instance around.
export function scanIssues(input, options) {
  return new IssueRadar(options).scan(input);
}
