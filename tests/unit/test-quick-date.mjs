import assert from 'node:assert/strict';
import { recognizeQuickDate } from '../../src/shared/quick-date.js';

// Construct fixed local dates: the recognizer deliberately uses the caller's
// calendar, so these assertions also run unchanged in different time zones.
const sunday = new Date(2026, 0, 4, 23, 59, 59); // Sunday, first week crosses year.
let assertions = 0;
function expect(text, date, now = sunday, token = text) {
  const start = text.indexOf(token);
  assert.deepEqual(recognizeQuickDate(text, now), { text: token, start, end: start + token.length, date }, text);
  assertions++;
}
function empty(text, now = sunday) {
  assert.equal(recognizeQuickDate(text, now), null, String(text));
  assertions++;
}

for (const [token, date] of [
  ['今天', '2026-01-04'], ['昨天', '2026-01-03'], ['前天', '2026-01-02'],
  ['明天', '2026-01-05'], ['后天', '2026-01-06'], ['大后天', '2026-01-07'],
  ['本周一', '2025-12-29'], ['这周一', '2025-12-29'], ['周一', '2025-12-29'],
  ['上周一', '2025-12-22'], ['下周一', '2026-01-05'],
  ['本周日', '2026-01-04'], ['这周天', '2026-01-04'], ['周7', '2026-01-04'],
  ['上周天', '2025-12-28'], ['下周日', '2026-01-11'],
  ['上周', '2025-12-28'], ['下周', '2026-01-11'], ['本周', '2026-01-04'], ['这周', '2026-01-04'],
  ['上星期三', '2025-12-24'], ['下星期3', '2026-01-07'],
  ['本星期五', '2026-01-02'], ['这星期六', '2026-01-03'],
  ['上礼拜四', '2025-12-25'], ['下礼拜4', '2026-01-08'],
  ['本礼拜一', '2025-12-29'], ['这礼拜天', '2026-01-04'],
  ['星期二', '2025-12-30'], ['礼拜2', '2025-12-30'],
  ['2024-02-29', '2024-02-29'], ['12月31日', '2026-12-31'], ['1月1日', '2026-01-01'],
]) expect(token, date);

for (let day = 1; day <= 7; day++) {
  expect(`周${day}`, `2026-01-${String(day + 4).padStart(2, '0')}`, new Date(2026, 0, 5, 0, 0));
}
expect('本周一', '2026-01-05', new Date(2026, 0, 7, 12));
expect('下周', '2026-01-14', new Date(2026, 0, 7, 12));
expect('上周', '2025-12-31', new Date(2026, 0, 7, 12));
expect('明天', '2027-01-01', new Date(2026, 11, 31, 23, 59));
expect('前天', '2025-12-30', new Date(2026, 0, 1));
expect('大后天', '2024-03-02', new Date(2024, 1, 28));
expect('昨天', '2024-02-29', new Date(2024, 2, 1));
expect('后天', '2026-03-01', new Date(2026, 1, 27));
expect('2月29日', '2024-02-29', new Date(2024, 0, 1));
// Calendar arithmetic remains correct across 23/25-hour DST days.
expect('明天', '2026-03-09', new Date(2026, 2, 8, 0, 30));
expect('明天', '2026-11-02', new Date(2026, 10, 1, 0, 30));
expect('下周一', '2026-03-09', new Date(2026, 2, 8, 23, 30));
expect('0001-01-01', '0001-01-01');

// Source order wins over rule order or chronological date order.
expect('先下周一，再今天', '2026-01-05', sunday, '下周一');
expect('先12月31日，再昨天', '2026-12-31', sunday, '12月31日');
expect('先2024-02-29，再明天', '2024-02-29', sunday, '2024-02-29');
expect('先明天，再2024-02-29', '2026-01-05', sunday, '明天');
expect('😀  大后天处理，后天再看', '2026-01-07', sunday, '大后天');
expect('后天与大后天', '2026-01-06', sunday, '后天');

for (const invalid of ['2026-02-29', '2024-02-30', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-01-32', '2026-1-01', '12026-01-01', '2月30日', '0月1日', '13月1日', '1月0日', '1月32日', '100月1日', '下周8', '本周0', '星期9', '礼拜12', '周01']) {
  empty(invalid);
  expect(`${invalid}，然后明天`, '2026-01-05', sunday, '明天');
}
for (const value of ['', '没有日期', '周', '星期', '礼拜', null, 12, {}, undefined]) empty(value);
// Missing, invalid and non-Date clocks never consult the wall clock.
assert.equal(recognizeQuickDate('今天'), null); assertions++;
for (const now of [null, new Date(NaN), '2026-01-04', 0, {}]) empty('今天', now);
const before = sunday.getTime();
expect('下周六', '2026-01-10');
assert.equal(sunday.getTime(), before); assertions++;
assert.deepEqual(recognizeQuickDate('😀 大后天', sunday), recognizeQuickDate('😀 大后天', sunday)); assertions++;
console.log(`quick-date tests passed (${assertions} assertions)`);
