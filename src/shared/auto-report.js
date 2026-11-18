// Canonical browser-safe source; the build may embed this module into client.js.
// 纯决策模块：无 import、无 require、无 Node API、无宿主全局、不读取系统时钟。
// 「现在」一律由调用方通过 nowMs 传入，因此同样输入必然得到同样输出。
//
// 周期口径与 client.js 既有报告编辑器完全一致（不要另造一套）：
//   client.js:1513 monthRangeOf   自然月（1 日到月末）
//   client.js:1496 weekRangeOf    自然周（startOfWeek 见 client.js:1713，周一为起点、周日结束）
//   client.js:1523 periodFor      kind==='month' ? 月 : 周
//   client.js:1511 periodKey      period.start + '_' + period.end
//   client.js:1492 inPeriod       两端都包含
// 这里只把同一口径复刻成不依赖宿主时区的纯函数。
//
// 时区：内置固定偏移表 + EU/US/AU 三套夏令时规则，不引入第三方库，也不读取宿主时区；
// 无法识别的时区一律返回 null / reason:'invalid-timezone'，绝不猜测。

export const DEFAULT_AUTO_SETTINGS = Object.freeze({
  enabled: false,
  kind: 'week',
  timeOfDay: '18:00',
  timeZone: 'Asia/Shanghai',
  weekday: 5,
  dayOfMonth: 1,
  scope: 'all',
  model: null,
  maxPerRun: 1,
  minEvidence: 1,
});

/** 失败重试间隔（毫秒）：1、5、15、60 分钟；次数用尽后返回 null，停止自动重试并转人工。 */
export const BACKOFF_MS = Object.freeze([60000, 300000, 900000, 3600000]);

const AR_MINUTE_MS = 60000;
const AR_DAY_MS = 86400000;
/** 向后搜索下一次到期的最大天数，覆盖每月 31 日与任意周几。 */
const MAX_DAYS_AHEAD = 400;
/** 合法时区偏移上限 ±14 小时。 */
const MAX_ABS_OFFSET_MINUTES = 840;
const PERIOD_KEY_RE = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_WITH_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const OFFSET_ZONE_RE = /^(?:UTC|GMT|UT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

// ---- 内置时区表（不读宿主时区）----------------------------------------

/** 无夏令时的固定偏移时区（分钟，东为正）。 */
const FIXED_ZONE_MINUTES = Object.freeze({
  UTC: 0,
  'Etc/UTC': 0,
  'Etc/GMT': 0,
  GMT: 0,
  Z: 0,
  'Asia/Shanghai': 480,
  'Asia/Chongqing': 480,
  'Asia/Urumqi': 360,
  'Asia/Hong_Kong': 480,
  'Asia/Macau': 480,
  'Asia/Taipei': 480,
  'Asia/Tokyo': 540,
  'Asia/Seoul': 540,
  'Asia/Singapore': 480,
  'Asia/Kuala_Lumpur': 480,
  'Asia/Manila': 480,
  'Asia/Bangkok': 420,
  'Asia/Jakarta': 420,
  'Asia/Ho_Chi_Minh': 420,
  'Asia/Kolkata': 330,
  'Asia/Colombo': 330,
  'Asia/Kathmandu': 345,
  'Asia/Dhaka': 360,
  'Asia/Karachi': 300,
  'Asia/Dubai': 240,
  'Asia/Muscat': 240,
  'Asia/Riyadh': 180,
  'Asia/Baghdad': 180,
  'Africa/Nairobi': 180,
  'Africa/Addis_Ababa': 180,
  'Africa/Johannesburg': 120,
  'Africa/Lagos': 60,
  'Africa/Accra': 0,
  'Africa/Abidjan': 0,
  'Europe/Moscow': 180,
  'Europe/Istanbul': 180,
  'Europe/Minsk': 180,
  'Australia/Perth': 480,
  'Australia/Brisbane': 600,
  'Pacific/Guam': 600,
  'Pacific/Port_Moresby': 600,
});

/**
 * 会切换夏令时的时区。规则只按已发布的公开规则建模：
 * EU  3 月最后一个周日 01:00 UTC 起，10 月最后一个周日 01:00 UTC 止；
 * US  3 月第二个周日 02:00 本地（07:00 UTC）起，11 月第一个周日 02:00 本地（06:00 UTC）止；
 * AU  10 月第一个周日 02:00 标准时（前一天 16:00 UTC）起，4 月第一个周日 03:00 夏令时（前一天 16:00 UTC）止。
 * 其他带夏令时的时区不在此表内，使用时会明确返回 null 而不是猜。
 */
const DST_ZONES = Object.freeze({
  'Europe/London': Object.freeze({ std: 0, dst: 60, rule: 'EU' }),
  'Europe/Dublin': Object.freeze({ std: 0, dst: 60, rule: 'EU' }),
  'Europe/Lisbon': Object.freeze({ std: 0, dst: 60, rule: 'EU' }),
  'Europe/Berlin': Object.freeze({ std: 60, dst: 120, rule: 'EU' }),
  'Europe/Paris': Object.freeze({ std: 60, dst: 120, rule: 'EU' }),
  'Europe/Madrid': Object.freeze({ std: 60, dst: 120, rule: 'EU' }),
  'Europe/Rome': Object.freeze({ std: 60, dst: 120, rule: 'EU' }),
  'Europe/Amsterdam': Object.freeze({ std: 60, dst: 120, rule: 'EU' }),
  'Europe/Brussels': Object.freeze({ std: 60, dst: 120, rule: 'EU' }),
  'Europe/Zurich': Object.freeze({ std: 60, dst: 120, rule: 'EU' }),
  'Europe/Stockholm': Object.freeze({ std: 60, dst: 120, rule: 'EU' }),
  'America/New_York': Object.freeze({ std: -300, dst: -240, rule: 'US' }),
  'America/Toronto': Object.freeze({ std: -300, dst: -240, rule: 'US' }),
  'America/Chicago': Object.freeze({ std: -360, dst: -300, rule: 'US' }),
  'America/Denver': Object.freeze({ std: -420, dst: -360, rule: 'US' }),
  'America/Los_Angeles': Object.freeze({ std: -480, dst: -420, rule: 'US' }),
  'America/Vancouver': Object.freeze({ std: -480, dst: -420, rule: 'US' }),
  'Australia/Sydney': Object.freeze({ std: 600, dst: 660, rule: 'AU' }),
  'Australia/Melbourne': Object.freeze({ std: 600, dst: 660, rule: 'AU' }),
});

// ---- 日历基础运算（只用 UTC 数值，禁止宿主时区参与）---------------------

function arPad2(value) { return value < 10 ? '0' + value : String(value); }

function arDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayNumberFromYmd(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / AR_DAY_MS);
}

