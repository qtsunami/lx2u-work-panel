// Calendar dates use the caller's local calendar. No implicit clock or dependencies.
const RELATIVE_DAYS = { 今天: 0, 昨天: -1, 前天: -2, 明天: 1, 后天: 2, 大后天: 3 };
const QUICK_DATE_WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

function calendarDate(year, month, day) {
  if (!Number.isInteger(year) || year < 0 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // setFullYear avoids the Date constructor's special handling of years 0–99.
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function formatDate(date) {
  const year = date.getFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Return the first valid expression in source order, or null.
 * now must be a valid Date; invalid input returns null. Offsets are original
 * JavaScript UTF-16 indices, with end exclusive. M月D日 uses now's year;
 * unprefixed weekdays use the current Monday-based natural week (even if past).
 */
export function recognizeQuickDate(text, now) {
  if (typeof text !== 'string' || !(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getFullYear() < 0 || now.getFullYear() > 9999) return null;
  // Longer relative words must win at the same position. Consume whole numeric
  // tokens, including invalid ones, rather than accepting a valid suffix.
  const expressions = /大后天|今天|昨天|前天|明天|后天|[上下本这]?(?:星期|礼拜|周)(?:[一二三四五六日天]|\d+)?|\d+-\d+-\d+|\d+月\d+日/g;
  for (const match of text.matchAll(expressions)) {
    const token = match[0];
    let date = null;
    if (Object.prototype.hasOwnProperty.call(RELATIVE_DAYS, token)) {
      date = calendarDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
      date.setDate(date.getDate() + RELATIVE_DAYS[token]);
    } else if (/^\d/.test(token)) {
      const absolute = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
      const monthDay = /^(\d{1,2})月(\d{1,2})日$/.exec(token);
      if (absolute) date = calendarDate(Number(absolute[1]), Number(absolute[2]), Number(absolute[3]));
      else if (monthDay) date = calendarDate(now.getFullYear(), Number(monthDay[1]), Number(monthDay[2]));
    } else {
      const week = /^([上下本这]?)(?:星期|礼拜|周)([一二三四五六日天]|\d+)?$/.exec(token);
      if (!week || (!week[1] && !week[2])) continue;
      const weekOffset = week[1] === '上' ? -7 : week[1] === '下' ? 7 : 0;
      const weekday = week[2] ? (QUICK_DATE_WEEKDAYS[week[2]] ?? Number(week[2])) : null;
      if (weekday !== null && !Object.prototype.hasOwnProperty.call(QUICK_DATE_WEEKDAYS, week[2]) && !/^[1-7]$/.test(week[2])) continue;
      date = calendarDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
      const offset = weekday === null ? weekOffset : weekOffset + weekday - (now.getDay() || 7);
      date.setDate(date.getDate() + offset);
    }
    const formatted = date && formatDate(date);
    if (formatted) return { text: token, start: match.index, end: match.index + token.length, date: formatted };
  }
  return null;
}
