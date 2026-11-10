window.__ModuleLoader__.load({
  id: '@local/work-panel',
  factory(require) {
    const React = require('react');
    const { useState, useMemo, useRef, useEffect } = React;
    const h = React.createElement;

    const STORAGE_KEY = '@local/work-panel:tasks:v1';
    const CHAT_KEY = '@local/work-panel:chat:v1';
    const THEME_KEY = '@local/work-panel:theme';
    const CHAT_ENDPOINT = '/api/work-panel/chat';

    const STATUS = { todo: '待办', done: '已完成' };
    const URGENCY = { high: '高', medium: '中', low: '低', none: '无' };
    const URGENCY_FULL = { high: '高优先级', medium: '中优先级', low: '低优先级', none: '无优先级' };
    const URGENCY_ORDER = ['high', 'medium', 'low', 'none'];
    const URGENCY_WEIGHT = { high: 4, medium: 3, low: 2, none: 1 };
    const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

    function pad2(n) { return String(n).padStart(2, '0'); }
    function clamp(n) { const v = Number(n) || 0; return Math.max(0, Math.min(100, Math.round(v))); }
    function uid() { return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }

    function loadTasks() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
          .filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string')
          .map((t) => {
            const done = t.status === 'done';
            return { ...t, status: done ? 'done' : 'todo', progress: done ? 100 : 0 };
          });
      } catch { return []; }
    }
    function saveTasks(tasks) { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch { /* ignore */ } }
    function loadChat() {
      try {
        const raw = window.localStorage.getItem(CHAT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
      } catch { return null; }
    }
    function saveChat(messages) { try { window.localStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-40))); } catch { /* ignore */ } }
    function loadTheme() {
      try {
        const saved = window.localStorage.getItem(THEME_KEY);
        if (saved === 'light' || saved === 'dark') return saved;
      } catch { /* ignore */ }
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      } catch { /* ignore */ }
      return 'light';
    }
    function saveTheme(theme) { try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ } }

    // ---- deadline helpers -------------------------------------------------
    function makeDT(y, mo, d, hh, mm) { return y + '-' + pad2(mo) + '-' + pad2(d) + 'T' + pad2(hh) + ':' + pad2(mm); }
    function formatDeadline(deadline) {
      if (!deadline) return '';
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(deadline);
      if (!m) return deadline;
      const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
      const date = new Date(y, mo - 1, d);
      if (Number.isNaN(date.getTime())) return deadline;
      const base = y + '年' + mo + '月' + d + '日 周' + WEEKDAYS[date.getDay()];
      if (m[4] == null) return base;
      return base + ' ' + pad2(Number(m[4])) + ':' + pad2(Number(m[5]));
    }
    function deadlineMs(deadline) {
      if (!deadline) return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(deadline);
      if (!m) return null;
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
      return Number.isNaN(t) ? null : t;
    }
    function isOverdue(task) {
      if (!task.deadline || task.status === 'done') return false;
      const t = deadlineMs(task.deadline);
      return t !== null && t < Date.now();
    }

    const HOUR_MS = 3600 * 1000;
    const DAY_MS = 24 * HOUR_MS;

    function todayDate() {
      const d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    function shiftMonth(year, month, delta) {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    }

    const TIME_OPTIONS = (() => {
      const out = [];
      for (let h = 0; h < 24; h += 1) { out.push(pad2(h) + ':00'); out.push(pad2(h) + ':30'); }
      return out;
    })();

    function dateOnlyToDate(dateStr) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    }

    function startOfWeek(date) {
      const x = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const wd = x.getDay();
      x.setDate(x.getDate() - (wd === 0 ? 6 : wd - 1));
      return x;
    }

    /** Quick-add label: 今天/明天/后天/昨天/前天 → 周X/下周X/上周X → M月D日, plus optional time. */
    function formatQuickLabel(dateStr, time, now) {
      const d = dateOnlyToDate(dateStr);
      if (!d) return '';
      const current = now || new Date();
      const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
      const diffDays = Math.round((d.getTime() - today.getTime()) / DAY_MS);
      let label;
      if (diffDays === 0) label = '今天';
      else if (diffDays === 1) label = '明天';
      else if (diffDays === 2) label = '后天';
      else if (diffDays === -1) label = '昨天';
      else if (diffDays === -2) label = '前天';
      else {
        const weekDiff = Math.round((startOfWeek(d).getTime() - startOfWeek(today).getTime()) / (7 * DAY_MS));
        const wdLabel = '周' + WEEKDAYS[d.getDay()];
        if (weekDiff === 0) label = wdLabel;
        else if (weekDiff === 1) label = '下' + wdLabel;
        else if (weekDiff === -1) label = '上' + wdLabel;
        else label = (d.getMonth() + 1) + '月' + d.getDate() + '日';
      }
      return time ? label + ' ' + time : label;
    }

    function parseDeadline(deadline) {
      if (!deadline) return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(deadline);
      if (!m) return null;
      const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] != null ? Number(m[4]) : 0, m[5] != null ? Number(m[5]) : 0);
      return Number.isNaN(date.getTime()) ? null : { date, dateOnly: m[4] == null };
    }

    function formatTaskDate(deadline, now) {
      const parsed = parseDeadline(deadline);
      if (!parsed) return '未设置';
      const dateStr = parsed.date.getFullYear() + '-' + pad2(parsed.date.getMonth() + 1) + '-' + pad2(parsed.date.getDate());
      const time = parsed.dateOnly ? '' : pad2(parsed.date.getHours()) + ':' + pad2(parsed.date.getMinutes());
      return formatQuickLabel(dateStr, time, now);
    }

    function normalizeDeadline(value) {
      if (typeof value !== 'string') return todayDate();
      const v = value.trim();
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      return todayDate();
    }

    /** Countdown text for the title row: >10d => M月D日, 1-10d => 剩余x天, <1d => 剩余x小时, overdue => 过期x小时/天. */
    function formatRelativeTime(deadline, now) {
      const current = now || new Date();
      const parsed = parseDeadline(deadline);
      if (!parsed) return null;
      const { date, dateOnly } = parsed;
      if (dateOnly) {
        const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
        const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const dayDiff = Math.round((target - today) / DAY_MS);
        if (dayDiff === 0) return { text: '今天', icon: false };
        if (dayDiff > 0) return { text: (date.getMonth() + 1) + '月' + date.getDate() + '日', icon: false };
        return { text: '过期' + (-dayDiff) + '天', icon: false, overdue: true };
      }
      const diff = date.getTime() - current.getTime();
      if (diff < 0) {
        const overdue = -diff;
        if (overdue >= DAY_MS) return { text: '过期' + Math.floor(overdue / DAY_MS) + '天', icon: false, overdue: true };
        return { text: '过期' + Math.max(1, Math.floor(overdue / HOUR_MS)) + '小时', icon: false, overdue: true };
      }
      if (diff > 10 * DAY_MS) return { text: (date.getMonth() + 1) + '月' + date.getDate() + '日', icon: false };
      if (diff >= DAY_MS) return { text: '剩余 ' + Math.ceil(diff / DAY_MS) + '天', icon: false };
      return { text: '剩余 ' + Math.max(1, Math.ceil(diff / HOUR_MS)) + '小时', icon: true };
    }

    function isTodayDeadline(deadline) {
      const parsed = parseDeadline(deadline);
      if (!parsed) return false;
      const now = new Date();
      return parsed.date.getFullYear() === now.getFullYear()
        && parsed.date.getMonth() === now.getMonth()
        && parsed.date.getDate() === now.getDate();
    }

    function formatDateTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    // ---- progress -> status state machine --------------------------------
    function progressTransition(task, rawValue) {
      if (task.status === 'done') return null;
      const progress = clamp(rawValue);
      const status = progress >= 100 ? 'done' : progress > 0 ? 'doing' : 'todo';
      return { progress, status };
    }
    function statusTransition(task, newStatus) {
      const next = newStatus === 'done' ? 'done' : 'todo';
      return { status: next, progress: next === 'done' ? 100 : 0 };
    }
    function reopenedState() { return { status: 'todo', progress: 0 }; }

    function buildTaskFromModel(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const title = typeof raw.title === 'string' ? raw.title.trim() : '';
      if (!title) return null;
      const done = raw.status === 'done';
      const iso = new Date().toISOString();
      return {
        id: uid(), title, description: '',
        status: done ? 'done' : 'todo',
        urgency: URGENCY[raw.urgency] ? raw.urgency : 'medium',
        progress: done ? 100 : 0,
        deadline: normalizeDeadline(raw.deadline),
        createdAt: iso, updatedAt: iso,
      };
    }

    function buildConfirmation(task) {
      return ['已创建任务 ✅', '标题：' + task.title,
        '截止：' + (task.deadline ? formatDeadline(task.deadline) : '未设置'),
        '紧急程度：' + URGENCY[task.urgency], '状态：' + (STATUS[task.status] || '待办')].join('\n');
    }
    function buildTaskListReply(tasks) {
      if (tasks.length === 0) return '目前还没有任务，在上方快速添加，或直接告诉我要做什么。';
      const open = tasks.filter((t) => t.status !== 'done');
      const rows = tasks.slice(0, 8).map((t) => '· [' + (STATUS[t.status] || '待办') + '] ' + t.title + (t.deadline ? ' · ' + formatDeadline(t.deadline) : ''));
      return '你共有 ' + tasks.length + ' 个任务，其中 ' + open.length + ' 个未完成：\n' + rows.join('\n');
    }

    // ---- local fallback NLU (used when the Host model is unavailable) ----
    function extractDeadline(text, now) {
      let rest = text;
      let dateParts = null;
      let m = rest.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/);
      if (m) { dateParts = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }; rest = rest.replace(m[0], ' '); }
      else {
        m = rest.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
        if (m) { dateParts = { y: now.getFullYear(), mo: Number(m[1]), d: Number(m[2]) }; rest = rest.replace(m[0], ' '); }
        else {
          m = rest.match(/(大后天|后天|明天|今天)/);
          if (m) {
            const offset = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[m[1]];
            const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
            dateParts = { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate() };
            rest = rest.replace(m[0], ' ');
          } else {
            m = rest.match(/(这|本|下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
            if (m) {
              const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0 };
              const target = map[m[2]];
              const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
              const cur = base.getDay();
              let diff = (target - cur + 7) % 7;
              if (m[1] === '下') diff += 7;
              else if (m[1] !== '这' && m[1] !== '本' && diff === 0) diff = 7;
              const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate() + diff);
              dateParts = { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate() };
              rest = rest.replace(m[0], ' ');
            }
          }
        }
      }
      let time = null;
      m = rest.match(/(上午|中午|下午|傍晚|晚上|凌晨|早上)?\s*(\d{1,2})\s*[:：时点]\s*(\d{1,2})?\s*分?/);
      if (m) {
        let hh = Number(m[2]); let mm = m[3] != null ? Number(m[3]) : 0;
        const period = m[1];
        if ((period === '下午' || period === '傍晚' || period === '晚上') && hh < 12) hh += 12;
        else if (period === '中午' && hh < 11) hh += 12;
        else if (period === '凌晨' && hh === 12) hh = 0;
        if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) { time = { hh, mm }; rest = rest.replace(m[0], ' '); }
      }
      if (dateParts === null && time === null) return null;
      const date = dateParts || { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() };
      return { value: makeDT(date.y, date.mo, date.d, time ? time.hh : 18, time ? time.mm : 0), rest };
    }
    function extractUrgency(text) {
      if (/(紧急|特急|加急|高优先|高优|最高|重要|尽快|立刻|马上)/.test(text)) return 'high';
      if (/(不急|低优先|低优|次要|有空|闲时|低)/.test(text)) return 'low';
      return 'medium';
    }
    function extractStatus(text) {
      if (/(已完成|做完了|完成了|已搞定|已结束|done)/i.test(text)) return { status: 'done', progress: 100 };
      if (/(进行中|在做|正在做|开始了|doing)/i.test(text)) return { status: 'doing', progress: 0 };
      return { status: 'todo', progress: 0 };
    }
    function cleanTitle(text) {
      let t = text;
      t = t.replace(/(截止到|截止至|截止|之前|以前|前|deadline)/gi, ' ');
      const prefix = /^(请|麻烦|帮我|给我|帮忙|帮|创建|新建|添加|增加|加|建|记录|记一下|记|提醒我|提醒|安排|新增|写个|写|一个|一条|一件|个|条|件|task|todo)[\s,，。.!！?？、:：;；]*/i;
      for (let i = 0; i < 8; i += 1) { const next = t.replace(prefix, ''); if (next === t) break; t = next; }
      t = t.replace(/(^|[\s,，。.!！?？、:：;；])(任务|待办|事项|提醒)(?=$|[\s,，。.!！?？、:：;；])/g, ' ');
      t = t.replace(/(紧急|特急|加急|高优先|高优|最高|重要|尽快|立刻|马上|不急|低优先|低优|次要|中优先|中优|有空时|有空|闲时|已完成|做完了|完成了|进行中|在做)/g, ' ');
      t = t.replace(/^[\s,，。.!！?？、:：;；\-—]+|[\s,，。.!！?？、:：;；\-—]+$/g, '');
      return t.replace(/\s{2,}/g, ' ').trim();
    }
    function detectIntent(text) {
      if (/^(你好|您好|hi|hello|嗨|在吗|hey|哈喽)[\s!！。.？?]*$/i.test(text)) return 'greeting';
      if (/(有(什么|哪些|啥)任务|任务列表|待办清单|查看任务|列出.{0,6}任务|我的任务|今天.{0,6}(做|任务)(什么|啥|哪)|还有什么|完成情况|进度如何)/.test(text)) return 'list';
      return 'create';
    }
    function parseTask(text, now) {
      const raw = String(text || '').trim();
      if (!raw || detectIntent(raw) !== 'create') return null;
      const deadlineHit = extractDeadline(raw, now);
      const title = cleanTitle(deadlineHit ? deadlineHit.rest : raw);
      if (title.length < 2) return null;
      const st = extractStatus(raw);
      return { title, deadline: deadlineHit ? deadlineHit.value : '', urgency: extractUrgency(raw), status: st.status, progress: st.progress };
    }

    // ---- Ant Design 5 design language ------------------------------------
    const CSS = `
      .wp-root {
        --wp-primary: #1677ff;
        --wp-primary-hover: #4096ff;
        --wp-primary-active: #0958d9;
        --wp-success: #52c41a;
        --wp-warning: #faad14;
        --wp-error: #ff4d4f;
        --wp-text: rgba(0, 0, 0, 0.88);
        --wp-text-secondary: rgba(0, 0, 0, 0.65);
        --wp-text-tertiary: rgba(0, 0, 0, 0.45);
        --wp-text-quaternary: rgba(0, 0, 0, 0.25);
        --wp-border: #d9d9d9;
        --wp-border-secondary: #f0f0f0;
        --wp-bg-container: #ffffff;
        --wp-bg-layout: #f5f5f5;
        --wp-fill: rgba(0, 0, 0, 0.04);
        --wp-fill-secondary: rgba(0, 0, 0, 0.06);
        --wp-radius: 6px;
        --wp-radius-lg: 8px;
        --wp-radius-sm: 4px;
        --wp-control-height: 32px;
        --wp-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
          'Noto Sans', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif,
          'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
        --wp-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.03), 0 1px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px 0 rgba(0, 0, 0, 0.02);
        --wp-shadow-hover: 0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05);
        --wp-nav-bg: rgba(255, 255, 255, 0.72);
        --wp-nav-border: rgba(0, 0, 0, 0.06);
        --wp-tab-active-bg: #1f1f1f;
        --wp-tab-active-fg: #ffffff;

        position: relative;
        display: flex;
        flex-direction: column;
        height: 100%;
        box-sizing: border-box;
        overflow: hidden;
        font-family: var(--wp-font);
        font-size: 14px;
        line-height: 1.5714;
        color: var(--wp-text);
        background: var(--wp-bg-layout);
        -webkit-font-smoothing: antialiased;
      }
      .wp-root[data-theme="dark"] {
        --wp-primary: #1668dc;
        --wp-primary-hover: #3c89e8;
        --wp-primary-active: #1554ad;
        --wp-text: rgba(255, 255, 255, 0.85);
        --wp-text-secondary: rgba(255, 255, 255, 0.65);
        --wp-text-tertiary: rgba(255, 255, 255, 0.45);
        --wp-text-quaternary: rgba(255, 255, 255, 0.25);
        --wp-border: #424242;
        --wp-border-secondary: #303030;
        --wp-bg-container: #141414;
        --wp-bg-layout: #000000;
        --wp-fill: rgba(255, 255, 255, 0.08);
        --wp-fill-secondary: rgba(255, 255, 255, 0.12);
        --wp-nav-bg: rgba(30, 30, 30, 0.72);
        --wp-nav-border: rgba(255, 255, 255, 0.1);
        --wp-tab-active-bg: #ffffff;
        --wp-tab-active-fg: #1f1f1f;
      }

      /* Floating top bar (left tabs + right tools) */
      .wp-topbar {
        position: absolute; top: 16px; left: 16px; right: 16px; z-index: 100;
        display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
        pointer-events: none;
      }
      .wp-topnav, .wp-toolbar { pointer-events: auto; }
      .wp-topnav {
        display: flex; align-items: center; gap: 4px; padding: 4px;
        height: 40px; box-sizing: border-box; min-width: 0;
        overflow-x: auto; scrollbar-width: none;
        background: var(--wp-nav-bg);
        -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        border: 1px solid var(--wp-nav-border); border-radius: 14px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
      }
      .wp-topnav::-webkit-scrollbar { display: none; }
      .wp-tab {
        flex-shrink: 0; height: 32px; padding: 0 14px; border: none; border-radius: 10px;
        background: transparent; color: var(--wp-text-secondary);
        font: inherit; font-size: 13.5px; line-height: 32px; white-space: nowrap;
        cursor: pointer; transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
      }
      .wp-tab:hover { color: var(--wp-text); background: var(--wp-fill); }
      .wp-tab[data-active='true'] {
        background: var(--wp-tab-active-bg); color: var(--wp-tab-active-fg);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
      }
      .wp-toolbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .wp-tool-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        height: 40px; box-sizing: border-box; padding: 0 14px;
        font: inherit; font-size: 13.5px; color: var(--wp-text);
        background: var(--wp-nav-bg);
        -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        border: 1px solid var(--wp-nav-border); border-radius: 12px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
        cursor: pointer; transition: background 0.2s, box-shadow 0.2s, color 0.2s;
      }
      .wp-tool-btn:hover { box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1); }
      .wp-tool-btn-icon { width: 40px; padding: 0; }

      .wp-main { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      .wp-main-body { flex: 1; min-height: 0; overflow: auto; padding: 72px 24px 24px; }

      .wp-card {
        background: var(--wp-bg-container); border: 1px solid var(--wp-border-secondary);
        border-radius: var(--wp-radius-lg); box-shadow: var(--wp-shadow); padding: 16px;
      }

      /* Quick add */
      .wp-quick { margin-bottom: 16px; }
      .wp-quick-box {
        position: relative; display: flex; align-items: center; gap: 8px;
        padding: 6px 8px 6px 14px;
        border: 1px solid var(--wp-border); border-radius: 10px;
        background: var(--wp-bg-container);
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .wp-quick-box:focus-within { border-color: var(--wp-primary); box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1); }
      .wp-quick-input {
        flex: 1; min-height: 24px; border: none; background: transparent; outline: none;
        font: inherit; font-size: 14px; color: var(--wp-text); padding: 4px 0;
      }
      .wp-quick-input::placeholder { color: var(--wp-text-quaternary); }
      .wp-quick-cal {
        display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
        height: 30px; padding: 0 10px; border: none; border-radius: 999px;
        background: rgba(22, 119, 255, 0.1); color: var(--wp-primary);
        font: inherit; font-size: 12px; font-weight: 500; white-space: nowrap;
        cursor: pointer; transition: background 0.15s, box-shadow 0.15s;
      }
      .wp-quick-cal:hover { background: rgba(22, 119, 255, 0.18); }
      .wp-quick-cal.wp-past { background: rgba(255, 77, 79, 0.1); color: var(--wp-error); }
      .wp-quick-cal.wp-past:hover { background: rgba(255, 77, 79, 0.18); }
      .wp-quick-cal.wp-active { box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.25); }
      .wp-quick-cal.wp-past.wp-active { box-shadow: 0 0 0 2px rgba(255, 77, 79, 0.25); }
      .wp-quick-cal-label { overflow: hidden; text-overflow: ellipsis; }
      .wp-cal-popover {
        position: absolute; top: calc(100% + 8px); right: 0; z-index: 300;
        width: 270px; padding: 12px;
        background: var(--wp-bg-container);
        border: 1px solid var(--wp-border-secondary); border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
      }
      .wp-cal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .wp-cal-title { font-size: 13px; font-weight: 600; color: var(--wp-text); }
      .wp-cal-nav { display: flex; gap: 4px; }
      .wp-cal-nav-btn {
        width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
        border: none; border-radius: 4px; background: transparent; color: var(--wp-text-secondary);
        font: inherit; font-size: 15px; line-height: 1; cursor: pointer;
      }
      .wp-cal-nav-btn:hover { background: var(--wp-fill); }
      .wp-cal-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; margin-bottom: 4px; }
      .wp-cal-weekday { text-align: center; font-size: 11px; line-height: 1.6; color: var(--wp-text-tertiary); }
      .wp-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
      .wp-cal-day {
        height: 28px; display: flex; align-items: center; justify-content: center;
        border: none; border-radius: 6px; background: transparent;
        font: inherit; font-size: 12px; color: var(--wp-text); cursor: pointer;
      }
      .wp-cal-day:hover { background: var(--wp-fill); }
      .wp-cal-day.wp-selected { background: var(--wp-primary); color: #fff; }
      .wp-cal-day.wp-today { color: var(--wp-primary); font-weight: 600; }
      .wp-cal-day.wp-selected.wp-today { color: #fff; }
      .wp-cal-day.wp-blank { cursor: default; }
      .wp-cal-time-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--wp-border-secondary); }
      .wp-cal-time-label { font-size: 12px; color: var(--wp-text-secondary); }
      .wp-cal-time-select {
        flex: 1; min-width: 0; box-sizing: border-box;
        font: inherit; font-size: 13px; color: var(--wp-text);
        background: var(--wp-bg-container); border: 1px solid var(--wp-border);
        border-radius: var(--wp-radius); padding: 4px 6px; outline: none;
      }
      .wp-cal-time-select:focus { border-color: var(--wp-primary); }
      .wp-cal-footer { display: flex; justify-content: space-between; gap: 8px; margin-top: 10px; }
      .wp-cal-btn { min-height: 26px; padding: 2px 12px; font-size: 12px; }

      .wp-overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
      .wp-stat {
        background: var(--wp-bg-container); border: 1px solid var(--wp-border-secondary);
        border-radius: var(--wp-radius-lg); box-shadow: var(--wp-shadow); padding: 16px;
      }
      .wp-stat-title { margin: 0; font-size: 14px; color: var(--wp-text-secondary); }
      .wp-stat-value { margin: 8px 0 0; font-size: 30px; font-weight: 600; line-height: 1.2; color: var(--wp-text); }
      .wp-stat-value.wp-accent-doing { color: var(--wp-primary); }
      .wp-stat-value.wp-accent-done { color: var(--wp-success); }
      .wp-summary { display: flex; flex-wrap: wrap; gap: 16px; margin: -4px 0 16px; font-size: 13px; color: var(--wp-text-secondary); }
      .wp-summary b { color: var(--wp-text); font-weight: 600; }
      .wp-summary .wp-summary-overdue { color: var(--wp-error); }
      .wp-summary .wp-summary-overdue b { color: var(--wp-error); }

      .wp-input, .wp-select, .wp-textarea {
        box-sizing: border-box; width: 100%; min-height: var(--wp-control-height);
        font: inherit; font-size: 14px; color: var(--wp-text);
        background: var(--wp-bg-container); border: 1px solid var(--wp-border);
        border-radius: var(--wp-radius); padding: 4px 11px; outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .wp-textarea { resize: vertical; min-height: 56px; padding: 6px 11px; }
      .wp-input:hover, .wp-select:hover, .wp-textarea:hover { border-color: var(--wp-primary-hover); }
      .wp-input:focus, .wp-select:focus, .wp-textarea:focus { border-color: var(--wp-primary); box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1); }
      .wp-input::placeholder, .wp-textarea::placeholder { color: var(--wp-text-quaternary); }

      .wp-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .wp-field-grow { flex: 1 1 240px; }
      .wp-field-label { font-size: 14px; color: var(--wp-text); }

      .wp-btn {
        display: inline-flex; align-items: center; justify-content: center;
        box-sizing: border-box; min-height: var(--wp-control-height); padding: 4px 15px;
        font: inherit; font-size: 14px; line-height: 1.5714; white-space: nowrap;
        cursor: pointer; border-radius: var(--wp-radius); border: 1px solid transparent;
        transition: all 0.2s; outline: none;
      }
      .wp-btn:focus-visible { box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1); }
      .wp-btn-primary { color: #fff; background: var(--wp-primary); box-shadow: 0 2px 0 rgba(5, 145, 255, 0.1); }
      .wp-btn-primary:hover { background: var(--wp-primary-hover); }
      .wp-btn-primary:active { background: var(--wp-primary-active); }
      .wp-btn-primary:disabled { color: rgba(0,0,0,0.25); background: var(--wp-fill-secondary); box-shadow: none; cursor: not-allowed; }
      .wp-btn-default { color: var(--wp-text); background: var(--wp-bg-container); border-color: var(--wp-border); }
      .wp-btn-default:hover { color: var(--wp-primary); border-color: var(--wp-primary); }
      .wp-btn-text { color: var(--wp-primary); background: transparent; }
      .wp-btn-text:hover { color: var(--wp-primary-hover); background: var(--wp-fill); }
      .wp-btn-text.wp-danger { color: var(--wp-error); }
      .wp-btn-text.wp-danger:hover { background: rgba(255, 77, 79, 0.08); }

      .wp-segmented { display: inline-flex; padding: 2px; margin-bottom: 16px; background: var(--wp-fill); border-radius: var(--wp-radius); }
      .wp-segmented-item {
        min-height: 24px; padding: 3px 12px; font: inherit; font-size: 14px; line-height: 1.5714;
        color: var(--wp-text); cursor: pointer; border: none; background: transparent; border-radius: 5px; transition: all 0.2s;
      }
      .wp-segmented-item[data-active='true'] { background: var(--wp-bg-container); box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.06); }

      .wp-list { display: flex; flex-direction: column; gap: 12px; }
      .wp-task {
        background: var(--wp-bg-container); border: 1px solid var(--wp-border-secondary);
        border-radius: var(--wp-radius-lg); box-shadow: var(--wp-shadow); padding: 14px 16px; transition: box-shadow 0.2s;
      }
      .wp-task:hover { box-shadow: var(--wp-shadow-hover); }
      .wp-task-head { display: flex; align-items: flex-start; gap: 8px; }
      .wp-task-main { flex: 1; min-width: 0; }
      .wp-task-title-row { display: flex; align-items: center; gap: 8px; }
      .wp-task-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 15px; font-weight: 500; line-height: 1.5; color: var(--wp-text); overflow-wrap: anywhere; }
      .wp-task-title.wp-done { color: var(--wp-text-tertiary); text-decoration: line-through; }
      .wp-task-time { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; line-height: 1.4; color: var(--wp-text-secondary); white-space: nowrap; }
      .wp-task-time.wp-time-overdue { color: var(--wp-error); }
      .wp-task-desc { margin: 4px 0 0; font-size: 14px; color: var(--wp-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-task-check {
        --wp-check-color: var(--wp-text-tertiary);
        flex-shrink: 0; width: 18px; height: 18px; margin-top: 3px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1.5px solid var(--wp-check-color); border-radius: 50%;
        background: transparent; color: #fff; cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .wp-task-check.wp-check-high { --wp-check-color: var(--wp-error); }
      .wp-task-check.wp-check-medium { --wp-check-color: var(--wp-warning); }
      .wp-task-check.wp-check-low { --wp-check-color: var(--wp-text-tertiary); }
      .wp-task-check.wp-checked { background: var(--wp-check-color); border-color: var(--wp-check-color); }
      .wp-task-kanban { padding: 10px; }
      .wp-task-drag {
        display: inline-flex; align-items: center; justify-content: center;
        color: var(--wp-text-tertiary); cursor: grab; margin-right: 2px;
      }
      .wp-task-drag:active { cursor: grabbing; }

      /* Board / Kanban */
      .wp-board-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
      .wp-board-toolbar .wp-segmented { margin-bottom: 0; }

      .wp-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 16px; text-align: center; }
      .wp-empty-icon { width: 64px; height: 41px; margin-bottom: 8px; color: var(--wp-text-quaternary); }
      .wp-empty-desc { margin: 0; font-size: 14px; color: var(--wp-text-tertiary); }

      /* Dashboard charts */
      .wp-dash-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .wp-chart-card {
        background: var(--wp-bg-container); border: 1px solid var(--wp-border-secondary);
        border-radius: var(--wp-radius-lg); box-shadow: var(--wp-shadow); padding: 16px;
      }
      .wp-chart-title { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: var(--wp-text); }
      .wp-chart-donut { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
      .wp-legend { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 120px; }
      .wp-legend-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      .wp-legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .wp-legend-label { color: var(--wp-text-secondary); }
      .wp-legend-value { margin-left: auto; color: var(--wp-text); font-weight: 600; font-variant-numeric: tabular-nums; }
      .wp-hbars { display: flex; flex-direction: column; gap: 14px; }
      .wp-hbar { display: flex; align-items: center; gap: 10px; font-size: 13px; }
      .wp-hbar-label { width: 36px; color: var(--wp-text-secondary); flex-shrink: 0; }
      .wp-hbar-track { flex: 1; height: 8px; background: var(--wp-fill); border-radius: 100px; overflow: hidden; }
      .wp-hbar-fill { height: 100%; border-radius: 100px; transition: width 0.3s; min-width: 2px; }
      .wp-hbar-value { width: 28px; text-align: right; color: var(--wp-text); font-weight: 600; font-variant-numeric: tabular-nums; }
      .wp-chart-ring { display: flex; justify-content: center; align-items: center; padding: 4px 0; }
      .wp-upcoming { display: flex; flex-direction: column; gap: 10px; }
      .wp-upcoming-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
      .wp-upcoming-title { color: var(--wp-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wp-upcoming-date { color: var(--wp-text-secondary); font-size: 12px; flex-shrink: 0; }
      .wp-muted { color: var(--wp-text-tertiary); font-size: 13px; padding: 8px 0; }

      /* Right assistant drawer */
      .wp-drawer {
        position: absolute; top: 8px; right: 8px; bottom: 8px; z-index: 150;
        display: flex; flex-direction: column;
        width: min(400px, calc(100% - 16px));
        background: var(--wp-bg-container);
        border: 1px solid var(--wp-border-secondary);
        border-radius: 14px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16), 0 3px 6px -4px rgba(0, 0, 0, 0.12);
        animation: wp-drawer-in 0.22s ease;
      }
      @keyframes wp-drawer-in {
        from { transform: translateX(28px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      .wp-drawer-head {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 16px; border-bottom: 1px solid var(--wp-border-secondary);
      }
      .wp-drawer-title { font-size: 13px; font-weight: 600; color: var(--wp-text); }
      .wp-drawer-sub { font-size: 12px; color: var(--wp-text-tertiary); }
      .wp-drawer-close {
        margin-left: auto; display: flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; border: none; border-radius: var(--wp-radius-sm);
        background: transparent; color: var(--wp-text-secondary); font-size: 18px; line-height: 1; cursor: pointer;
      }
      .wp-drawer-close:hover { color: var(--wp-text); background: var(--wp-fill); }
      .wp-drawer-thread {
        flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
        display: flex; flex-direction: column; gap: 8px; padding: 14px 16px;
      }
      .wp-msg { display: flex; flex-direction: column; max-width: 90%; }
      .wp-msg-user { align-self: flex-end; align-items: flex-end; }
      .wp-msg-assistant { align-self: flex-start; align-items: flex-start; }
      .wp-msg-bubble {
        padding: 7px 11px; border-radius: var(--wp-radius-lg); font-size: 13px; line-height: 1.6;
        white-space: pre-wrap; overflow-wrap: anywhere;
      }
      .wp-msg-user .wp-msg-bubble { color: #fff; background: var(--wp-primary); border-top-right-radius: 2px; }
      .wp-msg-assistant .wp-msg-bubble { color: var(--wp-text); background: var(--wp-fill); border-top-left-radius: 2px; }
      .wp-typing { color: var(--wp-text-tertiary); }
      .wp-drawer-suggestions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 10px; }
      .wp-suggestion {
        font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px;
        border: 1px solid var(--wp-border); background: var(--wp-bg-container);
        color: var(--wp-text-secondary); cursor: pointer; transition: color 0.2s, border-color 0.2s;
      }
      .wp-suggestion:hover { color: var(--wp-primary); border-color: var(--wp-primary); }
      .wp-drawer-composer { display: flex; padding: 10px 8px 10px; border-top: 1px solid var(--wp-border-secondary); }
      .wp-composer-box {
        flex: 1; display: flex; align-items: flex-end; gap: 6px;
        padding: 6px 6px 6px 12px; border: 1px solid var(--wp-border); border-radius: 12px;
        background: var(--wp-bg-container);
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .wp-composer-box:focus-within { border-color: var(--wp-primary); box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1); }
      .wp-composer-input {
        flex: 1; min-height: 24px; max-height: 100px; resize: none; font: inherit; font-size: 13px;
        color: var(--wp-text); background: transparent; border: none; outline: none; padding: 4px 0;
      }
      .wp-composer-input::placeholder { color: var(--wp-text-quaternary); }
      .wp-send-btn {
        display: flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; flex-shrink: 0;
        border: none; border-radius: 8px; background: var(--wp-primary); color: #fff;
        cursor: pointer; transition: background 0.2s;
      }
      .wp-send-btn:hover { background: var(--wp-primary-hover); }
      .wp-send-btn:disabled { background: var(--wp-fill-secondary); color: var(--wp-text-quaternary); cursor: not-allowed; }

      /* ---------- Workbench layout (Phase 1) ---------- */
      .wp-workbench { display: flex; flex: 1; min-height: 0; overflow: hidden; }
      .wp-sidenav {
        width: 208px; flex-shrink: 0; display: flex; flex-direction: column;
        padding: 14px 10px; gap: 2px; overflow-y: auto;
        background: var(--wp-bg-layout);
        border-right: 1px solid var(--wp-border-secondary);
      }
      .wp-sidenav-title { font-size: 15px; font-weight: 600; padding: 2px 10px 10px; }
      .wp-nav-item {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 7px 10px; border: none; border-radius: 8px;
        background: transparent; color: var(--wp-text-secondary);
        font: inherit; font-size: 13px; text-align: left; cursor: pointer;
      }
      .wp-nav-item:hover { background: var(--wp-fill); color: var(--wp-text); }
      .wp-nav-item.wp-active { background: rgba(22, 119, 255, 0.1); color: var(--wp-primary); font-weight: 500; }
      .wp-nav-count { font-size: 12px; color: var(--wp-text-tertiary); }
      .wp-nav-item.wp-active .wp-nav-count { color: var(--wp-primary); }
      .wp-sidenav-spacer { flex: 1; }

      .wp-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--wp-bg-container); }
      .wp-mid-head {
        display: flex; align-items: flex-end; justify-content: space-between; gap: 12px;
        padding: 14px 20px 10px; border-bottom: 1px solid var(--wp-border-secondary);
      }
      .wp-mid-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.3; }
      .wp-mid-stats { margin: 2px 0 0; font-size: 12px; color: var(--wp-text-secondary); }
      .wp-mid-head-right { display: flex; align-items: center; gap: 8px; }
      .wp-search { position: relative; display: flex; align-items: center; }
      .wp-search-icon { position: absolute; left: 9px; color: var(--wp-text-tertiary); pointer-events: none; display: flex; }
      .wp-search-input {
        width: 170px; height: 32px; box-sizing: border-box;
        font: inherit; font-size: 13px; color: var(--wp-text);
        background: var(--wp-bg-container); border: 1px solid var(--wp-border);
        border-radius: 8px; padding: 4px 10px 4px 30px; outline: none;
      }
      .wp-search-input:focus { border-color: var(--wp-primary); }
      .wp-icon-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        height: 32px; min-width: 32px; padding: 0 8px;
        border: 1px solid var(--wp-border); border-radius: 8px;
        background: var(--wp-bg-container); color: var(--wp-text-secondary);
        font: inherit; font-size: 13px; cursor: pointer;
      }
      .wp-icon-btn:hover { color: var(--wp-text); background: var(--wp-fill); }
      .wp-assist-btn { color: var(--wp-primary); border-color: rgba(22, 119, 255, 0.35); }

      .wp-mid-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 20px 24px; }
      .wp-mid-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
      .wp-mid-toolbar-left, .wp-mid-toolbar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wp-sort-select {
        height: 30px; box-sizing: border-box;
        font: inherit; font-size: 12.5px; color: var(--wp-text);
        background: var(--wp-bg-container); border: 1px solid var(--wp-border);
        border-radius: 8px; padding: 0 8px; outline: none; cursor: pointer;
      }

      .wp-task-list { display: flex; flex-direction: column; }
      .wp-group { margin-bottom: 6px; }
      .wp-group-head {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 6px 4px; border: none; background: transparent; cursor: pointer; text-align: left;
      }
      .wp-group-title { font-size: 12px; font-weight: 600; color: var(--wp-text-secondary); }
      .wp-group-count { font-size: 12px; color: var(--wp-text-tertiary); }
      .wp-group-toggle { margin-left: auto; font-size: 12px; color: var(--wp-text-tertiary); }
      .wp-group-rows { display: flex; flex-direction: column; }
      .wp-row {
        display: flex; align-items: flex-start; gap: 10px;
        padding: 11px 8px; border-bottom: 1px solid var(--wp-border-secondary);
        border-radius: 8px; cursor: pointer;
      }
      .wp-row:hover { background: var(--wp-fill); }
      .wp-row-check {
        --wp-check-color: var(--wp-text-tertiary);
        flex-shrink: 0; width: 18px; height: 18px; margin-top: 2px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1.5px solid var(--wp-check-color); border-radius: 4px;
        background: transparent; color: #fff; cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .wp-row-check.wp-check-high { --wp-check-color: var(--wp-error); }
      .wp-row-check.wp-check-medium { --wp-check-color: var(--wp-warning); }
      .wp-row-check.wp-check-low { --wp-check-color: var(--wp-primary); }
      .wp-row-check.wp-check-none { --wp-check-color: var(--wp-text-tertiary); }
      .wp-row-check.wp-checked { background: var(--wp-check-color); border-color: var(--wp-check-color); }
      .wp-row-main { flex: 1; min-width: 0; }
      .wp-row-title { font-size: 15px; color: var(--wp-text); line-height: 1.5; overflow-wrap: anywhere; }
      .wp-row-title.wp-done { color: var(--wp-text-tertiary); text-decoration: line-through; }
      .wp-row-desc { margin-top: 2px; font-size: 12.5px; color: var(--wp-text-secondary); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
      .wp-row-time { flex-shrink: 0; margin-top: 2px; font-size: 12px; color: var(--wp-text-secondary); white-space: nowrap; }
      .wp-row-time.wp-overdue { color: var(--wp-error); }
      .wp-row-time.wp-today { color: var(--wp-warning); }

      .wp-detail {
        width: 400px; flex-shrink: 0; display: flex; flex-direction: column;
        background: var(--wp-bg-container); border-left: 1px solid var(--wp-border-secondary);
      }
      .wp-detail-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; }
      .wp-detail-meta { position: relative; display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
      .wp-detail-check {
        --wp-check-color: var(--wp-text-tertiary);
        flex-shrink: 0; width: 20px; height: 20px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1.5px solid var(--wp-check-color); border-radius: 4px;
        background: transparent; color: #fff; cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .wp-detail-check.wp-check-high { --wp-check-color: var(--wp-error); }
      .wp-detail-check.wp-check-medium { --wp-check-color: var(--wp-warning); }
      .wp-detail-check.wp-check-low { --wp-check-color: var(--wp-primary); }
      .wp-detail-check.wp-check-none { --wp-check-color: var(--wp-text-tertiary); }
      .wp-detail-check.wp-checked { background: var(--wp-check-color); border-color: var(--wp-check-color); }
      .wp-detail-sep { color: var(--wp-text-quaternary); }
      .wp-detail-date {
        display: inline-flex; align-items: center;
        height: 26px; padding: 0 10px; border: none; border-radius: 6px;
        background: rgba(22, 119, 255, 0.1); color: var(--wp-primary);
        font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer;
        transition: background 0.15s;
      }
      .wp-detail-date:hover { background: rgba(22, 119, 255, 0.18); }
      .wp-detail-flag {
        margin-left: auto; display: flex; align-items: center; justify-content: center;
        width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px;
        background: transparent; cursor: pointer; transition: background 0.15s;
      }
      .wp-detail-flag:hover { background: var(--wp-fill); }
      .wp-detail-flag.wp-flag-high { color: var(--wp-error); }
      .wp-detail-flag.wp-flag-medium { color: var(--wp-warning); }
      .wp-detail-flag.wp-flag-low { color: var(--wp-primary); }
      .wp-detail-flag.wp-flag-none { color: var(--wp-text-tertiary); }
      .wp-prio-menu {
        position: absolute; z-index: 200; top: 34px; right: 0;
        display: flex; flex-direction: column; gap: 2px;
        min-width: 140px; padding: 6px;
        background: var(--wp-bg-container); border: 1px solid var(--wp-border-secondary);
        border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
      }
      .wp-prio-menu-item {
        display: flex; align-items: center; gap: 8px;
        padding: 7px 8px; border: none; border-radius: 6px;
        background: transparent; color: var(--wp-text); font: inherit; font-size: 13px;
        cursor: pointer; text-align: left;
      }
      .wp-prio-menu-item:hover { background: var(--wp-fill); }
      .wp-prio-dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
      .wp-prio-dot-high { background: var(--wp-error); }
      .wp-prio-dot-medium { background: var(--wp-warning); }
      .wp-prio-dot-low { background: var(--wp-primary); }
      .wp-prio-dot-none { background: var(--wp-text-tertiary); }
      .wp-detail-task-title { margin: 0 0 8px; font-size: 18px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
      .wp-detail-task-title.wp-done { color: var(--wp-text-tertiary); text-decoration: line-through; }
      .wp-detail-desc { margin: 0 0 16px; font-size: 14px; color: var(--wp-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-detail-desc.wp-empty { color: var(--wp-text-quaternary); }
      .wp-detail-rows { display: flex; flex-direction: column; }
      .wp-detail-times { margin-top: 28px; }
      .wp-detail-row { display: flex; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--wp-border-secondary); }
      .wp-detail-row:last-child { border-bottom: none; }
      .wp-detail-label { width: 64px; flex-shrink: 0; font-size: 13px; color: var(--wp-text-secondary); }
      .wp-detail-value { flex: 1; font-size: 13px; color: var(--wp-text); }
      .wp-detail-input {
        width: 100%; box-sizing: border-box;
        font: inherit; color: var(--wp-text);
        background: transparent; border: none; outline: none;
        padding: 4px 0; resize: none; caret-color: var(--wp-primary);
      }
      .wp-detail-input::placeholder { color: var(--wp-text-quaternary); }
      .wp-detail-title-input {
        font-size: 18px; font-weight: 600; line-height: 1.4;
        margin: 0 0 8px;
      }
      .wp-detail-desc-input {
        font-size: 14px; line-height: 1.6; min-height: 96px;
        margin: 0 0 16px; color: var(--wp-text-secondary);
      }
      .wp-status-seg { display: inline-flex; padding: 2px; background: var(--wp-fill); border-radius: 6px; gap: 2px; }
      .wp-status-seg-item {
        border: none; border-radius: 4px; background: transparent;
        padding: 3px 10px; font: inherit; font-size: 12.5px;
        color: var(--wp-text-secondary); cursor: pointer;
      }
      .wp-status-seg-item[data-active='true'] { background: var(--wp-bg-container); color: var(--wp-primary); font-weight: 500; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }

      @media (max-width: 1200px) { .wp-detail { width: 360px; } }
      @media (max-width: 980px) {
        .wp-detail {
          position: absolute; top: 0; right: 0; bottom: 0; z-index: 120;
          width: min(400px, calc(100% - 40px)); box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
        }
      }
      @media (max-width: 760px) {
        .wp-sidenav { display: none; }
        .wp-mid-head { padding: 12px 14px 8px; }
        .wp-mid-body { padding: 12px 14px 20px; }
        .wp-search-input { width: 120px; }
        .wp-detail { width: 100%; }
      }

      @media (max-width: 760px) {
        .wp-main-body { padding: 68px 16px 20px; }
        .wp-tab { padding: 0 10px; font-size: 12.5px; }
        .wp-tool-btn { padding: 0 10px; }
        .wp-tool-btn-icon { width: 40px; padding: 0; }
        .wp-tool-label { display: none; }
        .wp-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .wp-dash-grid { grid-template-columns: 1fr; }
        .wp-topbar { left: 12px; right: 12px; top: 12px; }
        .wp-drawer { width: calc(100% - 16px); }
      }
    `;

    function SidebarIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block', color: 'inherit' } },
        h('path', { fill: 'currentColor', d: 'M7 3h10a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2V4a1 1 0 0 1 1-1Zm1 4h8V5H8v2Zm-3 3v9h14v-9H5Zm4.1 1.3 1.2 1.2 4.3-4.3 1.3 1.3-5.6 5.6-2.5-2.5 1.3-1.3Z' }));
    }
    function EmptyIcon() {
      return h('svg', { className: 'wp-empty-icon', viewBox: '0 0 64 41', 'aria-hidden': true },
        h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: '2' },
          h('path', { d: 'M4 8a4 4 0 0 1 4-4h34l14 14v19a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Z' }),
          h('path', { d: 'M42 4v12h14' }),
          h('path', { d: 'M20 22h18M20 30h10' })));
    }
    function SparkIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 14;
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flexShrink: 0 } },
        h('path', { fill: 'currentColor', d: 'M12 2.5 14 8l5.5 2L14 12l-2 5.5L10 12 4.5 10 10 8l2-5.5Zm7 9.5.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4Z' }));
    }
    function SunIcon() {
      const rays = [];
      for (let i = 0; i < 8; i += 1) {
        const a = (i * Math.PI) / 4;
        rays.push(h('line', {
          key: i,
          x1: 12 + Math.cos(a) * 6.5, y1: 12 + Math.sin(a) * 6.5,
          x2: 12 + Math.cos(a) * 9, y2: 12 + Math.sin(a) * 9,
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        }));
      }
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 4.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
        ...rays);
    }
    function MoonIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          d: 'M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z' }));
    }
    function ChatIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          d: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3.5V6Z' }));
    }
    function SendIcon() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
          d: 'M22 2 11 13M22 2 15 22l-4-9-9-4 20-7Z' }));
    }
    function CheckIcon() {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 3.2, strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M4 12l5 5L20 6' }));
    }
    function AlarmIcon() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flexShrink: 0 } },
        h('path', { fill: 'currentColor', d: 'M12 2a6 6 0 0 0-6 6v4.5L4.5 15v1.5h15V15L18 12.5V8a6 6 0 0 0-6-6Zm-2 16a2 2 0 0 0 4 0h-4Z' }));
    }
    function CalDayIcon(props) {
      const day = props && props.day;
      return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flexShrink: 0 } },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
          d: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm-1 5h16M8 3v4m8-4v4' }),
        h('text', { x: 12, y: 16.5, textAnchor: 'middle', fontSize: 8.5, fontWeight: 700, fill: 'currentColor' }, String(day == null ? '' : day)));
    }
    function SearchIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', d: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 5 5' }));
    }
    function FlagIcon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flexShrink: 0 } },
        h('path', { fill: 'currentColor', d: 'M6 3h2v18H6V3Zm2 1h10l-2.5 4 2.5 4H8V4Z' }));
    }
    const INITIAL_ASSISTANT_MESSAGE = {
      role: 'assistant',
      text: '你好，我是任务助手 👋\n直接告诉我要做什么，我会识别标题、截止时间与紧急程度并创建任务，例如「明天10点前完成季度报告，紧急」；也可以问我「我有哪些任务」。',
    };

    function WorkPanel() {
      const [tasks, setTasks] = useState(loadTasks);
      const [activeView, setActiveView] = useState('all');
      const [sortBy, setSortBy] = useState('deadline');
      const [search, setSearch] = useState('');
      const [selectedId, setSelectedId] = useState(null);
      const [collapsedGroups, setCollapsedGroups] = useState({ done: true });
      const [quickText, setQuickText] = useState('');
      const [quickDeadline, setQuickDeadline] = useState(() => ({ date: todayDate(), time: '' }));
      const [calOpen, setCalOpen] = useState(false);
      const [calMonth, setCalMonth] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
      const [messages, setMessages] = useState(() => loadChat() || [INITIAL_ASSISTANT_MESSAGE]);
      const [cmdInput, setCmdInput] = useState('');
      const [sending, setSending] = useState(false);
      const [assistantOpen, setAssistantOpen] = useState(false);
      const [theme, setTheme] = useState(loadTheme);
      const [flagOpen, setFlagOpen] = useState(false);
      const [detailCalOpen, setDetailCalOpen] = useState(false);
      const [detailCalMonth, setDetailCalMonth] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
      const chatScrollRef = useRef(null);
      const sendingRef = useRef(false);
      const quickInputRef = useRef(null);
      const cmdInputRef = useRef(null);
      const calRef = useRef(null);

      useEffect(() => {
        const el = chatScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [messages, sending, assistantOpen]);

      useEffect(() => { saveChat(messages); }, [messages]);
      useEffect(() => { saveTheme(theme); }, [theme]);
      useEffect(() => { setFlagOpen(false); setDetailCalOpen(false); }, [selectedId]);
      useEffect(() => {
        if (!calOpen) return undefined;
        const onDown = (e) => {
          if (calRef.current && !calRef.current.contains(e.target)) setCalOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [calOpen]);

      const commit = (next) => { setTasks(next); saveTasks(next); };
      const addTaskToState = (task) => {
        setTasks((prev) => { const next = [task, ...prev]; saveTasks(next); return next; });
      };

      const applyStatus = (task, newStatus) => {
        const next = statusTransition(task, newStatus);
        commit(tasks.map((t) => (t.id === task.id ? { ...t, ...next, updatedAt: new Date().toISOString() } : t)));
      };
      const reopenTask = (task) => commit(tasks.map((t) => (t.id === task.id ? { ...t, ...reopenedState(), updatedAt: new Date().toISOString() } : t)));
      const toggleDone = (task) => { if (task.status === 'done') reopenTask(task); else applyStatus(task, 'done'); };
      const updateTask = (id, patch) => commit(tasks.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t)));
      const addQuick = () => {
        const title = quickText.trim();
        if (!title) { if (quickInputRef.current) quickInputRef.current.focus(); return; }
        const iso = new Date().toISOString();
        const deadline = quickDeadline.time ? quickDeadline.date + 'T' + quickDeadline.time : quickDeadline.date;
        const task = {
          id: uid(), title, description: '', status: 'todo', urgency: 'medium', progress: 0,
          deadline, createdAt: iso, updatedAt: iso,
        };
        addTaskToState(task);
        setQuickText('');
        setQuickDeadline({ date: todayDate(), time: '' });
        setCalOpen(false);
        if (quickInputRef.current) quickInputRef.current.focus();
      };

      const sendChat = async (textArg) => {
        const text = (typeof textArg === 'string' ? textArg : cmdInput).trim();
        if (!text || sendingRef.current) return;
        if (typeof textArg !== 'string') setCmdInput('');
        setAssistantOpen(true);
        sendingRef.current = true;
        setSending(true);
        const userMsg = { role: 'user', text };
        const history = messages.concat([userMsg]);
        setMessages(history);

        const fallback = () => {
          const intent = detectIntent(text);
          if (intent === 'greeting') return '你好！直接告诉我要做什么就能创建任务，例如「明天10点前完成报告，紧急」。';
          if (intent === 'list') return buildTaskListReply(tasks);
          const parsed = parseTask(text, new Date());
          if (parsed) {
            const iso = new Date().toISOString();
            const done = parsed.status === 'done';
            const task = {
              id: uid(), title: parsed.title, description: '', status: done ? 'done' : 'todo',
              urgency: parsed.urgency, progress: done ? 100 : 0, deadline: parsed.deadline || todayDate(),
              createdAt: iso, updatedAt: iso,
            };
            addTaskToState(task);
            return '（模型暂不可用，本次由本地规则解析）\n' + buildConfirmation(task);
          }
          return '模型暂时不可用，我也没理解这条任务。可以试试「明天10点前完成季度报告，紧急」。';
        };

        try {
          const res = await fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              messages: history.slice(-12).map((m) => ({ role: m.role, text: m.text })),
              tasks: tasks.slice(0, 50).map((t) => ({ title: t.title, status: t.status, urgency: t.urgency, progress: t.progress, deadline: t.deadline })),
            }),
          });
          if (!res.ok) throw new Error('http-' + res.status);
          const data = await res.json();
          if (!data || data.error) throw new Error((data && data.error) || 'model-error');
          let reply = typeof data.reply === 'string' ? data.reply : '';
          if (data.task) {
            const task = buildTaskFromModel(data.task);
            if (task) {
              addTaskToState(task);
              if (!reply) reply = buildConfirmation(task);
            }
          }
          setMessages((prev) => [...prev, { role: 'assistant', text: reply || '已处理。' }]);
        } catch {
          setMessages((prev) => [...prev, { role: 'assistant', text: fallback() }]);
        } finally {
          sendingRef.current = false;
          setSending(false);
        }
      };

      const toggleAssistant = () => {
        const next = !assistantOpen;
        setAssistantOpen(next);
        if (next) setTimeout(() => { if (cmdInputRef.current) cmdInputRef.current.focus(); }, 0);
      };

      const stats = useMemo(() => {
        const byStatus = { todo: 0, done: 0 };
        let overdue = 0; let todayCount = 0;
        const nowMs = Date.now();
        for (const t of tasks) {
          if (byStatus[t.status] !== undefined) byStatus[t.status] += 1;
          if (t.status !== 'done') {
            const dl = deadlineMs(t.deadline);
            if (dl !== null && dl < nowMs) overdue += 1;
            if (isTodayDeadline(t.deadline)) todayCount += 1;
          }
        }
        return { total: tasks.length, byStatus, overdue, todayCount };
      }, [tasks]);

      const viewTasks = useMemo(() => {
        if (activeView === 'done') return tasks.filter((t) => t.status === 'done');
        if (activeView === 'today') return tasks.filter((t) => t.status !== 'done' && isTodayDeadline(t.deadline));
        if (activeView === 'overdue') {
          const nowMs = Date.now();
          return tasks.filter((t) => t.status !== 'done' && t.deadline && deadlineMs(t.deadline) !== null && deadlineMs(t.deadline) < nowMs);
        }
        return tasks;
      }, [tasks, activeView]);

      const filteredTasks = useMemo(() => {
        let list = viewTasks;
        const q = search.trim().toLowerCase();
        if (q) list = list.filter((t) => (t.title + ' ' + (t.description || '')).toLowerCase().includes(q));
        return list.slice().sort((a, b) => {
          if (sortBy === 'priority') {
            const ua = URGENCY_WEIGHT[a.urgency] ?? 0; const ub = URGENCY_WEIGHT[b.urgency] ?? 0;
            if (ua !== ub) return ub - ua;
          } else if (sortBy === 'created') {
            return (b.createdAt || '').localeCompare(a.createdAt || '');
          } else {
            const da = deadlineMs(a.deadline); const db = deadlineMs(b.deadline);
            if (da !== null && db !== null && da !== db) return da - db;
            if (da !== null && db === null) return -1;
            if (da === null && db !== null) return 1;
            return (b.createdAt || '').localeCompare(a.createdAt || '');
          }
          return 0;
        });
      }, [viewTasks, search, sortBy]);

      const GROUPS = [
        { status: 'todo', label: '待办' },
        { status: 'done', label: '已完成' },
      ];
      const grouped = useMemo(() => {
        const map = { todo: [], done: [] };
        for (const t of filteredTasks) { if (map[t.status]) map[t.status].push(t); }
        return GROUPS.map((g) => ({ ...g, tasks: map[g.status] })).filter((g) => g.tasks.length > 0);
      }, [filteredTasks]);

      const selectedTask = tasks.find((t) => t.id === selectedId) || null;
      const viewTitle = { all: '全部任务', today: '今天到期', overdue: '已逾期', done: '已完成' }[activeView] || '全部任务';
      const statsText = stats.total + ' 项任务 · 已完成 ' + stats.byStatus.done + ' 项';

      const rowDeadline = (task) => {
        if (!task.deadline) return null;
        if (task.status === 'done') return { text: formatTaskDate(task.deadline), cls: '' };
        const info = formatRelativeTime(task.deadline);
        if (!info) return null;
        if (info.overdue) return { text: info.text, cls: 'wp-overdue' };
        if (isTodayDeadline(task.deadline)) {
          const parsed = parseDeadline(task.deadline);
          const hh = pad2(parsed.date.getHours()); const mm = pad2(parsed.date.getMinutes());
          return { text: parsed.dateOnly ? '今天' : '今天 ' + hh + ':' + mm, cls: 'wp-today' };
        }
        return { text: info.text, cls: '' };
      };

      const renderRow = (task) => {
        const done = task.status === 'done';
        const dl = rowDeadline(task);
        return h('div', {
          className: 'wp-row',
          key: task.id,
          onClick: () => setSelectedId(selectedId === task.id ? null : task.id),
        },
          h('button', {
            className: 'wp-row-check wp-check-' + task.urgency + (done ? ' wp-checked' : ''),
            type: 'button', role: 'checkbox', 'aria-checked': done ? 'true' : 'false',
            title: done ? '标记为未完成' : '标记为已完成',
            onClick: (e) => { e.stopPropagation(); toggleDone(task); },
          }, done ? h(CheckIcon) : null),
          h('div', { className: 'wp-row-main' },
            h('div', { className: 'wp-row-title' + (done ? ' wp-done' : '') }, task.title),
            task.description ? h('div', { className: 'wp-row-desc' }, task.description) : null),
          dl ? h('span', { className: 'wp-row-time ' + dl.cls }, dl.text) : null);
      };

      // ---------- calendar popover (shared by quick-add and detail) ----------
      const calendarPopover = (opts) => {
        const { month, setMonth, date, time, onPickDate, onPickTime, onClose, onToday } = opts;
        const firstDay = new Date(month.year, month.month, 1).getDay();
        const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
        const today = new Date();
        const cells = [];
        for (let i = 0; i < firstDay; i += 1) cells.push(null);
        for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
        const grid = cells.map((d, i) => {
          if (d == null) return h('span', { className: 'wp-cal-day wp-blank', key: 'b' + i });
          const dateStr = month.year + '-' + pad2(month.month + 1) + '-' + pad2(d);
          const selected = dateStr === date;
          const isTodayCell = month.year === today.getFullYear() && month.month === today.getMonth() && d === today.getDate();
          return h('button', {
            className: 'wp-cal-day' + (selected ? ' wp-selected' : '') + (isTodayCell ? ' wp-today' : ''),
            key: dateStr, type: 'button',
            onClick: () => onPickDate(dateStr),
          }, String(d));
        });
        return h('div', { className: 'wp-cal-popover' },
          h('div', { className: 'wp-cal-header' },
            h('span', { className: 'wp-cal-title' }, month.year + '年' + (month.month + 1) + '月'),
            h('div', { className: 'wp-cal-nav' },
              h('button', { className: 'wp-cal-nav-btn', type: 'button', 'aria-label': '上个月', onClick: () => setMonth(shiftMonth(month.year, month.month, -1)) }, '‹'),
              h('button', { className: 'wp-cal-nav-btn', type: 'button', 'aria-label': '下个月', onClick: () => setMonth(shiftMonth(month.year, month.month, 1)) }, '›'))),
          h('div', { className: 'wp-cal-weekdays' }, ['日', '一', '二', '三', '四', '五', '六'].map((w) => h('span', { className: 'wp-cal-weekday', key: w }, w))),
          h('div', { className: 'wp-cal-grid' }, grid),
          h('div', { className: 'wp-cal-time-row' },
            h('span', { className: 'wp-cal-time-label' }, '时间'),
            h('select', {
              className: 'wp-cal-time-select', value: time,
              onChange: (e) => onPickTime(e.target.value),
            }, h('option', { value: '' }, '不设置时间'), TIME_OPTIONS.map((t) => h('option', { value: t, key: t }, t)))),
          h('div', { className: 'wp-cal-footer' },
            h('button', { className: 'wp-btn wp-btn-default wp-cal-btn', type: 'button', onClick: onToday }, '今天'),
            h('button', { className: 'wp-btn wp-btn-primary wp-cal-btn', type: 'button', onClick: onClose }, '确定')));
      };

      const quickLabel = formatQuickLabel(quickDeadline.date, quickDeadline.time);
      const quickPast = quickDeadline.date < todayDate();
      const quickAdd = h('div', { className: 'wp-card wp-quick' },
        h('div', { className: 'wp-quick-box', ref: calRef },
          h('input', {
            ref: quickInputRef, className: 'wp-quick-input', type: 'text', value: quickText,
            placeholder: '+ 添加待办',
            onChange: (e) => setQuickText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') addQuick(); },
          }),
          h('button', {
            className: 'wp-quick-cal' + (quickPast ? ' wp-past' : '') + (calOpen ? ' wp-active' : ''),
            type: 'button', title: '选择日期 / 时间', 'aria-label': '选择日期 / 时间',
            onClick: () => setCalOpen((v) => !v),
          }, h(CalDayIcon, { day: Number(quickDeadline.date.slice(8, 10)) }), quickLabel ? h('span', { className: 'wp-quick-cal-label' }, quickLabel) : null),
          calOpen ? calendarPopover({
            month: calMonth,
            setMonth: setCalMonth,
            date: quickDeadline.date,
            time: quickDeadline.time,
            onPickDate: (dateStr) => setQuickDeadline((v) => ({ ...v, date: dateStr })),
            onPickTime: (time) => setQuickDeadline((v) => ({ ...v, time })),
            onClose: () => setCalOpen(false),
            onToday: () => { setQuickDeadline({ date: todayDate(), time: '' }); const d = new Date(); setCalMonth({ year: d.getFullYear(), month: d.getMonth() }); },
          }) : null));

      // ---------- list ----------
      const groupList = filteredTasks.length === 0
        ? h('div', { className: 'wp-card' },
            h('div', { className: 'wp-empty' },
              h(EmptyIcon),
              h('p', { className: 'wp-empty-desc' }, search.trim() ? '没有匹配的任务，试试清空搜索。' : '当前视图暂无任务。在上方快速添加，或点击「助手」对话创建。')))
        : h('div', { className: 'wp-task-list' }, grouped.map((g) =>
            h('div', { className: 'wp-group', key: g.status },
              h('button', {
                className: 'wp-group-head', type: 'button',
                onClick: () => setCollapsedGroups((c) => ({ ...c, [g.status]: !c[g.status] })),
              },
                h('span', { className: 'wp-group-title' }, g.label),
                h('span', { className: 'wp-group-count' }, String(g.tasks.length)),
                h('span', { className: 'wp-group-toggle' }, collapsedGroups[g.status] ? '展开' : '收起')),
              collapsedGroups[g.status] ? null : h('div', { className: 'wp-group-rows' }, g.tasks.map((t) => renderRow(t))))));

      // ---------- header / sidenav / detail ----------
      const middleHeader = h('div', { className: 'wp-mid-head' },
        h('div', { className: 'wp-mid-head-left' },
          h('h1', { className: 'wp-mid-title' }, viewTitle),
          h('p', { className: 'wp-mid-stats' }, statsText)),
        h('div', { className: 'wp-mid-head-right' },
          h('div', { className: 'wp-search' },
            h('span', { className: 'wp-search-icon' }, h(SearchIcon)),
            h('input', {
              className: 'wp-search-input', type: 'text', placeholder: '搜索任务', value: search,
              onChange: (e) => setSearch(e.target.value),
            })),
          h('button', {
            className: 'wp-icon-btn', type: 'button',
            title: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
            'aria-label': '切换主题', onClick: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
          }, theme === 'dark' ? h(SunIcon) : h(MoonIcon)),
          h('button', {
            className: 'wp-icon-btn wp-assist-btn', type: 'button', title: 'AI 助手',
            onClick: toggleAssistant,
          }, h(ChatIcon), h('span', null, '助手'))));

      const toolbar = h('div', { className: 'wp-mid-toolbar' },
        h('div', { className: 'wp-mid-toolbar-right' },
          h('select', {
            className: 'wp-sort-select', value: sortBy, title: '排序',
            onChange: (e) => setSortBy(e.target.value),
          },
            h('option', { value: 'deadline' }, '按截止时间'),
            h('option', { value: 'priority' }, '按优先级'),
            h('option', { value: 'created' }, '按创建时间'))));

      const middleBody = h('div', { className: 'wp-mid-body' },
        quickAdd,
        toolbar,
        groupList);

      const navItems = [
        { key: 'all', label: '全部任务', count: stats.total },
        { key: 'today', label: '今天到期', count: stats.todayCount },
        { key: 'overdue', label: '已逾期', count: stats.overdue },
        { key: 'done', label: '已完成', count: stats.byStatus.done },
      ];
      const sidenav = h('aside', { className: 'wp-sidenav' },
        h('div', { className: 'wp-sidenav-title' }, '工作面板'),
        navItems.map((it) => h('button', {
          className: 'wp-nav-item' + (activeView === it.key ? ' wp-active' : ''),
          key: it.key, type: 'button',
          onClick: () => { setActiveView(it.key); setSelectedId(null); },
        },
          h('span', null, it.label),
          it.count ? h('span', { className: 'wp-nav-count' }, String(it.count)) : null)),
        h('div', { className: 'wp-sidenav-spacer' }));

      const detailRow = (label, value) => h('div', { className: 'wp-detail-row' },
        h('span', { className: 'wp-detail-label' }, label),
        h('div', { className: 'wp-detail-value' }, value));

      const detailParsed = selectedTask ? parseDeadline(selectedTask.deadline) : null;
      const detailDate = detailParsed
        ? detailParsed.date.getFullYear() + '-' + pad2(detailParsed.date.getMonth() + 1) + '-' + pad2(detailParsed.date.getDate())
        : todayDate();
      const detailTime = detailParsed && !detailParsed.dateOnly
        ? pad2(detailParsed.date.getHours()) + ':' + pad2(detailParsed.date.getMinutes())
        : '';
      const setDetailDeadline = (dateStr, time) => {
        if (!selectedTask) return;
        updateTask(selectedTask.id, { deadline: time ? dateStr + 'T' + time : dateStr });
      };

      const detailPanel = selectedTask ? h('aside', { className: 'wp-detail' },
        h('div', { className: 'wp-detail-body' },
          h('div', { className: 'wp-detail-meta' },
            h('button', {
              className: 'wp-detail-check wp-check-' + selectedTask.urgency + (selectedTask.status === 'done' ? ' wp-checked' : ''),
              type: 'button', role: 'checkbox', 'aria-checked': selectedTask.status === 'done' ? 'true' : 'false',
              title: selectedTask.status === 'done' ? '标记为未完成' : '标记为已完成',
              onClick: () => toggleDone(selectedTask),
            }, selectedTask.status === 'done' ? h(CheckIcon) : null),
            h('span', { className: 'wp-detail-sep' }, '|'),
            h('button', {
              className: 'wp-detail-date', type: 'button', title: '选择日期 / 时间',
              onClick: () => {
                if (!detailCalOpen) {
                  const d = parseDeadline(selectedTask.deadline);
                  const base = d ? d.date : new Date();
                  setDetailCalMonth({ year: base.getFullYear(), month: base.getMonth() });
                }
                setDetailCalOpen((v) => !v);
              },
            }, formatTaskDate(selectedTask.deadline)),
            h('button', {
              className: 'wp-detail-flag wp-flag-' + selectedTask.urgency,
              type: 'button', title: '选择优先级',
              onClick: () => setFlagOpen((v) => !v),
            }, h(FlagIcon)),
            detailCalOpen ? calendarPopover({
              month: detailCalMonth,
              setMonth: setDetailCalMonth,
              date: detailDate,
              time: detailTime,
              onPickDate: (dateStr) => setDetailDeadline(dateStr, detailTime),
              onPickTime: (time) => setDetailDeadline(detailDate, time),
              onClose: () => setDetailCalOpen(false),
              onToday: () => { setDetailDeadline(todayDate(), ''); const d = new Date(); setDetailCalMonth({ year: d.getFullYear(), month: d.getMonth() }); },
            }) : null,
            flagOpen ? h('div', { className: 'wp-prio-menu' },
              URGENCY_ORDER.map((u) => h('button', {
                className: 'wp-prio-menu-item', key: u, type: 'button',
                onClick: () => { updateTask(selectedTask.id, { urgency: u }); setFlagOpen(false); },
              }, h('span', { className: 'wp-prio-dot wp-prio-dot-' + u }), URGENCY_FULL[u]))) : null),
          h('textarea', {
            className: 'wp-detail-input wp-detail-title-input', rows: 2, value: selectedTask.title,
            placeholder: '任务标题', spellCheck: false,
            onChange: (e) => updateTask(selectedTask.id, { title: e.target.value }),
          }),
          h('textarea', {
            className: 'wp-detail-input wp-detail-desc-input', rows: 4, value: selectedTask.description || '',
            placeholder: '添加任务描述',
            onChange: (e) => updateTask(selectedTask.id, { description: e.target.value }),
          }),
          h('div', { className: 'wp-detail-rows wp-detail-times' },
            detailRow('创建时间', h('span', { className: 'wp-muted' }, formatDateTime(selectedTask.createdAt))),
            detailRow('更新时间', h('span', { className: 'wp-muted' }, formatDateTime(selectedTask.updatedAt)))))) : null;

      // ---------- right assistant drawer ----------
      const composerInput = h('textarea', {
        ref: cmdInputRef, className: 'wp-composer-input', rows: 1, value: cmdInput,
        placeholder: '输入任务，例如：明天10点前完成报告，紧急',
        onChange: (e) => setCmdInput(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } },
      });
      const composerSend = h('button', {
        className: 'wp-send-btn', type: 'button', 'aria-label': '发送', title: '发送',
        disabled: !cmdInput.trim() || sending, onClick: () => sendChat(),
      }, h(SendIcon));
      const composer = h('div', { className: 'wp-drawer-composer' },
        h('div', { className: 'wp-composer-box' }, composerInput, composerSend));

      const drawer = assistantOpen ? h('aside', { className: 'wp-drawer', role: 'dialog', 'aria-label': 'AI 助手' },
        h('div', { className: 'wp-drawer-head' },
          h(SparkIcon, { size: 15 }),
          h('span', { className: 'wp-drawer-title' }, 'AI 助手'),
          h('span', { className: 'wp-drawer-sub' }, '对话式创建任务'),
          h('button', { className: 'wp-drawer-close', type: 'button', 'aria-label': '关闭', onClick: () => setAssistantOpen(false) }, '×')),
        h('div', { className: 'wp-drawer-thread', ref: chatScrollRef },
          messages.map((msg, i) => h('div', { className: 'wp-msg wp-msg-' + msg.role, key: i },
            h('div', { className: 'wp-msg-bubble' }, msg.text))),
          sending ? h('div', { className: 'wp-msg wp-msg-assistant' },
            h('div', { className: 'wp-msg-bubble wp-typing' }, '正在思考…')) : null),
        h('div', { className: 'wp-drawer-suggestions' },
          ['明天10点前完成季度报告，紧急', '本周五下午6点前提交方案', '我有哪些任务'].map((s, i) =>
            h('button', { className: 'wp-suggestion', key: i, type: 'button', onClick: () => sendChat(s) }, s))),
        composer) : null;

      return h('div', { className: 'wp-root', 'data-theme': theme },
        h('style', null, CSS),
        h('div', { className: 'wp-workbench' },
          sidenav,
          h('section', { className: 'wp-mid' }, middleHeader, middleBody),
          detailPanel),
        drawer);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'work-panel', order: 20, label: '工作面板',
        }, SidebarIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'work-panel',
        }, WorkPanel));
      },
      // Pure helpers exposed for unit tests; ignored by the Loader.
      __debug: {
        parseTask, cleanTitle, detectIntent, extractDeadline, extractUrgency, extractStatus,
        formatDeadline, buildConfirmation, buildTaskListReply, buildTaskFromModel,
        progressTransition, statusTransition, reopenedState,
        formatRelativeTime, todayDate, normalizeDeadline, formatQuickLabel, formatTaskDate,
      },
    };
  },
});