function ymdFromDayNumber(dayNumber) {
  const dt = new Date(dayNumber * AR_DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** 0=周日 … 6=周六（与 client.js 使用的 getDay() 口径一致）。 */
function weekdayFromDayNumber(dayNumber) {
  return ((dayNumber + 4) % 7 + 7) % 7;
}

function ymdStringOf(parts) {
  return parts.y + '-' + arPad2(parts.m) + '-' + arPad2(parts.d);
}

function ymdOfDayNumber(dayNumber) {
  return ymdStringOf(ymdFromDayNumber(dayNumber));
}

function isValidYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= arDaysInMonth(year, month);
}

function parseYmd(value) {
  const match = DATE_ONLY_RE.exec(typeof value === 'string' ? value.trim() : '');
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return isValidYmd(y, m, d) ? { y, m, d } : null;
}

function firstWeekdayOfMonthDayNumber(year, month, weekday) {
  const first = dayNumberFromYmd(year, month, 1);
  return first + ((weekday - weekdayFromDayNumber(first) + 7) % 7);
}

function lastWeekdayOfMonthDayNumber(year, month, weekday) {
  const last = dayNumberFromYmd(year, month, 1) + arDaysInMonth(year, month) - 1;
  return last - ((weekdayFromDayNumber(last) - weekday + 7) % 7);
}

// ---- 时区偏移 -----------------------------------------------------------

function parseOffsetZone(raw) {
  const match = OFFSET_ZONE_RE.exec(typeof raw === 'string' ? raw.trim() : '');
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] == null ? 0 : Number(match[3]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes > 59) return null;
  const total = sign * (hours * 60 + minutes);
  if (Math.abs(total) > MAX_ABS_OFFSET_MINUTES) return null;
  return total;
}

/** 时区字符串 → 可用的时区标识；无法处理时返回 null（不猜测）。 */
function resolveZone(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64 || CONTROL_CHARS_RE.test(trimmed)) return null;
  if (Object.prototype.hasOwnProperty.call(FIXED_ZONE_MINUTES, trimmed)) return trimmed;
  if (Object.prototype.hasOwnProperty.call(DST_ZONES, trimmed)) return trimmed;
  return parseOffsetZone(trimmed) === null ? null : trimmed;
}

