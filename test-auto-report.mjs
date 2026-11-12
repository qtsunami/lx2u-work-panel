import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_AUTO_SETTINGS,
  BACKOFF_MS,
  normalizeAutoSettings,
  normalizeAutoState,
  nextDue,
  dueGeneration,
  periodKeyFor,
  shouldSkipForIdempotency,
  nextBackoff,
  timeZoneOffsetMinutes,
  localDateTimeFor,
  periodForDate,
} from './auto-report.js';

// 所有时间点都是显式传入的常量：本套测试不读取系统时钟，也不依赖宿主时区。
const SH = 'Asia/Shanghai';
/** 某地本地时间 → 毫秒时间戳（测试里改用显式偏移手算，避免依赖宿主时区）。 */
const sh = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm);
const utc = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ok ' + name); }
  catch (error) { failed += 1; console.error('  FAIL ' + name + '\n    ' + (error && error.message)); }
}

const settings = (patch = {}) => ({ ...DEFAULT_AUTO_SETTINGS, enabled: true, ...patch });
const H = 3600000;
const M = 60000;

console.log('auto-report 默认与归一化');

test('默认设置默认关闭', () => {
  assert.equal(DEFAULT_AUTO_SETTINGS.enabled, false);
  assert.equal(normalizeAutoSettings(undefined).enabled, false);
  assert.equal(normalizeAutoSettings({}).enabled, false);
});

test('默认设置不可被外部改写（冻结）', () => {
  assert.equal(Object.isFrozen(DEFAULT_AUTO_SETTINGS), true);
  assert.equal(Object.isFrozen(BACKOFF_MS), true);
});

test('非对象输入回落到默认值', () => {
  for (const raw of [null, 42, 'x', true, [], () => {}]) {
    const value = normalizeAutoSettings(raw);
    assert.deepEqual(value, { ...DEFAULT_AUTO_SETTINGS });
  }
});

test("enabled 不被放宽：'true' / 1 / 'yes' / [] 都不是 true", () => {
  for (const raw of [{ enabled: 'true' }, { enabled: 1 }, { enabled: 'yes' }, { enabled: [] }, { enabled: {} }, { enabled: null }]) {
    assert.equal(normalizeAutoSettings(raw).enabled, false);
  }
  assert.equal(normalizeAutoSettings({ enabled: true }).enabled, true);
});

test('非法 kind 回落 week，month 保留', () => {
  assert.equal(normalizeAutoSettings({ kind: 'day' }).kind, 'week');
  assert.equal(normalizeAutoSettings({ kind: 'WEEK' }).kind, 'week');
  assert.equal(normalizeAutoSettings({ kind: 'month' }).kind, 'month');
});

test('非法 timeOfDay 回落 18:00，合法值规范化补零', () => {
  assert.equal(normalizeAutoSettings({ timeOfDay: '25:00' }).timeOfDay, '18:00');
  assert.equal(normalizeAutoSettings({ timeOfDay: '18:60' }).timeOfDay, '18:00');
  assert.equal(normalizeAutoSettings({ timeOfDay: 'abc' }).timeOfDay, '18:00');
  assert.equal(normalizeAutoSettings({ timeOfDay: '09:05' }).timeOfDay, '09:05');
  assert.equal(normalizeAutoSettings({ timeOfDay: '9:5' }).timeOfDay, '18:00', '缺前导零的写法视为非法，回落默认');
  assert.equal(normalizeAutoSettings({ timeOfDay: '23:59' }).timeOfDay, '23:59');
});

test('weekday / dayOfMonth / maxPerRun / minEvidence 越界回落且不放宽', () => {
  assert.equal(normalizeAutoSettings({ weekday: 7 }).weekday, 5);
  assert.equal(normalizeAutoSettings({ weekday: -1 }).weekday, 5);
  assert.equal(normalizeAutoSettings({ weekday: 0 }).weekday, 0);
  assert.equal(normalizeAutoSettings({ dayOfMonth: 0 }).dayOfMonth, 1);
  assert.equal(normalizeAutoSettings({ dayOfMonth: 32 }).dayOfMonth, 1);
  assert.equal(normalizeAutoSettings({ dayOfMonth: 31.5 }).dayOfMonth, 1);
  assert.equal(normalizeAutoSettings({ maxPerRun: 0 }).maxPerRun, 1);
  assert.equal(normalizeAutoSettings({ maxPerRun: 999 }).maxPerRun, 1);
  assert.equal(normalizeAutoSettings({ minEvidence: -1 }).minEvidence, 1);
  assert.equal(normalizeAutoSettings({ minEvidence: 0 }).minEvidence, 0);
});