function zoneOffsets(zone) {
  if (Object.prototype.hasOwnProperty.call(FIXED_ZONE_MINUTES, zone)) return [FIXED_ZONE_MINUTES[zone]];
  const spec = DST_ZONES[zone];
  if (spec) return [spec.std, spec.dst];
  const parsed = parseOffsetZone(zone);
  return parsed === null ? null : [parsed];
}

function dstOffsetAt(spec, utcMs) {
  const dt = new Date(utcMs);
  const year = dt.getUTCFullYear();
  if (spec.rule === 'EU') {
    const startMs = lastWeekdayOfMonthDayNumber(year, 3, 0) * AR_DAY_MS + 60 * AR_MINUTE_MS;
    const endMs = lastWeekdayOfMonthDayNumber(year, 10, 0) * AR_DAY_MS + 60 * AR_MINUTE_MS;
    return utcMs >= startMs && utcMs < endMs ? spec.dst : spec.std;
  }
  if (spec.rule === 'US') {
    const startMs = (firstWeekdayOfMonthDayNumber(year, 3, 0) + 7) * AR_DAY_MS + 420 * AR_MINUTE_MS;
    const endMs = firstWeekdayOfMonthDayNumber(year, 11, 0) * AR_DAY_MS + 360 * AR_MINUTE_MS;
    return utcMs >= startMs && utcMs < endMs ? spec.dst : spec.std;
  }
  if (spec.rule === 'AU') {
    const startMs = (firstWeekdayOfMonthDayNumber(year, 10, 0) - 1) * AR_DAY_MS + 960 * AR_MINUTE_MS;
    const endMs = (firstWeekdayOfMonthDayNumber(year, 4, 0) - 1) * AR_DAY_MS + 960 * AR_MINUTE_MS;
    if (utcMs >= startMs) return spec.dst;
    if (utcMs < endMs) return spec.dst;
    return spec.std;
  }
  return null;
}

function zoneOffsetAt(zone, utcMs) {
  if (!Number.isFinite(utcMs)) return null;
  if (Object.prototype.hasOwnProperty.call(FIXED_ZONE_MINUTES, zone)) return FIXED_ZONE_MINUTES[zone];
  const spec = DST_ZONES[zone];
  if (spec) return dstOffsetAt(spec, utcMs);
  return parseOffsetZone(zone);
}

/** 给定瞬时在某时区的偏移分钟数；时区无法处理时返回 null。 */
export function timeZoneOffsetMinutes(timeZone, utcMs) {
  const zone = resolveZone(timeZone);
  if (!zone) return null;
  return zoneOffsetAt(zone, utcMs);
}

/** 瞬时 → 该时区的本地日历字段；时区无法处理时返回 null。 */
export function localDateTimeFor(timeZone, utcMs) {
  const zone = resolveZone(timeZone);
  if (!zone || !Number.isFinite(utcMs)) return null;
  const offset = zoneOffsetAt(zone, utcMs);
  if (offset === null) return null;
  const dt = new Date(utcMs + offset * AR_MINUTE_MS);
  if (Number.isNaN(dt.getTime())) return null;
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    hh: dt.getUTCHours(),
    mm: dt.getUTCMinutes(),
    offsetMinutes: offset,
  };
}

/**
 * 本地日历时间 → UTC 瞬时。
 * - 本地时间不存在（春季跳变跳过的那一小时）：跳过该时刻，落到跳变后的第一个瞬间；
 * - 本地时间重复（秋季回拨）：取较早的一次，保证确定性；
 * - 时区无法处理或日期非法：返回 null。
 */
function localWallToUtc(zone, year, month, day, hour, minute) {
  const offsets = zoneOffsets(zone);
  if (!offsets) return null;
  if (!isValidYmd(year, month, day)) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const wallMs = Date.UTC(year, month - 1, day, hour, minute);
  const valid = [];
  for (const offset of offsets) {
    const candidate = wallMs - offset * AR_MINUTE_MS;
    if (zoneOffsetAt(zone, candidate) === offset) valid.push(candidate);
  }
  if (valid.length === 1) return valid[0];
  if (valid.length > 1) return Math.min.apply(null, valid);
  // 跳变空洞：在候选区间内二分出「跳变后第一个瞬间」，即物理上最早的合法时刻。
  let low = Infinity;
  let high = -Infinity;
  for (const offset of offsets) {
    const candidate = wallMs - offset * AR_MINUTE_MS;
    if (candidate < low) low = candidate;
    if (candidate > high) high = candidate;
  }
  const target = zoneOffsetAt(zone, high);
  if (target === null || zoneOffsetAt(zone, low) === target) return null;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (zoneOffsetAt(zone, mid) === target) high = mid;
    else low = mid + 1;
  }
  return low;
}

// ---- 周期（与 client.js 周报/月报口径一致）-------------------------------

/**
 * 周期对象形状与 client.js 一致：{start:'YYYY-MM-DD', end:'YYYY-MM-DD'}，两端都含。
 * 周：周一为起点、周日结束；月：自然月 1 日到月末。kind 非法返回 null。
 */
export function periodForDate(kind, dateYmd) {
  const parts = parseYmd(dateYmd);
  if (!parts) return null;
  const dayNumber = dayNumberFromYmd(parts.y, parts.m, parts.d);
  if (kind === 'month') {
    const first = dayNumberFromYmd(parts.y, parts.m, 1);
    return { start: ymdOfDayNumber(first), end: ymdOfDayNumber(first + arDaysInMonth(parts.y, parts.m) - 1) };
  }
  if (kind !== 'week') return null;
  const startNumber = dayNumber - ((weekdayFromDayNumber(dayNumber) + 6) % 7);
  return { start: ymdOfDayNumber(startNumber), end: ymdOfDayNumber(startNumber + 6) };
}

/** 周期键复刻 client.js:1511 的 `start + '_' + end` 格式。 */
export function periodKeyForPeriod(period) {
  const valid = arValidPeriod(period);
  return valid ? valid.start + '_' + valid.end : null;
}

function arValidPeriod(period) {
  if (!period || typeof period !== 'object') return null;
  const start = parseYmd(period.start);
  const end = parseYmd(period.end);
  if (!start || !end) return null;
  const startNumber = dayNumberFromYmd(start.y, start.m, start.d);
  const endNumber = dayNumberFromYmd(end.y, end.m, end.d);
  if (endNumber < startNumber) return null;
  return { start: ymdStringOf(start), end: ymdStringOf(end) };
}

function arShiftPeriod(kind, period, delta) {
  const base = arValidPeriod(period);
  if (!base || !Number.isInteger(delta)) return null;
  const start = parseYmd(base.start);
  if (kind === 'month') {
    const total = start.y * 12 + (start.m - 1) + delta;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    return periodForDate('month', year + '-' + arPad2(month) + '-01');
  }
  if (kind !== 'week') return null;
  const shifted = dayNumberFromYmd(start.y, start.m, start.d) + delta * 7;
  return periodForDate('week', ymdOfDayNumber(shifted));
}

/**
 * 稳定周期键，例如 '2026-11-09_2026-11-15'（周）/ '2026-11-01_2026-11-30'（月）。
 * dateISO 可以是：'YYYY-MM-DD'（直接当本地日历日）、带 Z/±hh:mm 的瞬时、
 * 毫秒时间戳、Date 实例。无法判定或时区无法处理时返回 null，不做猜测。
 */
export function periodKeyFor(kind, dateISO, timeZone) {
  const period = periodOf(kind, dateISO, timeZone);
  return period ? period.start + '_' + period.end : null;
}

function periodOf(kind, dateISO, timeZone) {
  if (kind !== 'week' && kind !== 'month') return null;
  const zone = resolveZone(timeZone === undefined || timeZone === null ? DEFAULT_AUTO_SETTINGS.timeZone : timeZone);
  if (!zone) return null;
  if (typeof dateISO === 'string' && DATE_ONLY_RE.test(dateISO.trim())) {
    return periodForDate(kind, dateISO.trim());
  }
  const instant = instantOf(dateISO);
  if (instant === null) return null;
  const local = localDateTimeFor(zone, instant);
  if (!local) return null;
  return periodForDate(kind, ymdStringOf(local));
}

function instantOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // 没有显式偏移的字符串会依赖宿主时区解析，这里直接拒绝而不是猜测。
  if (!INSTANT_WITH_OFFSET_RE.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

// ---- 设置与状态归一化 ---------------------------------------------------

function normalizeTimeOfDay(raw) {
  const match = TIME_OF_DAY_RE.exec(typeof raw === 'string' ? raw.trim() : '');
  if (!match) return DEFAULT_AUTO_SETTINGS.timeOfDay;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || hh > 23 || mm > 59) return DEFAULT_AUTO_SETTINGS.timeOfDay;
  return arPad2(hh) + ':' + arPad2(mm);
}

function normalizeZoneName(raw) {
  if (typeof raw !== 'string') return DEFAULT_AUTO_SETTINGS.timeZone;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64 || CONTROL_CHARS_RE.test(trimmed)) return DEFAULT_AUTO_SETTINGS.timeZone;
  // 形状合法但本模块不认识的时区会被保留，交给 nextDue/dueGeneration 明确返回
  // null / reason:'invalid-timezone'，不在这里悄悄换成默认时区。
  return trimmed;
}

function normalizeScope(raw) {
  if (typeof raw !== 'string') return DEFAULT_AUTO_SETTINGS.scope;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64 || CONTROL_CHARS_RE.test(trimmed)) return DEFAULT_AUTO_SETTINGS.scope;
  return trimmed;
}

function normalizeModel(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128 || CONTROL_CHARS_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeInt(raw, min, max, fallback) {
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

/**
 * 归一到合法设置。非法字段回落到默认值；enabled 只在严格布尔 true 时为 true，
 * 任何解析失败、字符串 'true'、数字 1、缺省值都不会被放宽。
 */
export function normalizeAutoSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled === true,
    kind: source.kind === 'month' ? 'month' : 'week',
    timeOfDay: normalizeTimeOfDay(source.timeOfDay),
    timeZone: normalizeZoneName(source.timeZone),
    weekday: normalizeInt(source.weekday, 0, 6, DEFAULT_AUTO_SETTINGS.weekday),
    dayOfMonth: normalizeInt(source.dayOfMonth, 1, 31, DEFAULT_AUTO_SETTINGS.dayOfMonth),
    scope: normalizeScope(source.scope),
    model: normalizeModel(source.model),
    maxPerRun: normalizeInt(source.maxPerRun, 1, 10, DEFAULT_AUTO_SETTINGS.maxPerRun),
    minEvidence: normalizeInt(source.minEvidence, 0, 1000, DEFAULT_AUTO_SETTINGS.minEvidence),
  };
}

function timestampOf(raw) {
  return Number.isFinite(raw) ? Math.trunc(raw) : null;
}

/**
 * 归一化运行状态：lastRunAt / lastPeriodKey / lastRunOk / paused / pausedUntil /
 * retryAfter / attempts / evidenceCount / evidenceByPeriod / generatedKeys。
 * 任何字段非法都不放行生成，只按保守值处理。
 */
export function normalizeAutoState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const lastPeriodKey = typeof source.lastPeriodKey === 'string' && PERIOD_KEY_RE.test(source.lastPeriodKey.trim())
    ? source.lastPeriodKey.trim()
    : null;
  const generatedKeys = [];
  if (Array.isArray(source.generatedKeys)) {
    for (const entry of source.generatedKeys) {
      if (typeof entry !== 'string') continue;
      const key = entry.trim();
      if (!PERIOD_KEY_RE.test(key) || generatedKeys.indexOf(key) !== -1) continue;
      generatedKeys.push(key);
      if (generatedKeys.length >= 200) break;
    }
  }
  const evidenceByPeriod = {};
  const rawEvidence = source.evidenceByPeriod;
  if (rawEvidence && typeof rawEvidence === 'object' && !Array.isArray(rawEvidence)) {
    for (const key of Object.keys(rawEvidence)) {
      const value = rawEvidence[key];
      if (!PERIOD_KEY_RE.test(key) || !Number.isFinite(value) || value < 0) continue;
      evidenceByPeriod[key] = Math.floor(value);
    }
  }
  return {
    lastRunAt: timestampOf(source.lastRunAt),
    lastPeriodKey,
    lastRunOk: typeof source.lastRunOk === 'boolean' ? source.lastRunOk : null,
    paused: source.paused === true,
    pausedUntil: timestampOf(source.pausedUntil),
    retryAfter: timestampOf(source.retryAfter),
    attempts: normalizeInt(source.attempts, 0, 1000, 0),
    evidenceCount: Number.isFinite(source.evidenceCount) && source.evidenceCount >= 0 ? Math.floor(source.evidenceCount) : 0,
    evidenceByPeriod,
    generatedKeys,
  };
}