test('model / scope 非法回落，不注入控制字符', () => {
  assert.equal(normalizeAutoSettings({ model: 7 }).model, null);
  assert.equal(normalizeAutoSettings({ model: '  ' }).model, null);
  assert.equal(normalizeAutoSettings({ model: 'deepseek-v4' }).model, 'deepseek-v4');
  assert.equal(normalizeAutoSettings({ scope: '\u0000all' }).scope, 'all');
  assert.equal(normalizeAutoSettings({ scope: 'project:abc' }).scope, 'project:abc');
});

test('状态归一化：垃圾输入得到保守默认值', () => {
  const state = normalizeAutoState({ lastRunAt: 'x', lastPeriodKey: 'nope', attempts: -3, evidenceCount: -1, generatedKeys: [1, {}, 'bad', '2026-11-02_2026-11-08'] });
  assert.equal(state.lastRunAt, null);
  assert.equal(state.lastPeriodKey, null);
  assert.equal(state.attempts, 0);
  assert.equal(state.evidenceCount, 0);
  assert.deepEqual(state.generatedKeys, ['2026-11-02_2026-11-08']);
  assert.deepEqual(normalizeAutoState(null).generatedKeys, []);
});

console.log('周期口径（与 client.js 周报/月报一致）');

test('周报：周一为起点、周日结束', () => {
  assert.deepEqual(periodForDate('week', '2026-11-09'), { start: '2026-11-09', end: '2026-11-15' });
  assert.deepEqual(periodForDate('week', '2026-11-12'), { start: '2026-11-09', end: '2026-11-15' });
  assert.deepEqual(periodForDate('week', '2026-11-15'), { start: '2026-11-09', end: '2026-11-15' });
  assert.deepEqual(periodForDate('week', '2026-11-16'), { start: '2026-11-16', end: '2026-11-22' });
});

test('周报：周日属于上一周而不是下一周', () => {
  const sunday = periodForDate('week', '2026-11-15');
  const monday = periodForDate('week', '2026-11-16');
  assert.equal(sunday.end, '2026-11-15');
  assert.notEqual(periodKeyFor('week', '2026-11-15', SH), periodKeyFor('week', '2026-11-16', SH));
  assert.equal(monday.start, '2026-11-16');
});