function evidenceFor(state, periodKey) {
  if (state.evidenceByPeriod && Object.prototype.hasOwnProperty.call(state.evidenceByPeriod, periodKey)) {
    return state.evidenceByPeriod[periodKey];
  }
  return state.evidenceCount;
}

function evidenceSufficient(settings, state, periodKey) {
  return evidenceFor(state, periodKey) >= settings.minEvidence;
}

// ---- 到期判定 -----------------------------------------------------------

function parseTimeOfDay(value) {
  const match = TIME_OF_DAY_RE.exec(typeof value === 'string' ? value.trim() : '');
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/** 该月计划日：dayOfMonth 超过当月天数时取当月最后一天（确定性规则，保证每月都有一次）。 */
function effectiveDayOfMonth(dayOfMonth, year, month) {
  return Math.min(dayOfMonth, arDaysInMonth(year, month));
}

function scheduleMatchesDay(settings, dayNumber) {
  const civil = ymdFromDayNumber(dayNumber);
  if (settings.kind === 'month') return civil.d === effectiveDayOfMonth(settings.dayOfMonth, civil.y, civil.m);
  return weekdayFromDayNumber(dayNumber) === settings.weekday;
}

/** 周期内的计划时刻（本地时间 → UTC 瞬时）；无法确定时返回 null。 */
function scheduledInstantInPeriod(zone, settings, period) {
  const base = arValidPeriod(period);
  if (!base) return null;
  const time = parseTimeOfDay(settings.timeOfDay);
  if (!time) return null;
  const start = parseYmd(base.start);
  const startNumber = dayNumberFromYmd(start.y, start.m, start.d);
  if (settings.kind === 'month') {
    const day = effectiveDayOfMonth(settings.dayOfMonth, start.y, start.m);
    return localWallToUtc(zone, start.y, start.m, day, time.hh, time.mm);
  }
  for (let index = 0; index < 7; index += 1) {
    const dayNumber = startNumber + index;
    if (!scheduleMatchesDay(settings, dayNumber)) continue;
    const civil = ymdFromDayNumber(dayNumber);
    return localWallToUtc(zone, civil.y, civil.m, civil.d, time.hh, time.mm);
  }
  return null;
}

/**
 * 下一次应当生成的时间戳（严格晚于 nowMs），无法确定时返回 null。
 * settings.enabled 不为 true、时区无法处理、nowMs 非法都会返回 null。
 */
export function nextDue(settings, nowMs, timeZone) {
  const normalized = normalizeAutoSettings(settings);
  if (!normalized.enabled) return null;
  if (!Number.isFinite(nowMs)) return null;
  const zone = resolveZone(timeZone === undefined || timeZone === null ? normalized.timeZone : timeZone);
  if (!zone) return null;
  const local = localDateTimeFor(zone, nowMs);
  if (!local) return null;
  const time = parseTimeOfDay(normalized.timeOfDay);
  if (!time) return null;
  const todayNumber = dayNumberFromYmd(local.y, local.m, local.d);
  for (let index = 0; index <= MAX_DAYS_AHEAD; index += 1) {
    const dayNumber = todayNumber + index;
    if (!scheduleMatchesDay(normalized, dayNumber)) continue;
    const civil = ymdFromDayNumber(dayNumber);
    const dueMs = localWallToUtc(zone, civil.y, civil.m, civil.d, time.hh, time.mm);
    if (dueMs === null) continue;
    if (dueMs > nowMs) return dueMs;
  }
  return null;
}

/**
 * 判断此刻是否该生成一份报告草稿。
 * 返回 {due, period, reason}，period 为 {start,end} 或 null。
 * reason 取值：disabled / paused / backoff / invalid-timezone / invalid-time /
 * invalid-settings / already-generated / clock-rollback / not-due / no-evidence /
 * scheduled / catch-up。
 *
 * 补生成规则：只在「当前周期尚未到期」时，补最近一个「已到期、未生成、有依据」的
 * 周期，最多补一期，不会连补多个历史周期（当前周期已到期则直接生成当前周期）。
 */
export function dueGeneration(settings, state, nowMs) {
  const normalized = normalizeAutoSettings(settings);
  const runtime = normalizeAutoState(state);
  if (!normalized.enabled) return { due: false, period: null, reason: 'disabled' };
  if (!Number.isFinite(nowMs)) return { due: false, period: null, reason: 'invalid-time' };
  const zone = resolveZone(normalized.timeZone);
  if (!zone) return { due: false, period: null, reason: 'invalid-timezone' };
  if (runtime.paused) return { due: false, period: null, reason: 'paused' };
  if (runtime.pausedUntil !== null && nowMs < runtime.pausedUntil) return { due: false, period: null, reason: 'paused' };
  if (runtime.retryAfter !== null && nowMs < runtime.retryAfter) return { due: false, period: null, reason: 'backoff' };
  // The fifth failure exhausts the four scheduled retries; a missing retryAfter
  // must not silently enable another run on the next five-minute tick.
  if (runtime.lastRunOk === false && runtime.attempts > BACKOFF_MS.length)
    return { due: false, period: null, reason: 'retry-exhausted' };
  const local = localDateTimeFor(zone, nowMs);
  if (!local) return { due: false, period: null, reason: 'invalid-time' };
  const current = periodForDate(normalized.kind, ymdStringOf(local));
  if (!current) return { due: false, period: null, reason: 'invalid-settings' };
  const currentKey = current.start + '_' + current.end;
  // 幂等：同周期已有成功记录直接跳过；上次失败（lastRunOk === false）允许重试。
  // Both signals must block: callers may record a period in generatedKeys while
  // lastPeriodKey still points at an older catch-up run, and vice versa. Ignoring
  // either one would let an automatic draft overwrite a period already produced.
  if (runtime.lastRunOk !== false
    && (runtime.lastPeriodKey === currentKey || runtime.generatedKeys.indexOf(currentKey) !== -1)) {
    return { due: false, period: current, reason: 'already-generated' };
  }
  // 时间回拨：上次成功运行发生在「未来」，禁止据旧的周期状态再次生成。
  if (runtime.lastRunAt !== null && nowMs < runtime.lastRunAt) {
    return { due: false, period: current, reason: 'clock-rollback' };
  }
  const currentDueAt = scheduledInstantInPeriod(zone, normalized, current);
  if (currentDueAt === null) return { due: false, period: current, reason: 'invalid-settings' };
  if (nowMs >= currentDueAt) {
    if (!evidenceSufficient(normalized, runtime, currentKey)) return { due: false, period: current, reason: 'no-evidence' };
    return { due: true, period: current, reason: 'scheduled' };
  }
  // 当前周期尚未到期：只补最近一个已过去且未生成的周期。
  const previous = arShiftPeriod(normalized.kind, current, -1);
  if (!previous) return { due: false, period: current, reason: 'not-due' };
  const previousKey = previous.start + '_' + previous.end;
  if (runtime.lastRunOk !== false
    && (runtime.lastPeriodKey === previousKey || runtime.generatedKeys.indexOf(previousKey) !== -1)) {
    return { due: false, period: current, reason: 'not-due' };
  }
  if (runtime.lastPeriodKey !== null && previousKey < runtime.lastPeriodKey) {
    return { due: false, period: current, reason: 'not-due' };
  }
  const previousDueAt = scheduledInstantInPeriod(zone, normalized, previous);
  if (previousDueAt === null || previousDueAt > nowMs) return { due: false, period: current, reason: 'not-due' };
  if (!evidenceSufficient(normalized, runtime, previousKey)) {
    return { due: false, period: previous, reason: 'no-evidence' };
  }
  return { due: true, period: previous, reason: 'catch-up' };
}

/**
 * 幂等跳过：同 periodKey 已有成功记录则 true。
 * periodKey 非法时也返回 true（失败闭合：宁可跳过，也不重复生成/覆盖）。
 */
export function shouldSkipForIdempotency(state, periodKey) {
  const runtime = normalizeAutoState(state);
  if (typeof periodKey !== 'string') return true;
  const key = periodKey.trim();
  if (key.length > 64 || !PERIOD_KEY_RE.test(key)) return true;
  if (runtime.generatedKeys.indexOf(key) !== -1) return true;
  return runtime.lastPeriodKey === key && runtime.lastRunOk !== false;
}

/**
 * 失败重试间隔：attempt 从 1 开始，依次 1/5/15/60 分钟；
 * attempt 非正整数、或用尽（第 5 次起）返回 null，表示停止自动重试、转人工。
 */
export function nextBackoff(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  const index = attempt - 1;
  if (index >= BACKOFF_MS.length) return null;
  return BACKOFF_MS[index];
}