test('月报：自然月 1 日到月末', () => {
  assert.deepEqual(periodForDate('month', '2026-11-12'), { start: '2026-11-01', end: '2026-11-30' });
  assert.deepEqual(periodForDate('month', '2026-02-10'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(periodForDate('month', '2028-02-10'), { start: '2028-02-01', end: '2028-02-29' });
  assert.deepEqual(periodForDate('month', '2026-12-31'), { start: '2026-12-01', end: '2026-12-31' });
});

test('周期键复刻 client.js 的 start_end 格式', () => {
  assert.equal(periodKeyFor('week', '2026-11-12', SH), '2026-11-09_2026-11-15');
  assert.equal(periodKeyFor('month', '2026-11-12', SH), '2026-11-01_2026-11-30');
  assert.match(periodKeyFor('week', '2026-11-12', SH), /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/);
});

test('同周期内不同日期得到同一个键', () => {
  const keys = ['2026-11-09', '2026-11-11', '2026-11-15'].map((d) => periodKeyFor('week', d, SH));
  assert.equal(new Set(keys).size, 1);
  const monthKeys = ['2026-11-01', '2026-11-30'].map((d) => periodKeyFor('month', d, SH));
  assert.equal(new Set(monthKeys).size, 1);
});

test('跨年周：2026-01-01 落在 2025-12-29 起的那一周', () => {
  assert.equal(periodKeyFor('week', '2026-01-01', SH), '2025-12-29_2026-01-04');
  assert.equal(periodKeyFor('week', '2026-01-04', SH), '2025-12-29_2026-01-04');
  assert.equal(periodKeyFor('week', '2026-01-05', SH), '2026-01-05_2026-01-11');
});

test('跨年月报边界：12 月 31 日与 1 月 1 日属于不同月份', () => {
  assert.equal(periodKeyFor('month', '2025-12-31', SH), '2025-12-01_2025-12-31');
  assert.equal(periodKeyFor('month', '2026-01-01', SH), '2026-01-01_2026-01-31');
});

test('带偏移的瞬时按目标时区判定周期（UTC 日期与本地日期不同）', () => {
  // 2026-10-31T20:00Z = 上海 2026-11-01 04:00 → 属 11 月
  assert.equal(periodKeyFor('month', '2026-10-31T20:00:00Z', SH), '2026-11-01_2026-11-30');
  // 2026-11-12T23:30Z = 上海 2026-11-13 07:30 → 属 11-09 那一周
  assert.equal(periodKeyFor('week', '2026-11-12T23:30:00Z', SH), '2026-11-09_2026-11-15');
  assert.equal(periodKeyFor('week', utc(2026, 11, 12, 23, 30), SH), '2026-11-09_2026-11-15');
  assert.equal(periodKeyFor('week', new Date(Date.UTC(2026, 10, 12, 23, 30)), SH), '2026-11-09_2026-11-15');
});

test('非法输入返回 null 而不是猜测', () => {
  assert.equal(periodKeyFor('day', '2026-11-12', SH), null);
  assert.equal(periodKeyFor('week', '2026-02-30', SH), null);
  assert.equal(periodKeyFor('week', '2026-13-01', SH), null);
  assert.equal(periodKeyFor('week', 'not-a-date', SH), null);
  assert.equal(periodKeyFor('week', '2026-11-12T10:00:00', SH), null, '无显式偏移的瞬时依赖宿主时区，必须拒绝');
  assert.equal(periodKeyFor('week', '2026-11-12', 'Mars/Olympus'), null);
  assert.equal(periodKeyFor('week', '2026-11-12', ''), null);
  assert.equal(periodKeyFor('week', {}, SH), null);
});

test('固定偏移时区写法可用，越界偏移被拒绝', () => {
  assert.equal(periodKeyFor('week', '2026-11-12', '+08:00'), '2026-11-09_2026-11-15');
  assert.equal(periodKeyFor('week', '2026-11-12', 'UTC+8'), '2026-11-09_2026-11-15');
  assert.equal(periodKeyFor('week', '2026-11-12', 'UTC'), '2026-11-09_2026-11-15');
  assert.equal(timeZoneOffsetMinutes('Asia/Shanghai', utc(2026, 11, 12, 0, 0)), 480);
  assert.equal(timeZoneOffsetMinutes('UTC+15:00', 0), null);
  assert.equal(timeZoneOffsetMinutes('Nowhere/Special', 0), null);
});

test('未知时区明确返回 null（本地字段与偏移都不可判定）', () => {
  assert.equal(localDateTimeFor('Pacific/Chatham', utc(2026, 11, 12, 0, 0)), null);
  assert.equal(localDateTimeFor('Asia/Shanghai', NaN), null);
});

console.log('nextDue');

test('默认关闭时 nextDue 必须是 null', () => {
  assert.equal(nextDue(DEFAULT_AUTO_SETTINGS, sh(2026, 11, 11, 12, 0), SH), null);
  assert.equal(nextDue({ enabled: false }, sh(2026, 11, 11, 12, 0), SH), null);
  assert.equal(nextDue(undefined, sh(2026, 11, 11, 12, 0), SH), null);
});

test('周报：从周三看，下次到期是本周五 18:00（上海）', () => {
  const due = nextDue(settings(), sh(2026, 11, 11, 12, 0), SH);
  assert.equal(due, utc(2026, 11, 13, 10, 0));
  assert.equal(due, sh(2026, 11, 13, 18, 0));
});

test('周报：本周五已过 18:00，下次到期是下周五', () => {
  assert.equal(nextDue(settings(), sh(2026, 11, 13, 19, 0), SH), sh(2026, 11, 20, 18, 0));
  assert.equal(nextDue(settings(), sh(2026, 11, 13, 18, 0), SH), sh(2026, 11, 20, 18, 0), '恰好到期的瞬间视为已到，返回下一次');
});

test('周报：timeOfDay 为 00:00 时当天零点即到期', () => {
  assert.equal(nextDue(settings({ timeOfDay: '00:00' }), sh(2026, 11, 12, 23, 0), SH), sh(2026, 11, 13, 0, 0));
});

test('月报：本月 1 日已过，下次到期是下月 1 日', () => {
  const due = nextDue(settings({ kind: 'month', dayOfMonth: 1 }), sh(2026, 11, 12, 12, 0), SH);
  assert.equal(due, sh(2026, 12, 1, 18, 0));
  assert.equal(nextDue(settings({ kind: 'month', dayOfMonth: 1 }), sh(2026, 10, 15, 9, 0), SH), sh(2026, 11, 1, 18, 0));
});

test('月报：dayOfMonth=31 在小月取当月最后一天', () => {
  assert.equal(nextDue(settings({ kind: 'month', dayOfMonth: 31 }), sh(2026, 2, 10, 12, 0), SH), sh(2026, 2, 28, 18, 0));
  assert.equal(nextDue(settings({ kind: 'month', dayOfMonth: 31 }), sh(2026, 4, 10, 12, 0), SH), sh(2026, 4, 30, 18, 0));
});

test('月报：从 12 月看到跨年 1 月', () => {
  assert.equal(nextDue(settings({ kind: 'month', dayOfMonth: 1 }), sh(2026, 12, 15, 12, 0), SH), sh(2027, 1, 1, 18, 0));
});

test('timeZone 参数覆盖设置里的时区', () => {
  const due = nextDue(settings(), sh(2026, 11, 11, 12, 0), 'UTC');
  assert.equal(due, utc(2026, 11, 13, 18, 0), '按 UTC 计算周五 18:00');
});

test('非法时区 / 非法 nowMs 时 nextDue 返回 null', () => {
  assert.equal(nextDue(settings({ timeZone: 'Mars/Olympus' }), sh(2026, 11, 11, 12, 0)), null);
  assert.equal(nextDue(settings(), NaN, SH), null);
  assert.equal(nextDue(settings(), Infinity, SH), null);
  assert.equal(nextDue(settings(), '2026-11-11', SH), null);
});

test('nextDue 结果严格晚于 nowMs，且周/月边界处不丢不重', () => {
  const now = sh(2026, 11, 15, 23, 59); // 周日晚
  assert.equal(nextDue(settings(), now, SH), sh(2026, 11, 20, 18, 0));
  const boundary = sh(2026, 11, 30, 18, 0); // 11-30 18:00，月报 dayOfMonth=30
  assert.equal(nextDue(settings({ kind: 'month', dayOfMonth: 30 }), boundary, SH), sh(2026, 12, 30, 18, 0));
});

test('夏令时：伦敦春季跳变不存在的本地时间被跳过（不报错）', () => {
  // 2026-03-29 01:00 GMT → 02:00 BST，本地 01:30 不存在，落到跳变瞬间 01:00Z
  const due = nextDue(settings({ weekday: 0, timeOfDay: '01:30', timeZone: 'Europe/London' }), utc(2026, 3, 25, 0, 0));
  assert.equal(due, utc(2026, 3, 29, 1, 0));
});

test('夏令时：纽约春季跳变不存在的本地时间被跳过', () => {
  // 2026-03-08 02:00 EST → 03:00 EDT，本地 02:30 不存在
  const due = nextDue(settings({ weekday: 0, timeOfDay: '02:30', timeZone: 'America/New_York' }), utc(2026, 3, 1, 12, 0));
  assert.equal(due, utc(2026, 3, 8, 7, 0));
});

test('夏令时：秋季重复的本地时间取较早的一次（确定性）', () => {
  // 2026-10-25 伦敦本地 01:30 出现两次：BST(00:30Z) 与 GMT(01:30Z)，取较早
  const due = nextDue(settings({ weekday: 0, timeOfDay: '01:30', timeZone: 'Europe/London' }), utc(2026, 10, 20, 0, 0));
  assert.equal(due, utc(2026, 10, 25, 0, 30));
  assert.equal(nextDue(settings({ weekday: 0, timeOfDay: '01:30', timeZone: 'Europe/London' }), utc(2026, 10, 20, 0, 0)), due);
});

console.log('dueGeneration 判定');

test('默认关闭：disabled，绝不生成', () => {
  assert.deepEqual(dueGeneration(DEFAULT_AUTO_SETTINGS, {}, sh(2026, 11, 11, 12, 0)), { due: false, period: null, reason: 'disabled' });
  assert.deepEqual(dueGeneration(undefined, {}, sh(2026, 11, 11, 12, 0)), { due: false, period: null, reason: 'disabled' });
  assert.equal(dueGeneration({ enabled: 'true' }, {}, sh(2026, 11, 11, 12, 0)).due, false);
});

test('未到期：not-due', () => {
  const now = sh(2026, 11, 11, 12, 0);
  const result = dueGeneration(settings(), { lastPeriodKey: '2026-11-02_2026-11-08' }, now);
  assert.equal(result.due, false);
  assert.equal(result.reason, 'not-due');
  assert.deepEqual(result.period, { start: '2026-11-09', end: '2026-11-15' });
});

test('首次到期即生成：scheduled，且周期与 periodKeyFor 一致', () => {
  const now = sh(2026, 11, 13, 18, 30);
  const result = dueGeneration(settings(), { evidenceCount: 3 }, now);
  assert.equal(result.due, true);
  assert.equal(result.reason, 'scheduled');
  assert.deepEqual(result.period, { start: '2026-11-09', end: '2026-11-15' });
  assert.equal(result.period.start + '_' + result.period.end, periodKeyFor('week', now, SH));
});

test('恰好到期瞬间算到期（>=）', () => {
  const result = dueGeneration(settings(), { evidenceCount: 1 }, sh(2026, 11, 13, 18, 0));
  assert.equal(result.due, true);
  assert.equal(result.reason, 'scheduled');
});

test('同周期已生成：already-generated', () => {
  const state = { lastPeriodKey: '2026-11-09_2026-11-15', lastRunOk: true, lastRunAt: sh(2026, 11, 13, 18, 5) };
  const result = dueGeneration(settings(), state, sh(2026, 11, 13, 19, 0));
  assert.deepEqual(result, { due: false, period: { start: '2026-11-09', end: '2026-11-15' }, reason: 'already-generated' });
});

test('同周期上次失败可以重试：scheduled', () => {
  const state = { lastPeriodKey: '2026-11-09_2026-11-15', lastRunOk: false, lastRunAt: sh(2026, 11, 13, 18, 5), evidenceCount: 1 };
  const result = dueGeneration(settings(), state, sh(2026, 11, 13, 19, 0));
  assert.equal(result.due, true);
  assert.equal(result.reason, 'scheduled');
});

test('依据不足：no-evidence，且不机械生成', () => {
  const now = sh(2026, 11, 13, 18, 30);
  const result = dueGeneration(settings({ minEvidence: 2 }), { evidenceCount: 1 }, now);
  assert.deepEqual(result, { due: false, period: { start: '2026-11-09', end: '2026-11-15' }, reason: 'no-evidence' });
  assert.equal(dueGeneration(settings(), { evidenceCount: 0 }, now).reason, 'no-evidence');
  assert.equal(dueGeneration(settings({ minEvidence: 0 }), { evidenceCount: 0 }, now).reason, 'scheduled');
});

test('minEvidence 可按周期计数（本期依据单独记账）', () => {
  const now = sh(2026, 11, 13, 18, 30);
  const state = { evidenceCount: 99, evidenceByPeriod: { '2026-11-09_2026-11-15': 0 } };
  assert.equal(dueGeneration(settings(), state, now).reason, 'no-evidence');
  assert.equal(dueGeneration(settings(), { evidenceByPeriod: { '2026-11-09_2026-11-15': 2 } }, now).reason, 'scheduled');
});

test('用户暂停：paused（布尔与截止时间两种写法）', () => {
  const now = sh(2026, 11, 13, 18, 30);
  assert.equal(dueGeneration(settings(), { paused: true }, now).reason, 'paused');
  assert.equal(dueGeneration(settings(), { pausedUntil: now + H }, now).reason, 'paused');
  assert.equal(dueGeneration(settings(), { pausedUntil: now, evidenceCount: 1 }, now).reason, 'scheduled', '暂停到期的瞬间恢复');
});

test('失败退避窗口内：backoff', () => {
  const now = sh(2026, 11, 13, 18, 30);
  const state = { lastRunOk: false, attempts: 1, retryAfter: now + 5 * M };
  // 退避在解析周期之前就早退，因此 period 为 null（退避期不需要知道周期）。
  assert.deepEqual(dueGeneration(settings(), state, now), { due: false, period: null, reason: 'backoff' });
});

test('补生成：只补最近一个已到期周期，reason=catch-up', () => {
  // 周三 12:00：本周五还没到，上周五已过期 → 补 11-02 那一期，而不是更早的
  const now = sh(2026, 11, 11, 12, 0);
  const result = dueGeneration(settings(), { evidenceCount: 2, lastPeriodKey: '2026-10-26_2026-11-01' }, now);
  assert.equal(result.due, true);
  assert.equal(result.reason, 'catch-up');
  assert.deepEqual(result.period, { start: '2026-11-02', end: '2026-11-08' });
});

test('补生成：最近一期已生成则不补更早的（降级为 not-due）', () => {
  const now = sh(2026, 11, 11, 12, 0);
  const state = { evidenceCount: 5, lastPeriodKey: '2026-11-02_2026-11-08', lastRunOk: true };
  const result = dueGeneration(settings(), state, now);
  assert.equal(result.due, false);
  assert.equal(result.reason, 'not-due');
});

test('补生成：最近一期无依据则不补（no-evidence，且周期指向该期）', () => {
  const now = sh(2026, 11, 11, 12, 0);
  const state = { evidenceCount: 0, lastPeriodKey: '2026-10-26_2026-11-01' };
  const result = dueGeneration(settings({ minEvidence: 1 }), state, now);
  assert.deepEqual(result, { due: false, period: { start: '2026-11-02', end: '2026-11-08' }, reason: 'no-evidence' });
});

test('补生成：当前周期已到期优先当前周期，不会被补生成抢走', () => {
  const now = sh(2026, 11, 14, 9, 0); // 周六，本周五已过
  const result = dueGeneration(settings(), { evidenceCount: 1, lastPeriodKey: '2026-11-02_2026-11-08' }, now);
  assert.equal(result.reason, 'scheduled');
  assert.deepEqual(result.period, { start: '2026-11-09', end: '2026-11-15' });
});

test('补生成跨年：1 月初补 12 月那一期', () => {
  const now = sh(2026, 1, 1, 9, 0);
  const result = dueGeneration(settings({ kind: 'month', dayOfMonth: 1 }), { evidenceCount: 1 }, now);
  assert.equal(result.reason, 'catch-up');
  assert.deepEqual(result.period, { start: '2025-12-01', end: '2025-12-31' });
});

test('时间回拨：lastRunAt 在未来时禁止再次生成', () => {
  const now = sh(2026, 11, 13, 17, 0);
  const state = { lastRunAt: sh(2026, 11, 13, 19, 0), lastPeriodKey: '2026-10-26_2026-11-01', evidenceCount: 2 };
  const result = dueGeneration(settings(), state, now);
  assert.equal(result.due, false);
  assert.equal(result.reason, 'clock-rollback');
});

test('时间回拨后时钟追回：同周期仍不重复生成', () => {
  const state = { lastRunAt: sh(2026, 11, 13, 18, 5), lastPeriodKey: '2026-11-09_2026-11-15', lastRunOk: true };
  assert.equal(dueGeneration(settings(), state, sh(2026, 11, 13, 10, 0)).reason, 'already-generated');
  assert.equal(dueGeneration(settings(), state, sh(2026, 11, 13, 20, 0)).reason, 'already-generated');
});

test('非法时区 / 非法 now：due=false 并给出明确原因', () => {
  assert.deepEqual(dueGeneration(settings({ timeZone: 'Mars/Olympus' }), {}, sh(2026, 11, 13, 19, 0)), { due: false, period: null, reason: 'invalid-timezone' });
  assert.equal(dueGeneration(settings(), {}, NaN).reason, 'invalid-time');
  assert.equal(dueGeneration(settings(), {}, '2026-11-13').reason, 'invalid-time');
});

test('纯确定：同样输入两次调用结果完全一致', () => {
  const args = [settings(), { evidenceCount: 2, lastPeriodKey: '2026-10-26_2026-11-01' }, sh(2026, 11, 11, 12, 0)];
  assert.deepEqual(dueGeneration(...args), dueGeneration(...args));
  assert.equal(nextDue(settings(), sh(2026, 11, 11, 12, 0), SH), nextDue(settings(), sh(2026, 11, 11, 12, 0), SH));
  const first = JSON.stringify(dueGeneration(...args));
  const second = JSON.stringify(dueGeneration(...args));
  assert.equal(first, second);
});

test('模块自身不读系统时钟：输出只由入参决定', () => {
  const a = dueGeneration(settings(), { evidenceCount: 1 }, sh(2026, 11, 13, 19, 0));
  const b = dueGeneration(settings(), { evidenceCount: 1 }, sh(2026, 11, 13, 19, 0));
  assert.deepEqual(a, b);
  assert.equal(a.reason, 'scheduled');
});

console.log('幂等与退避');

test('shouldSkipForIdempotency：成功过的同周期为 true', () => {
  assert.equal(shouldSkipForIdempotency({ lastPeriodKey: '2026-11-09_2026-11-15', lastRunOk: true }, '2026-11-09_2026-11-15'), true);
  assert.equal(shouldSkipForIdempotency({ lastPeriodKey: '2026-11-09_2026-11-15' }, '2026-11-09_2026-11-15'), true);
  assert.equal(shouldSkipForIdempotency({ lastPeriodKey: '2026-10-26_2026-11-01' }, '2026-11-09_2026-11-15'), false);
});

test('dueGeneration：generatedKeys 单独也能阻止同周期重复生成', () => {
  const settings = normalizeAutoSettings({ enabled: true });
  const now = Date.parse('2026-11-13T19:00:00+08:00');
  const result = dueGeneration(settings, { evidenceCount: 3, generatedKeys: ['2026-11-09_2026-11-15'] }, now);
  assert.equal(result.due, false);
  assert.equal(result.reason, 'already-generated');
});
test('dueGeneration：lastPeriodKey 单独也能阻止同周期重复生成', () => {
  const settings = normalizeAutoSettings({ enabled: true });
  const now = Date.parse('2026-11-13T19:00:00+08:00');
  const result = dueGeneration(settings, { evidenceCount: 3, lastPeriodKey: '2026-11-09_2026-11-15' }, now);
  assert.equal(result.due, false);
  assert.equal(result.reason, 'already-generated');
});
test('dueGeneration：上次失败时同周期仍允许重试，不被两条幂等信号挡住', () => {
  const settings = normalizeAutoSettings({ enabled: true });
  const now = Date.parse('2026-11-13T19:00:00+08:00');
  const result = dueGeneration(settings, {
    evidenceCount: 3, generatedKeys: ['2026-11-09_2026-11-15'], lastPeriodKey: '2026-11-09_2026-11-15', lastRunOk: false,
  }, now);
  assert.equal(result.due, true);
  assert.equal(result.reason, 'scheduled');
});
test('shouldSkipForIdempotency：generatedKeys 记录的历史周期也跳过', () => {
  const state = { generatedKeys: ['2026-11-02_2026-11-08', '2026-10-26_2026-11-01'] };
  assert.equal(shouldSkipForIdempotency(state, '2026-11-02_2026-11-08'), true);
  assert.equal(shouldSkipForIdempotency(state, '2026-11-09_2026-11-15'), false);
});

test('shouldSkipForIdempotency：失败记录不阻断重试', () => {
  assert.equal(shouldSkipForIdempotency({ lastPeriodKey: '2026-11-09_2026-11-15', lastRunOk: false }, '2026-11-09_2026-11-15'), false);
});

test('shouldSkipForIdempotency：非法 periodKey 失败闭合（跳过）', () => {
  for (const key of [null, undefined, 42, '', 'bad', '2026-11-09', '2026-11-09_2026-11-15_x']) {
    assert.equal(shouldSkipForIdempotency({}, key), true);
  }
});

test('退避序列：1 / 5 / 15 / 60 分钟', () => {
  assert.deepEqual(BACKOFF_MS, [60000, 300000, 900000, 3600000]);
  assert.equal(nextBackoff(1), 1 * M);
  assert.equal(nextBackoff(2), 5 * M);
  assert.equal(nextBackoff(3), 15 * M);
  assert.equal(nextBackoff(4), 60 * M);
});

test('退避上限：第 5 次起返回 null（停止自动重试，转人工）', () => {
  assert.equal(nextBackoff(5), null);
  assert.equal(nextBackoff(9), null);
  assert.equal(nextBackoff(0), null);
  assert.equal(nextBackoff(-1), null);
  assert.equal(nextBackoff(1.5), null);
  assert.equal(nextBackoff('1'), null);
  assert.equal(nextBackoff(NaN), null);
});

console.log('与既有实现的兼容性');

test('周期键可直接与 client.js 报告编辑器对齐（start_end）', () => {
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  assert.match(source, /function periodKey\(period\) \{ return \(period && period\.start\) \+ '_' \+ \(period && period\.end\); \}/);
  assert.match(source, /x\.setDate\(x\.getDate\(\) - \(wd === 0 \? 6 : wd - 1\)\)/, 'client.js startOfWeek 以周一为起点');
  assert.match(source, /function monthRangeOf\(date\)/, 'client.js 月报为自然月');
  assert.equal(periodKeyFor('week', '2026-11-12', SH), '2026-11-09_2026-11-15');
});

test('顶层名不与 client.js 冲突（单文件嵌入不会因重复声明而整体语法报错）', () => {
  const mine = readFileSync(new URL('./auto-report.js', import.meta.url), 'utf8');
  const raw = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  // Once this module is embedded, its own declarations live inside the generated
  // region; scanning them would report the module as clashing with itself.
  const client = raw.replace(/^[ \t]*\/\/ @generated [\w.-]+ begin[\s\S]*?^[ \t]*\/\/ @generated [\w.-]+ end[ \t]*$/gm, '');
  // 本模块是扁平 ESM：只有第 0 列的声明才是「顶层」，嵌入后与 client.js 同层。
  const ownTop = new Set([...mine.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  // client.js 侧保守取任意层级的声明：同名即视为冲突，宁可改名也不冒语法错误风险。
  const clientAny = new Set([...client.matchAll(/^[ \t]*(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const clash = [...ownTop].filter((name) => clientAny.has(name)).sort();
  assert.ok(ownTop.size > 0, '应能解析到顶层声明');
  assert.deepEqual(clash, [], '与 client.js 重名的顶层声明：' + clash.join(', '));
});

test('auto-report.js 保持浏览器可嵌入：无 import / require / Node API / 宿主全局 / Date.now', () => {
  const source = readFileSync(new URL('./auto-report.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /\brequire\s*\(/);
  assert.doesNotMatch(code, /\bDate\.now\s*\(/);
  assert.doesNotMatch(code, /\bnew Date\(\s*\)/);
  assert.doesNotMatch(code, /\b(process|Buffer|globalThis|window|document|localStorage|sessionStorage|fetch|XMLHttpRequest|navigator|crypto)\b/);
  assert.doesNotMatch(code, /console\./);
});

console.log('');
console.log('AUTO-REPORT: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
if (passed < 28) {
  console.error('用例数不足 28：' + passed);
  process.exit(1);
}
