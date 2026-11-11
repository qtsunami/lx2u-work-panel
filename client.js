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
        // Migration path: legacy tasks (binary status, no v2 fields) are
        // upgraded in place on read, so no separate migration step is needed.
        return parsed
          .filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string')
          .map(withV2Fields);
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

    // ---- v2: work records, artifacts, report snapshots ---------------------
    // Work records and artifacts live in their own append-only stores so a
    // report can later be assembled from "what happened when", not from the
    // mutable current state of a task.
    const LOGS_KEY = '@local/work-panel:logs:v1';
    const ARTIFACTS_KEY = '@local/work-panel:artifacts:v1';

    const LOG_KINDS = { progress: '推进', issue: '问题', decision: '决策', ai: 'AI 协作', note: '记录' };
    const LOG_KIND_ORDER = ['progress', 'issue', 'decision', 'ai'];

    function lid() { return 'l-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
    function aid() { return 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
    function str(value) { return typeof value === 'string' ? value : ''; }

    /**
     * Fills the v2 task fields (idempotent). Used by migration and by every
     * insert so the detail panel never renders an uncontrolled input.
     */
    function withV2Fields(task) {
      const done = task.status === 'done';
      const stamp = str(task.updatedAt) || str(task.createdAt) || new Date().toISOString();
      return {
        ...task,
        status: done ? 'done' : 'todo',
        progress: done ? 100 : 0,
        description: str(task.description),
        project: str(task.project),
        expected: str(task.expected),
        nextStep: str(task.nextStep),
        blockedReason: str(task.blockedReason),
        completedAt: done ? str(task.completedAt) || stamp : null,
        deletedAt: task.deletedAt || null,
        createdAt: str(task.createdAt) || stamp,
        updatedAt: str(task.updatedAt) || stamp,
      };
    }

    function newTask(fields) {
      const iso = new Date().toISOString();
      return withV2Fields({
        id: uid(), title: '', description: '', status: 'todo', urgency: 'medium', progress: 0,
        deadline: '', createdAt: iso, updatedAt: iso, ...fields,
      });
    }

    function loadLogs() {
      try {
        const raw = window.localStorage.getItem(LOGS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((l) => l && typeof l.id === 'string' && typeof l.taskId === 'string' && typeof l.text === 'string');
      } catch { return []; }
    }
    function saveLogs(logs) { try { window.localStorage.setItem(LOGS_KEY, JSON.stringify(logs)); } catch { /* ignore */ } }

    function loadArtifacts() {
      try {
        const raw = window.localStorage.getItem(ARTIFACTS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((a) => a && typeof a.id === 'string' && typeof a.taskId === 'string');
      } catch { return []; }
    }
    function saveArtifacts(artifacts) { try { window.localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(artifacts)); } catch { /* ignore */ } }

    /** Records of one task, oldest first. */
    function logsOf(logs, taskId) {
      return logs.filter((l) => l.taskId === taskId).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }
    function latestLog(logs, taskId) {
      const list = logsOf(logs, taskId);
      return list.length ? list[list.length - 1] : null;
    }
    function artifactsOf(artifacts, taskId) {
      return artifacts.filter((a) => a.taskId === taskId).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }

    /** Links typed one-per-line / comma separated; only http(s) is rendered as a link. */
    function parseLinks(raw) {
      if (typeof raw !== 'string') return [];
      return raw.split(/[\s,，;；、\n]+/).map((s) => s.trim()).filter(Boolean);
    }
    function safeHref(url) {
      const text = String(url || '').trim();
      return /^https?:\/\//i.test(text) ? text : '';
    }

    /** One immutable work record. Records are appended, never edited. */
    function makeLogEntry(taskId, text, kind, source, at) {
      return {
        id: lid(), taskId,
        at: at || new Date().toISOString(),
        kind: LOG_KINDS[kind] ? kind : 'note',
        text: String(text || '').trim(),
        source: source || 'manual',
      };
    }

    /**
     * One artifact reference. Deliberately carries no status field: attaching
     * an artifact can never complete the task.
     */
    function makeArtifact(taskId, summary, links, at) {
      return {
        id: aid(), taskId,
        summary: String(summary || '').trim(),
        links: parseLinks(links),
        at: at || new Date().toISOString(),
        source: 'manual',
        claimedIn: [],
      };
    }

    /**
     * Immutable snapshot of one task at report-generation time.
     * Frozen decision: report refs keep BOTH the id (to jump back) and this
     * snapshot (so a later task edit never rewrites an old report).
     */
    function takeTaskSnapshot(task, logs) {
      return {
        title: str(task.title),
        status: task.status,
        completedAt: task.completedAt || null,
        deadline: str(task.deadline),
        urgency: task.urgency || 'medium',
        expected: str(task.expected),
        nextStep: str(task.nextStep),
        blockedReason: str(task.blockedReason),
        recent: logsOf(logs || [], task.id).slice(-5).map((l) => ({ at: l.at, kind: l.kind, text: l.text })),
      };
    }

    // ---- M2: AI action protocol -------------------------------------------
    // The Host never writes data. It returns typed actions; the client shows a
    // preview, applies them only after confirmation, and keeps an undo snapshot.
    const ACTION_LABEL = {
      create: '新建', update: '修改', complete: '完成',
      reopen: '重开', log: '记录', artifact: '成果',
    };
    const PATCH_FIELD_LABEL = {
      title: '标题', description: '描述', expected: '预期结果', nextStep: '下一步',
      blockedReason: '阻塞原因', deadline: '截止时间', urgency: '优先级',
    };
    const PATCH_KEYS = ['title', 'description', 'expected', 'nextStep', 'blockedReason', 'deadline', 'urgency'];
    const SKIP_REASON = {
      duplicate: '与现有任务重复',
      'missing-task': '任务不存在',
      'missing-title': '缺少标题',
      'no-change': '与当前状态相同',
      'empty-text': '内容为空',
      'empty': '内容为空',
      'unknown-op': '无法识别的操作',
    };

    /** Loose title key for duplicate detection (case/space/punctuation insensitive). */
    function normalizeTitle(value) {
      return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    }

    /** Character-set overlap; tolerant of word order, which suits short Chinese titles. */
    function titleOverlap(a, b) {
      const left = new Set(a);
      const right = new Set(b);
      let shared = 0;
      for (const ch of left) if (right.has(ch)) shared += 1;
      const union = left.size + right.size - shared;
      return union === 0 ? 0 : shared / union;
    }

    /** Returns an existing task that a new title would duplicate, if any. */
    function findDuplicateTask(tasks, title) {
      const key = normalizeTitle(title);
      if (!key) return null;
      for (const task of tasks) {
        if (!task || task.deletedAt) continue;
        const other = normalizeTitle(task.title);
        if (!other) continue;
        if (other === key) return task;
        const shorter = key.length <= other.length ? key : other;
        const longer = key.length <= other.length ? other : key;
        // Same wording with extra words appended ("写周报" / "写周报（周五）").
        if (longer.indexOf(shorter) !== -1 && shorter.length / longer.length >= 0.6) return task;
        // Overlapping wording in a different order ("完成报告" / "完成季度报告").
        if (shorter.length >= 3 && titleOverlap(key, other) >= 0.6) return task;
      }
      return null;
    }

    function previewValue(key, value) {
      if (key === 'deadline') return value ? formatDeadline(value) : '未设置';
      if (key === 'urgency') return URGENCY[value] || '中';
      const text = String(value || '').trim();
      return text || '（空）';
    }

    /** Human-readable preview of one action, used by the confirmation card. */
    function describeAction(tasks, action) {
      const op = action && action.op;
      const label = ACTION_LABEL[op] || String(op || '');
      if (op === 'create') {
        const title = String(action.title || '').trim();
        const lines = [];
        if (action.deadline) lines.push('截止：' + formatDeadline(action.deadline));
        lines.push('优先级：' + (URGENCY[action.urgency] || '中'));
        const duplicate = action.force ? null : findDuplicateTask(tasks, title);
        return { op, label, title, lines, duplicateOf: duplicate ? duplicate.title : null };
      }
      const task = tasks.find((t) => t && t.id === action.taskId) || null;
      if (!task) return { op, label, title: '（找不到任务）', lines: [], invalid: true };
      if (op === 'update') {
        const lines = [];
        const patch = action.patch || {};
        for (const key of PATCH_KEYS) {
          if (!(key in patch)) continue;
          const before = key === 'deadline' ? task.deadline : task[key];
          if (String(before || '') === String(patch[key] || '')) continue;
          lines.push(PATCH_FIELD_LABEL[key] + '：' + previewValue(key, before) + ' → ' + previewValue(key, patch[key]));
        }
        return { op, label, title: task.title, lines };
      }
      if (op === 'complete') return { op, label, title: task.title, lines: ['状态：待办 → 已完成'] };
      if (op === 'reopen') return { op, label, title: task.title, lines: ['状态：已完成 → 待办'] };
      if (op === 'log') {
        return { op, label, title: task.title, lines: [(LOG_KINDS[action.kind] || '记录') + '：' + String(action.text || '')] };
      }
      if (op === 'artifact') {
        const lines = [];
        if (action.summary) lines.push('摘要：' + action.summary);
        if (Array.isArray(action.links) && action.links.length) lines.push('链接：' + action.links.join(' '));
        return { op, label, title: task.title, lines };
      }
      return { op, label, title: task.title, lines: [], invalid: true };
    }

    /**
     * Pure: applies validated actions to the three stores.
     * Returns the next stores, the previous ones (undo snapshot), and a
     * per-action outcome list so the UI can report what was skipped and why.
     */
    function applyActions(state, actions, nowIso) {
      const stamp = nowIso || new Date().toISOString();
      let tasks = state.tasks.slice();
      let logs = state.logs.slice();
      let artifacts = state.artifacts.slice();
      const outcomes = [];
      for (const action of actions || []) {
        const op = action && action.op;
        if (op === 'create') {
          const title = String(action.title || '').trim();
          if (!title) { outcomes.push({ op, status: 'skipped', reason: 'missing-title' }); continue; }
          const duplicate = action.force ? null : findDuplicateTask(tasks, title);
          if (duplicate) {
            outcomes.push({ op, status: 'skipped', reason: 'duplicate', taskId: duplicate.id, title });
            continue;
          }
          const task = newTask({
            title,
            deadline: normalizeDeadline(action.deadline || todayDate()),
            urgency: URGENCY[action.urgency] ? action.urgency : 'medium',
          });
          task.createdAt = stamp;
          task.updatedAt = stamp;
          tasks = [task].concat(tasks);
          outcomes.push({ op, status: 'applied', taskId: task.id, title });
          continue;
        }
        const index = tasks.findIndex((t) => t && t.id === action.taskId);
        const task = index === -1 ? null : tasks[index];
        if (!task) {
          outcomes.push({ op, status: 'skipped', reason: 'missing-task', taskId: action.taskId });
          continue;
        }
        if (op === 'update') {
          const patch = {};
          const raw = action.patch || {};
          for (const key of PATCH_KEYS) {
            if (!(key in raw)) continue;
            // Only keep real changes, so a no-op update is reported as such
            // instead of silently refreshing the task.
            if (key === 'title') {
              const title = String(raw.title || '').trim();
              if (title && title !== task.title) patch.title = title;
            } else if (key === 'urgency') {
              if (URGENCY[raw.urgency] && raw.urgency !== task.urgency) patch.urgency = raw.urgency;
            } else if (key === 'deadline') {
              const deadline = normalizeDeadline(raw.deadline);
              if (deadline !== (task.deadline || '')) patch.deadline = deadline;
            } else {
              const value = String(raw[key] == null ? '' : raw[key]).trim();
              if (value !== (task[key] || '')) patch[key] = value;
            }
          }
          if (Object.keys(patch).length === 0) {
            outcomes.push({ op, status: 'skipped', reason: 'no-change', taskId: task.id });
            continue;
          }
          tasks[index] = { ...task, ...patch, updatedAt: stamp };
          outcomes.push({ op, status: 'applied', taskId: task.id, title: tasks[index].title });
          continue;
        }
        if (op === 'complete' || op === 'reopen') {
          const done = op === 'complete';
          if ((task.status === 'done') === done) {
            outcomes.push({ op, status: 'skipped', reason: 'no-change', taskId: task.id });
            continue;
          }
          tasks[index] = {
            ...task,
            status: done ? 'done' : 'todo',
            progress: done ? 100 : 0,
            completedAt: done ? stamp : null,
            updatedAt: stamp,
          };
          outcomes.push({ op, status: 'applied', taskId: task.id, title: task.title });
          continue;
        }
        if (op === 'log') {
          const body = String(action.text || '').trim();
          if (!body) {
            outcomes.push({ op, status: 'skipped', reason: 'empty-text', taskId: task.id });
            continue;
          }
          logs = logs.concat([makeLogEntry(task.id, body, action.kind, 'ai', stamp)]);
          tasks[index] = { ...task, updatedAt: stamp };
          outcomes.push({ op, status: 'applied', taskId: task.id, title: task.title });
          continue;
        }
        if (op === 'artifact') {
          const summary = String(action.summary || '').trim();
          const links = Array.isArray(action.links) ? action.links : [];
          if (!summary && links.length === 0) {
            outcomes.push({ op, status: 'skipped', reason: 'empty', taskId: task.id });
            continue;
          }
          artifacts = artifacts.concat([makeArtifact(task.id, summary, links.join('\n'), stamp)]);
          tasks[index] = { ...task, updatedAt: stamp };
          outcomes.push({ op, status: 'applied', taskId: task.id, title: task.title });
          continue;
        }
        outcomes.push({ op, status: 'skipped', reason: 'unknown-op', taskId: task.id });
      }
      return {
        next: { tasks, logs, artifacts },
        before: { tasks: state.tasks, logs: state.logs, artifacts: state.artifacts },
        outcomes,
        applied: outcomes.filter((o) => o.status === 'applied').length,
        skipped: outcomes.filter((o) => o.status === 'skipped').length,
      };
    }

    /** One-line human summary of what an applied batch did. */
    function summarizeOutcomes(result) {
      let text = '已应用 ' + result.applied + ' 项变更。';
      const skipped = result.outcomes.filter((o) => o.status === 'skipped');
      if (skipped.length) {
        const reasons = [];
        for (const item of skipped) {
          const reason = SKIP_REASON[item.reason] || item.reason;
          if (reasons.indexOf(reason) === -1) reasons.push(reason);
        }
        text += '跳过 ' + skipped.length + ' 项（' + reasons.join('、') + '）。';
      }
      return text;
    }

    // ---- M3: weekly report ------------------------------------------------
    const REPORTS_KEY = '@local/work-panel:reports:v1';
    // Inline evidence marker written by the model; resolved against the
    // evidence bundle so a report can always be traced back to its sources.
    const REF_SOURCE = '\\[\\[(task|log|artifact):([A-Za-z0-9_-]+)\\]\\]';
    const REPORT_SECTIONS = ['本期主要成果', '重点工作进展', '问题、风险与阻塞', 'AI 辅助分析与建议', '下期计划'];

    function ymd(date) { return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()); }
    function isoToYmd(iso) {
      const date = new Date(iso || '');
      return Number.isNaN(date.getTime()) ? '' : ymd(date);
    }
    /** Local-day membership: both ends are inclusive. */
    function inPeriod(iso, period) {
      const day = isoToYmd(iso);
      return !!day && !!period && day >= period.start && day <= period.end;
    }
    function weekRangeOf(date) {
      const start = startOfWeek(date);
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      return { start: ymd(start), end: ymd(end) };
    }
    function shiftWeek(period, delta) {
      const start = dateOnlyToDate(period && period.start) || new Date();
      return weekRangeOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + delta * 7));
    }
    function periodLabel(period) {
      const start = dateOnlyToDate(period && period.start);
      const end = dateOnlyToDate(period && period.end);
      if (!start || !end) return (period && period.start) + ' ~ ' + (period && period.end);
      return (start.getMonth() + 1) + '月' + start.getDate() + '日 - ' + (end.getMonth() + 1) + '月' + end.getDate() + '日';
    }
    function periodKey(period) { return (period && period.start) + '_' + (period && period.end); }

    function loadReports() {
      try {
        const raw = window.localStorage.getItem(REPORTS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((r) => r && typeof r.id === 'string' && typeof r.body === 'string');
      } catch { return []; }
    }
    function saveReports(reports) { try { window.localStorage.setItem(REPORTS_KEY, JSON.stringify(reports)); } catch { /* ignore */ } }

    /**
     * Evidence for one period: tasks completed inside it, plus unfinished
     * tasks that gained a work record or an artifact inside it.
     */
    function collectEvidence(tasks, logs, artifacts, period) {
      const items = [];
      for (const task of tasks) {
        if (!task || task.deletedAt) continue;
        const taskLogs = logsOf(logs, task.id).filter((entry) => inPeriod(entry.at, period));
        const taskArtifacts = artifactsOf(artifacts, task.id).filter((item) => inPeriod(item.at, period));
        const completedThisPeriod = task.status === 'done' && inPeriod(task.completedAt, period);
        if (!completedThisPeriod && taskLogs.length === 0 && taskArtifacts.length === 0) continue;
        items.push({
          taskId: task.id,
          title: task.title,
          status: task.status,
          completedThisPeriod,
          expected: task.expected,
          nextStep: task.nextStep,
          blockedReason: task.blockedReason,
          logs: taskLogs,
          artifacts: taskArtifacts,
          snapshot: takeTaskSnapshot(task, logs),
        });
      }
      items.sort((a, b) => {
        if (a.completedThisPeriod !== b.completedThisPeriod) return a.completedThisPeriod ? -1 : 1;
        return String(a.title).localeCompare(String(b.title));
      });
      return items;
    }

    function buildEvidenceIndex(evidence) {
      const byTask = new Map();
      const byLog = new Map();
      const byArtifact = new Map();
      for (const item of evidence) {
        byTask.set(item.taskId, item);
        for (const entry of item.logs) byLog.set(entry.id, { item, entry });
        for (const artifact of item.artifacts) byArtifact.set(artifact.id, { item, artifact });
      }
      return { byTask, byLog, byArtifact };
    }

    function resolveRef(index, type, id) {
      if (type === 'task') {
        const item = index.byTask.get(id);
        return item ? { type, id, item } : null;
      }
      if (type === 'log') {
        const hit = index.byLog.get(id);
        return hit ? { type, id, item: hit.item, entry: hit.entry } : null;
      }
      if (type === 'artifact') {
        const hit = index.byArtifact.get(id);
        return hit ? { type, id, item: hit.item, artifact: hit.artifact } : null;
      }
      return null;
    }

    /** Unique, resolvable refs in document order. Unknown markers are ignored. */
    function parseRefs(body, evidence) {
      const index = buildEvidenceIndex(evidence);
      const out = [];
      const seen = new Set();
      const re = new RegExp(REF_SOURCE, 'g');
      let match = re.exec(String(body || ''));
      while (match !== null) {
        const key = match[1] + ':' + match[2];
        const found = resolveRef(index, match[1], match[2]);
        if (found && !seen.has(key)) {
          seen.add(key);
          out.push(found);
        }
        match = re.exec(String(body || ''));
      }
      return out;
    }

    function refLabel(ref) {
      if (ref.type === 'task') return '任务「' + ref.item.title + '」（' + (ref.item.status === 'done' ? '已完成' : '待办') + '）';
      if (ref.type === 'log') {
        const text = String((ref.entry && ref.entry.text) || '');
        const short = text.slice(0, 40) + (text.length > 40 ? '…' : '');
        return '工作记录「' + short + '」（任务：' + ref.item.title + '，' + formatDateTime(ref.entry && ref.entry.at) + '）';
      }
      const summary = String((ref.artifact && ref.artifact.summary) || '').slice(0, 40);
      return '成果「' + (summary || '无摘要') + '」（任务：' + ref.item.title + '）';
    }

    /** Markdown export: inline markers become numbered footnotes. */
    function markdownWithFootnotes(body, evidence) {
      const refs = parseRefs(body, evidence);
      const numbers = new Map();
      const numbered = refs.map((ref) => {
        numbers.set(ref.type + ':' + ref.id, numbers.size + 1);
        return { ref, n: numbers.get(ref.type + ':' + ref.id) };
      });
      const text = String(body || '').replace(new RegExp(REF_SOURCE, 'g'), (whole, type, id) => {
        const n = numbers.get(type + ':' + id);
        return n ? '[^' + n + ']' : '';
      });
      const notes = numbered.map(({ ref, n }) => '[^' + n + ']: ' + refLabel(ref));
      return text + (notes.length ? '\n\n' + notes.join('\n') : '');
    }

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
      return newTask({
        title,
        status: done ? 'done' : 'todo',
        urgency: URGENCY[raw.urgency] ? raw.urgency : 'medium',
        deadline: normalizeDeadline(raw.deadline),
      });
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
      .wp-row-log { display: flex; align-items: baseline; gap: 5px; margin-top: 3px; font-size: 12px; color: var(--wp-text-tertiary); overflow: hidden; }
      .wp-row-log-kind { flex-shrink: 0; padding: 0 4px; border-radius: 3px; background: var(--wp-fill); font-size: 11px; line-height: 16px; color: var(--wp-text-secondary); }
      .wp-row-log-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
      .wp-detail-field { margin: 0 0 14px; }
      .wp-detail-field-label { display: block; margin-bottom: 2px; font-size: 12px; color: var(--wp-text-tertiary); }
      .wp-detail-small { font-size: 13px; line-height: 1.55; min-height: 38px; color: var(--wp-text); }
      .wp-detail-actions { display: flex; gap: 8px; margin: 2px 0 14px; }
      .wp-act-btn { height: 30px; padding: 0 12px; font-size: 12.5px; }
      .wp-composer-panel { margin: 0 0 16px; padding: 12px; border: 1px solid var(--wp-border-secondary); border-radius: 10px; background: var(--wp-fill); }
      .wp-composer-panel-input {
        width: 100%; box-sizing: border-box; margin-top: 8px; padding: 8px 10px;
        border: 1px solid var(--wp-border); border-radius: 8px;
        background: var(--wp-bg-container); color: var(--wp-text);
        font: inherit; font-size: 13px; line-height: 1.5; resize: vertical; outline: none;
      }
      .wp-composer-panel-input:focus { border-color: var(--wp-primary); }
      .wp-composer-panel-input::placeholder { color: var(--wp-text-quaternary); }
      .wp-composer-panel-hint { margin: 8px 0 0; font-size: 11.5px; color: var(--wp-text-tertiary); }
      .wp-composer-panel-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
      .wp-kind-seg { display: inline-flex; padding: 2px; background: var(--wp-bg-container); border-radius: 6px; gap: 2px; }
      .wp-detail-section { margin: 20px 0 0; }
      .wp-detail-section-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .wp-detail-section-title { font-size: 12.5px; font-weight: 600; color: var(--wp-text-secondary); }
      .wp-detail-section-count { min-width: 16px; padding: 0 5px; border-radius: 8px; background: var(--wp-fill); font-size: 11px; line-height: 16px; color: var(--wp-text-tertiary); text-align: center; }
      .wp-detail-empty { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--wp-text-quaternary); }
      .wp-log-list { display: flex; flex-direction: column; gap: 10px; }
      .wp-log-item { padding-left: 10px; border-left: 2px solid var(--wp-border-secondary); }
      .wp-log-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
      .wp-log-kind { display: inline-block; padding: 0 4px; border-radius: 3px; background: var(--wp-fill); font-size: 11px; line-height: 16px; color: var(--wp-text-secondary); }
      .wp-log-kind-ai { background: rgba(22, 119, 255, 0.1); color: var(--wp-primary); }
      .wp-log-kind-issue { background: rgba(255, 77, 79, 0.1); color: var(--wp-error); }
      .wp-log-kind-decision { background: rgba(250, 173, 20, 0.16); color: var(--wp-warning); }
      .wp-log-time { font-size: 11.5px; color: var(--wp-text-quaternary); }
      .wp-log-text { font-size: 13px; line-height: 1.6; color: var(--wp-text); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-artifact-list { display: flex; flex-direction: column; gap: 10px; }
      .wp-artifact { padding: 10px; border: 1px solid var(--wp-border-secondary); border-radius: 8px; }
      .wp-artifact-summary { font-size: 13px; line-height: 1.55; color: var(--wp-text); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-artifact-links { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
      .wp-artifact-link { font-size: 12.5px; color: var(--wp-primary); text-decoration: none; overflow-wrap: anywhere; }
      .wp-artifact-link:hover { text-decoration: underline; }
      .wp-artifact-url { font-size: 12.5px; color: var(--wp-text-secondary); overflow-wrap: anywhere; }
      .wp-artifact-time { margin-top: 6px; font-size: 11.5px; color: var(--wp-text-quaternary); }

      /* ---- in-task AI suggestions ---- */
      .wp-ai-panel { margin: 0 0 16px; padding: 12px; border: 1px dashed var(--wp-border); border-radius: 10px; background: var(--wp-fill); }
      .wp-ai-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .wp-ai-title { font-size: 12.5px; font-weight: 600; color: var(--wp-text-secondary); }
      .wp-ai-tag { padding: 0 5px; border-radius: 3px; background: rgba(250, 173, 20, 0.16); font-size: 11px; line-height: 16px; color: var(--wp-warning); }
      .wp-ai-close { margin-left: auto; width: 22px; height: 22px; padding: 0; border: none; border-radius: 4px; background: transparent; color: var(--wp-text-tertiary); font-size: 16px; line-height: 1; cursor: pointer; }
      .wp-ai-close:hover { color: var(--wp-text); background: var(--wp-bg-container); }
      .wp-ai-loading { margin: 0; font-size: 12.5px; color: var(--wp-text-tertiary); }
      .wp-ai-body { display: flex; flex-direction: column; }
      .wp-ai-reply { margin: 0 0 8px; font-size: 13px; line-height: 1.6; color: var(--wp-text); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-ai-sugs { display: flex; flex-direction: column; gap: 10px; }
      .wp-ai-sug { padding: 8px 10px; border-radius: 8px; background: var(--wp-bg-container); }
      .wp-ai-sug-label { display: block; margin-bottom: 2px; font-size: 11px; color: var(--wp-text-tertiary); }
      .wp-ai-sug-text { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--wp-text); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-ai-adopt { margin-top: 6px; padding: 2px 8px; border: 1px solid var(--wp-border); border-radius: 4px; background: var(--wp-bg-container); color: var(--wp-primary); font: inherit; font-size: 11.5px; cursor: pointer; }
      .wp-ai-adopt:hover { border-color: var(--wp-primary); }
      .wp-ai-adopt:disabled { color: var(--wp-text-tertiary); border-color: var(--wp-border-secondary); cursor: default; }
      .wp-ai-hint { margin: 10px 0 0; font-size: 11.5px; color: var(--wp-text-tertiary); }
      .wp-composer-ai { color: var(--wp-primary); }
      .wp-composer-spacer { flex: 1; }
      .wp-composer-locked { align-self: center; flex-shrink: 0; font-size: 11.5px; color: var(--wp-warning); }
      .wp-tidy-note { color: var(--wp-primary); }
      .wp-log-ai-tag { padding: 0 3px; border-radius: 3px; background: rgba(22, 119, 255, 0.1); font-size: 10px; line-height: 15px; color: var(--wp-primary); }

      /* ---- AI action confirmation card ---- */
      .wp-action-card {
        flex-shrink: 0; display: flex; flex-direction: column; max-height: 40vh;
        margin: 0 12px 8px; padding: 10px;
        border: 1px solid var(--wp-border-secondary); border-radius: 10px; background: var(--wp-fill);
      }
      .wp-action-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .wp-action-card-title { font-size: 12.5px; font-weight: 600; color: var(--wp-text); }
      .wp-action-card-count { padding: 0 5px; border-radius: 3px; background: var(--wp-bg-container); font-size: 11px; line-height: 16px; color: var(--wp-text-tertiary); }
      .wp-action-card-list { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
      .wp-action-item { display: flex; gap: 8px; padding: 8px; border-radius: 8px; background: var(--wp-bg-container); }
      .wp-action-item-warn { border: 1px dashed var(--wp-warning); }
      .wp-action-op { flex-shrink: 0; align-self: flex-start; padding: 0 5px; border-radius: 3px; background: rgba(22, 119, 255, 0.1); font-size: 11px; line-height: 17px; color: var(--wp-primary); }
      .wp-action-body { min-width: 0; flex: 1; }
      .wp-action-task { font-size: 12.5px; font-weight: 500; color: var(--wp-text); overflow-wrap: anywhere; }
      .wp-action-line { margin-top: 2px; font-size: 11.5px; line-height: 1.5; color: var(--wp-text-secondary); overflow-wrap: anywhere; }
      .wp-action-warn { margin-top: 4px; font-size: 11.5px; color: var(--wp-warning); }
      .wp-action-force { margin-left: 6px; padding: 0 5px; border: 1px solid var(--wp-border); border-radius: 3px; background: var(--wp-bg-container); color: var(--wp-text-secondary); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; }
      .wp-action-force:hover { color: var(--wp-primary); border-color: var(--wp-primary); }

      /* ---- weekly report ---- */
      .wp-mid-body-report { display: flex; flex-direction: column; padding: 14px 20px 16px; }
      .wp-report { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
      .wp-report-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
      .wp-report-period { display: flex; align-items: center; gap: 6px; }
      .wp-report-nav {
        width: 24px; height: 24px; padding: 0; border: 1px solid var(--wp-border); border-radius: 6px;
        background: transparent; color: var(--wp-text-secondary); font: inherit; line-height: 1; cursor: pointer;
      }
      .wp-report-nav:hover { color: var(--wp-primary); border-color: var(--wp-primary); }
      .wp-report-period-label { font-size: 13px; font-weight: 500; color: var(--wp-text); }
      .wp-report-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wp-report-dirty { font-size: 11.5px; color: var(--wp-warning); }
      .wp-report-notice { margin: 0; padding: 7px 10px; border-radius: 7px; font-size: 12px; line-height: 1.5; background: var(--wp-fill); color: var(--wp-text-secondary); }
      .wp-report-notice-warn { background: rgba(250, 173, 20, 0.12); color: var(--wp-warning); }
      .wp-report-notice-err { background: rgba(255, 77, 79, 0.1); color: var(--wp-error); }
      .wp-report-editor {
        flex: 1; min-height: 0; width: 100%; box-sizing: border-box;
        padding: 14px 16px; border: 1px solid var(--wp-border-secondary); border-radius: 10px;
        background: var(--wp-bg-container); color: var(--wp-text);
        font: inherit; font-size: 13.5px; line-height: 1.85; resize: none; outline: none;
      }
      .wp-report-editor:focus { border-color: var(--wp-primary); }
      .wp-report-preview { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 2px 20px; }
      .wp-report-h { margin: 20px 0 6px; font-size: 15px; font-weight: 600; color: var(--wp-text); }
      .wp-report-h:first-child { margin-top: 0; }
      .wp-report-line { font-size: 13.5px; line-height: 1.85; color: var(--wp-text); overflow-wrap: anywhere; }
      .wp-report-gap { height: 4px; }
      .wp-ref {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 15px; height: 15px; margin: 0 2px; padding: 0 3px;
        border: none; border-radius: 3px; background: rgba(22, 119, 255, 0.1);
        color: var(--wp-primary); font: inherit; font-size: 10.5px; line-height: 1; cursor: pointer;
        vertical-align: 2px;
      }
      .wp-ref:hover { background: rgba(22, 119, 255, 0.22); }
      .wp-ref-broken { background: var(--wp-fill); color: var(--wp-text-tertiary); cursor: help; }
      .wp-report-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; }
      .wp-report-empty-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--wp-text); }
      .wp-report-empty-desc { margin: 0; max-width: 440px; font-size: 12.5px; line-height: 1.7; color: var(--wp-text-secondary); }
      .wp-report-empty-warn { margin: 0; font-size: 12px; color: var(--wp-warning); }

      /* ---- evidence sidebar ---- */
      .wp-evidence {
        width: 380px; flex-shrink: 0; display: flex; flex-direction: column; overflow-y: auto;
        padding: 16px; background: var(--wp-bg-container); border-left: 1px solid var(--wp-border-secondary);
      }
      .wp-evidence-head { display: flex; align-items: center; gap: 6px; }
      .wp-evidence-title { font-size: 13px; font-weight: 600; color: var(--wp-text); }
      .wp-evidence-count { padding: 0 5px; border-radius: 8px; background: var(--wp-fill); font-size: 11px; line-height: 16px; color: var(--wp-text-tertiary); }
      .wp-evidence-all {
        margin-left: auto; padding: 2px 8px; border: 1px solid var(--wp-border); border-radius: 4px;
        background: transparent; color: var(--wp-text-secondary); font: inherit; font-size: 11.5px; cursor: pointer;
      }
      .wp-evidence-all:hover { color: var(--wp-primary); border-color: var(--wp-primary); }
      .wp-evidence-hint { margin: 8px 0 12px; font-size: 11.5px; line-height: 1.6; color: var(--wp-text-tertiary); }
      .wp-evidence-list { display: flex; flex-direction: column; gap: 8px; }
      .wp-evidence-item { display: flex; gap: 8px; padding: 10px; border: 1px solid var(--wp-border-secondary); border-radius: 8px; cursor: pointer; }
      .wp-evidence-item:hover { background: var(--wp-fill); }
      .wp-evidence-off { opacity: 0.45; }
      .wp-evidence-check { margin-top: 2px; flex-shrink: 0; }
      .wp-evidence-body { min-width: 0; flex: 1; }
      .wp-evidence-task { font-size: 13px; font-weight: 500; color: var(--wp-text); overflow-wrap: anywhere; }
      .wp-evidence-meta { margin-top: 2px; font-size: 11.5px; color: var(--wp-text-tertiary); }
      .wp-evidence-last { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--wp-text-secondary); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .wp-action-card-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
      .wp-undo-bar { flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 16px 8px; }
      .wp-undo-text { font-size: 11.5px; color: var(--wp-text-tertiary); }
      .wp-undo-btn { padding: 2px 8px; border: 1px solid var(--wp-border); border-radius: 4px; background: var(--wp-bg-container); color: var(--wp-primary); font: inherit; font-size: 11.5px; cursor: pointer; }
      .wp-undo-btn:hover { border-color: var(--wp-primary); }
      .wp-status-seg { display: inline-flex; padding: 2px; background: var(--wp-fill); border-radius: 6px; gap: 2px; }
      .wp-status-seg-item {
        border: none; border-radius: 4px; background: transparent;
        padding: 3px 10px; font: inherit; font-size: 12.5px;
        color: var(--wp-text-secondary); cursor: pointer;
      }
      .wp-status-seg-item[data-active='true'] { background: var(--wp-bg-container); color: var(--wp-primary); font-weight: 500; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }

      @media (max-width: 1200px) { .wp-detail { width: 360px; } .wp-evidence { width: 340px; } }
      @media (max-width: 980px) {
        .wp-detail, .wp-evidence {
          position: absolute; top: 0; right: 0; bottom: 0; z-index: 120;
          width: min(400px, calc(100% - 40px)); box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
        }
      }
      @media (max-width: 760px) {
        .wp-sidenav { display: none; }
        .wp-mid-head { padding: 12px 14px 8px; }
        .wp-mid-body { padding: 12px 14px 20px; }
        .wp-search-input { width: 120px; }
        .wp-detail, .wp-evidence { width: 100%; }
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
      text: '你好，我是任务助手 👋\n我可以帮你创建、修改、完成和记录任务，例如「明天10点前完成季度报告，紧急」「把报告改到周五」「逾期那几条顺延到下周」。\n涉及改动时，我会先列出要改什么，你确认后才执行，也能撤销。',
    };

    function WorkPanel() {
      const [tasks, setTasks] = useState(loadTasks);
      const [logs, setLogs] = useState(loadLogs);
      const [artifacts, setArtifacts] = useState(loadArtifacts);
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
      const [logComposerOpen, setLogComposerOpen] = useState(false);
      const [logText, setLogText] = useState('');
      const [logKind, setLogKind] = useState('progress');
      const [artifactComposerOpen, setArtifactComposerOpen] = useState(false);
      const [artifactSummary, setArtifactSummary] = useState('');
      const [artifactLinks, setArtifactLinks] = useState('');
      const [pendingActions, setPendingActions] = useState(null);
      const [lastApply, setLastApply] = useState(null);
      const [aiPanelOpen, setAiPanelOpen] = useState(false);
      const [aiLoading, setAiLoading] = useState(false);
      const [aiResult, setAiResult] = useState(null);
      const [aiAdopted, setAiAdopted] = useState({});
      const [tidyLoading, setTidyLoading] = useState(false);
      const [tidyNote, setTidyNote] = useState('');
      const [reports, setReports] = useState(loadReports);
      const [reportPeriod, setReportPeriod] = useState(() => weekRangeOf(new Date()));
      const [reportMode, setReportMode] = useState('preview');
      const [reportBody, setReportBody] = useState('');
      const [reportDirty, setReportDirty] = useState(false);
      const [reportExcluded, setReportExcluded] = useState([]);
      const [reportGenerating, setReportGenerating] = useState(false);
      const [reportNotice, setReportNotice] = useState(null);
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
      // Load the draft that belongs to the selected period (one draft per week).
      useEffect(() => {
        const draft = reports.find((r) => r.kind === 'week' && periodKey(r.period) === periodKey(reportPeriod)) || null;
        setReportBody(draft ? draft.body : '');
        setReportExcluded(draft && Array.isArray(draft.excluded) ? draft.excluded : []);
        setReportDirty(false);
        setReportNotice(null);
      }, [reportPeriod.start, reportPeriod.end, reports.length]);

      useEffect(() => {
        // Switching tasks closes the inline composers so a draft never leaks
        // into the record of a different task.
        setLogComposerOpen(false); setLogText(''); setLogKind('progress');
        setArtifactComposerOpen(false); setArtifactSummary(''); setArtifactLinks('');
        setAiPanelOpen(false); setAiResult(null); setAiAdopted({});
        setTidyLoading(false); setTidyNote('');
      }, [selectedId]);
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
      const commitLogs = (updater) => {
        setLogs((prev) => {
          const next = typeof updater === 'function' ? updater(prev) : updater;
          saveLogs(next);
          return next;
        });
      };
      const commitArtifacts = (updater) => {
        setArtifacts((prev) => {
          const next = typeof updater === 'function' ? updater(prev) : updater;
          saveArtifacts(next);
          return next;
        });
      };

      // Undo only covers the batch that was just applied; any manual edit in
      // between drops the snapshot so an undo can never silently eat it.
      const applyStatus = (task, newStatus) => {
        setLastApply(null);
        const next = statusTransition(task, newStatus);
        const iso = new Date().toISOString();
        const patch = next.status === 'done'
          ? { ...next, completedAt: iso }
          : { ...next, completedAt: null };
        commit(tasks.map((t) => (t.id === task.id ? { ...t, ...patch, updatedAt: iso } : t)));
      };
      const reopenTask = (task) => {
        setLastApply(null);
        const iso = new Date().toISOString();
        commit(tasks.map((t) => (t.id === task.id ? { ...t, ...reopenedState(), completedAt: null, updatedAt: iso } : t)));
      };
      const toggleDone = (task) => { if (task.status === 'done') reopenTask(task); else applyStatus(task, 'done'); };
      const updateTask = (id, patch) => {
        setLastApply(null);
        commit(tasks.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t)));
      };

      /** Append one work record. Existing records are never edited or removed. */
      const appendLog = (taskId, text, kind, source) => {
        if (!String(text || '').trim()) return false;
        commitLogs((prev) => prev.concat([makeLogEntry(taskId, text, kind, source)]));
        updateTask(taskId, {});
        return true;
      };

      /**
       * Attach an artifact. Saving an artifact must NOT mark the task done —
       * completion is always an explicit user action.
       */
      const addArtifact = (taskId, summary, links) => {
        if (!String(summary || '').trim() && parseLinks(links).length === 0) return false;
        commitArtifacts((prev) => prev.concat([makeArtifact(taskId, summary, links)]));
        updateTask(taskId, {});
        return true;
      };

      // ---- AI actions: preview -> confirm -> apply -> undo ----------------
      const runActions = (actions) => {
        const result = applyActions({ tasks, logs, artifacts }, actions);
        if (result.applied > 0) {
          setTasks(result.next.tasks); saveTasks(result.next.tasks);
          commitLogs(result.next.logs);
          commitArtifacts(result.next.artifacts);
          setLastApply({ before: result.before, at: new Date().toISOString() });
        }
        return result;
      };

      const cancelPending = () => {
        setPendingActions(null);
        setMessages((prev) => prev.concat([{ role: 'assistant', text: '好的，这次变更已取消，什么都没有改动。' }]));
      };

      const confirmPending = () => {
        if (!pendingActions) return;
        const result = runActions(pendingActions.actions);
        setMessages((prev) => prev.concat([{ role: 'assistant', text: summarizeOutcomes(result) }]));
        setPendingActions(null);
      };

      /** "Create anyway": marks one pending create action as explicitly forced. */
      const forcePendingAction = (index) => {
        setPendingActions((prev) => {
          if (!prev) return prev;
          const actions = prev.actions.map((action, i) => (i === index ? { ...action, force: true } : action));
          return { ...prev, actions };
        });
      };

      const undoLastApply = () => {
        if (!lastApply) return;
        setTasks(lastApply.before.tasks); saveTasks(lastApply.before.tasks);
        commitLogs(lastApply.before.logs);
        commitArtifacts(lastApply.before.artifacts);
        setLastApply(null);
        setMessages((prev) => prev.concat([{ role: 'assistant', text: '已撤销上一次变更，数据已恢复到变更前。' }]));
      };

      // ---- in-task AI: advice and record tidying -------------------------
      const analyzeTask = async (task) => {
        if (!task || aiLoading) return;
        setAiPanelOpen(true);
        setAiLoading(true);
        setAiResult(null);
        setAiAdopted({});
        try {
          const res = await fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'task',
              intent: 'analyze',
              task: {
                id: task.id, title: task.title, description: task.description,
                expected: task.expected, nextStep: task.nextStep, blockedReason: task.blockedReason,
                status: task.status, urgency: task.urgency, deadline: task.deadline,
              },
              logs: logsOf(logs, task.id).slice(-10).map((l) => ({ at: l.at, kind: l.kind, text: l.text })),
              artifacts: artifactsOf(artifacts, task.id).slice(-5).map((a) => ({ summary: a.summary, links: a.links })),
            }),
          });
          if (!res.ok) throw new Error('http-' + res.status);
          const data = await res.json();
          if (!data || data.error) throw new Error((data && data.error) || 'model-error');
          setAiResult({
            reply: typeof data.reply === 'string' ? data.reply : '',
            suggestion: data.suggestion || null,
          });
        } catch {
          setAiResult({ reply: 'AI 暂时不可用，稍后再试。', suggestion: null, error: true });
        } finally {
          setAiLoading(false);
        }
      };

      /**
       * Adopting a suggestion is the only way AI text reaches the task.
       * Until this click, the suggestion is displayed as unconfirmed advice.
       */
      const adoptSuggestion = (task, field, value) => {
        if (!task || !value) return;
        updateTask(task.id, { [field]: value });
        setAiAdopted((prev) => ({ ...prev, [field]: true }));
      };

      const tidyLog = async (task) => {
        const raw = logText.trim();
        if (!raw || tidyLoading || !task) return;
        setTidyLoading(true);
        setTidyNote('');
        try {
          const res = await fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'task',
              intent: 'tidy',
              task: { id: task.id, title: task.title, expected: task.expected, nextStep: task.nextStep },
              rawText: raw,
            }),
          });
          if (!res.ok) throw new Error('http-' + res.status);
          const data = await res.json();
          if (!data || data.error) throw new Error((data && data.error) || 'model-error');
          const proposal = data.proposal && typeof data.proposal.text === 'string' ? data.proposal.text.trim() : '';
          if (!proposal) throw new Error('empty-proposal');
          setLogText(proposal);
          if (data.proposal && LOG_KINDS[data.proposal.kind]) setLogKind(data.proposal.kind);
          setTidyNote('AI 已整理。确认无误后再保存，保存的才是你确认的事实。');
        } catch {
          setTidyNote('AI 暂时不可用，已保留你的原文。');
        } finally {
          setTidyLoading(false);
        }
      };

      const addQuick = () => {
        const title = quickText.trim();
        if (!title) { if (quickInputRef.current) quickInputRef.current.focus(); return; }
        const deadline = quickDeadline.time ? quickDeadline.date + 'T' + quickDeadline.time : quickDeadline.date;
        setLastApply(null);
        const task = newTask({ title, deadline });
        addTaskToState(task);
        setQuickText('');
        setQuickDeadline({ date: todayDate(), time: '' });
        setCalOpen(false);
        if (quickInputRef.current) quickInputRef.current.focus();
      };

      const sendChat = async (textArg) => {
        // A pending preview must be resolved first: asking again would replace
        // the card and silently drop the changes the user has not reviewed.
        if (pendingActions) return;
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
          if (intent !== 'create') {
            return '模型暂时不可用，所以这次没有改动任何任务。等模型可用后再试，或直接在任务详情里手动修改。';
          }
          const parsed = parseTask(text, new Date());
          if (parsed) {
            // Local fallback goes through the same action pipeline, so the
            // duplicate guard applies even when the model is unavailable.
            const result = runActions([{
              op: 'create',
              title: parsed.title,
              deadline: parsed.deadline || '',
              urgency: parsed.urgency,
            }]);
            if (result.applied > 0) {
              return '（模型暂不可用，本次由本地规则解析）\n' + buildConfirmation(result.next.tasks[0]);
            }
            return '（模型暂不可用，本次由本地规则解析）\n已存在相同或相似的任务，未重复创建。';
          }
          return '模型暂时不可用，我也没理解这条任务。可以试试「明天10点前完成季度报告，紧急」。';
        };

        try {
          const res = await fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'chat',
              messages: history.slice(-12).map((m) => ({ role: m.role, text: m.text })),
              tasks: tasks.slice(0, 50).map((t) => ({
                id: t.id, title: t.title, status: t.status, urgency: t.urgency,
                deadline: t.deadline, nextStep: t.nextStep, blockedReason: t.blockedReason,
              })),
            }),
          });
          if (!res.ok) throw new Error('http-' + res.status);
          const data = await res.json();
          if (!data || data.error) throw new Error((data && data.error) || 'model-error');
          const reply = typeof data.reply === 'string' ? data.reply : '';
          const actions = Array.isArray(data.actions) ? data.actions : [];
          if (actions.length > 0) {
            // Nothing is written yet: the card above the composer asks first.
            setPendingActions({ actions, reply });
            setMessages((prev) => prev.concat([{
              role: 'assistant',
              text: reply || '我整理了 ' + actions.length + ' 项变更，请在下方确认后执行。',
            }]));
          } else {
            setMessages((prev) => prev.concat([{ role: 'assistant', text: reply || '已处理。' }]));
          }
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

      // Report scope: one draft per week, built from this period's evidence.
      const reportDraft = reports.find((r) => r.kind === 'week' && periodKey(r.period) === periodKey(reportPeriod)) || null;
      const reportEvidenceAll = collectEvidence(tasks, logs, artifacts, reportPeriod);
      const reportEvidence = reportEvidenceAll.filter((item) => reportExcluded.indexOf(item.taskId) === -1);

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
      const viewTitle = { all: '全部任务', today: '今天到期', overdue: '已逾期', done: '已完成', reports: '周报' }[activeView] || '全部任务';
      const statsText = stats.total + ' 项任务 · 已完成 ' + stats.byStatus.done + ' 项';
      const isReportsView = activeView === 'reports';
      const midTitle = isReportsView ? '周报' : viewTitle;
      const midStats = isReportsView
        ? periodLabel(reportPeriod) + ' · 依据 ' + reportEvidence.length + ' 条'
        : statsText;

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

      // Latest record per task, for the "最近进展" line in the list row.
      // Deterministic (no model call): the newest record's own text.
      const lastLogByTask = useMemo(() => {
        const map = {};
        for (const entry of logs) map[entry.taskId] = entry;
        return map;
      }, [logs]);

      const renderRow = (task) => {
        const done = task.status === 'done';
        const dl = rowDeadline(task);
        const recent = lastLogByTask[task.id] || null;
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
            task.description ? h('div', { className: 'wp-row-desc' }, task.description) : null,
            recent ? h('div', { className: 'wp-row-log' },
              h('span', { className: 'wp-row-log-kind' }, LOG_KINDS[recent.kind] || '记录'),
              h('span', { className: 'wp-row-log-text' }, recent.text)) : null),
          dl ? h('span', { className: 'wp-row-time ' + dl.cls }, dl.text) : null);
      };

      // ---- weekly report --------------------------------------------------
      const saveReport = (body) => {
        const text = String(body == null ? reportBody : body);
        const now = new Date().toISOString();
        const existing = reports.find((r) => r.kind === 'week' && periodKey(r.period) === periodKey(reportPeriod)) || null;
        // A+B decision: refs keep the id (navigation) and the snapshot captured
        // now (so editing a task later never rewrites this report).
        const refs = parseRefs(text, reportEvidenceAll).map((ref) => ({
          type: ref.type,
          id: ref.id,
          taskId: ref.item.taskId,
          snapshot: ref.item.snapshot,
          entry: ref.entry ? { at: ref.entry.at, kind: ref.entry.kind, text: ref.entry.text } : null,
          artifact: ref.artifact ? { summary: ref.artifact.summary, links: ref.artifact.links } : null,
        }));
        const record = {
          id: existing ? existing.id : 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          kind: 'week',
          period: { start: reportPeriod.start, end: reportPeriod.end },
          projectScope: '',
          body: text,
          refs,
          excluded: reportExcluded.slice(),
          derivedFromReportIds: existing ? existing.derivedFromReportIds || [] : [],
          status: 'draft',
          createdAt: existing ? existing.createdAt : now,
          updatedAt: now,
        };
        const next = existing ? reports.map((r) => (r.id === existing.id ? record : r)) : reports.concat([record]);
        setReports(next);
        saveReports(next);
        setReportBody(text);
        setReportDirty(false);
        return record;
      };

      const generateReport = async () => {
        if (reportGenerating) return;
        setReportGenerating(true);
        setReportNotice(null);
        try {
          const res = await fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'report',
              kind: 'week',
              period: { start: reportPeriod.start, end: reportPeriod.end },
              evidence: reportEvidence.map((item) => ({
                taskId: item.taskId,
                title: item.title,
                status: item.status,
                completedThisPeriod: item.completedThisPeriod,
                expected: item.expected,
                nextStep: item.nextStep,
                blockedReason: item.blockedReason,
                logs: item.logs.map((entry) => ({ id: entry.id, at: entry.at, kind: entry.kind, text: entry.text })),
                artifacts: item.artifacts.map((artifact) => ({ id: artifact.id, summary: artifact.summary, links: artifact.links })),
              })),
            }),
          });
          if (!res.ok) throw new Error('http-' + res.status);
          const data = await res.json();
          if (!data || data.error) throw new Error((data && data.error) || 'model-error');
          const body = data.report && typeof data.report.body === 'string' ? data.report.body.trim() : '';
          if (!body) throw new Error('empty-report');
          saveReport(body);
          const notices = [];
          if (data.droppedRefs) notices.push('已移除 ' + data.droppedRefs + ' 个无法核对的依据标记');
          if (parseRefs(body, reportEvidenceAll).length === 0) notices.push('正文没有引用任何依据，请人工核对');
          setReportNotice({
            kind: notices.length ? 'warn' : 'ok',
            text: notices.length ? notices.join('；') : '报告已生成并保存为草稿，可继续编辑后复制或导出。',
          });
        } catch {
          setReportNotice({ kind: 'err', text: '生成失败：模型暂时不可用或返回无法解析。你的草稿没有被改动。' });
        } finally {
          setReportGenerating(false);
        }
      };

      const reportMarkdown = () => markdownWithFootnotes(reportBody, reportEvidenceAll);

      const copyReport = () => {
        const text = reportMarkdown();
        const fallbackCopy = () => {
          try {
            const area = document.createElement('textarea');
            area.value = text;
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            document.body.removeChild(area);
            setReportNotice({ kind: 'ok', text: '已复制到剪贴板。' });
          } catch {
            setReportNotice({ kind: 'err', text: '复制失败，请手动选择正文。' });
          }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            () => setReportNotice({ kind: 'ok', text: '已复制到剪贴板。' }),
            fallbackCopy,
          );
        } else {
          fallbackCopy();
        }
      };

      const exportReport = () => {
        try {
          const blob = new Blob([reportMarkdown()], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = '周报_' + reportPeriod.start + '_' + reportPeriod.end + '.md';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(() => URL.revokeObjectURL(url), 0);
          setReportNotice({ kind: 'ok', text: '已导出 Markdown。' });
        } catch {
          setReportNotice({ kind: 'err', text: '导出失败。' });
        }
      };

      const jumpToRef = (ref) => {
        setActiveView('all');
        setSelectedId(ref.item.taskId);
      };

      const toggleEvidence = (taskId) => {
        setReportExcluded((prev) => (prev.indexOf(taskId) === -1 ? prev.concat([taskId]) : prev.filter((id) => id !== taskId)));
      };
      const toggleAllEvidence = () => {
        setReportExcluded(reportExcluded.length ? [] : reportEvidenceAll.map((item) => item.taskId));
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

      // ---------- weekly report ----------
      const renderRefs = (text) => {
        const index = buildEvidenceIndex(reportEvidenceAll);
        const parts = [];
        const re = new RegExp(REF_SOURCE, 'g');
        let cursor = 0;
        let match = re.exec(text);
        let n = 0;
        while (match !== null) {
          if (match.index > cursor) parts.push(text.slice(cursor, match.index));
          const ref = resolveRef(index, match[1], match[2]);
          if (ref) {
            n += 1;
            parts.push(h('button', {
              className: 'wp-ref', key: 'r' + match.index, type: 'button',
              title: refLabel(ref),
              onClick: () => jumpToRef(ref),
            }, String(n)));
          } else {
            // The source disappeared (task deleted) or the marker was hand-edited:
            // keep a visible placeholder rather than silently dropping the claim.
            parts.push(h('span', {
              className: 'wp-ref wp-ref-broken', key: 'r' + match.index, title: '依据已失效',
            }, '?'));
          }
          cursor = match.index + match[0].length;
          match = re.exec(text);
        }
        if (cursor < text.length) parts.push(text.slice(cursor));
        return parts;
      };

      const reportLines = reportBody.trim()
        ? String(reportBody).split('\n').map((line, i) => {
            if (!line.trim()) return h('div', { className: 'wp-report-gap', key: i });
            const heading = /^#{1,4}\s+/.test(line);
            const content = line.replace(/^#{1,4}\s+/, '');
            return h('div', { className: heading ? 'wp-report-h' : 'wp-report-line', key: i }, renderRefs(content));
          })
        : [];

      const reportPanel = h('div', { className: 'wp-report' },
        h('div', { className: 'wp-report-toolbar' },
          h('div', { className: 'wp-report-period' },
            h('button', { className: 'wp-report-nav', type: 'button', 'aria-label': '上一周', onClick: () => setReportPeriod((p) => shiftWeek(p, -1)) }, '‹'),
            h('span', { className: 'wp-report-period-label' }, periodLabel(reportPeriod)),
            h('button', { className: 'wp-report-nav', type: 'button', 'aria-label': '下一周', onClick: () => setReportPeriod((p) => shiftWeek(p, 1)) }, '›'),
            h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => setReportPeriod(weekRangeOf(new Date())) }, '本周')),
          h('div', { className: 'wp-report-actions' },
            h('button', {
              className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button',
              disabled: reportGenerating ? 'true' : undefined,
              onClick: generateReport,
            }, reportGenerating ? '生成中…' : (reportDraft ? '重新生成' : '生成本期报告')),
            h('div', { className: 'wp-kind-seg' },
              h('button', { className: 'wp-status-seg-item', type: 'button', 'data-active': reportMode === 'edit' ? 'true' : 'false', onClick: () => setReportMode('edit') }, '编辑'),
              h('button', { className: 'wp-status-seg-item', type: 'button', 'data-active': reportMode === 'preview' ? 'true' : 'false', onClick: () => setReportMode('preview') }, '预览')),
            h('span', { className: 'wp-report-dirty' }, reportDirty ? '未保存' : (reportDraft ? '已保存' : '')),
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              disabled: reportDirty ? undefined : 'true',
              onClick: () => saveReport(reportBody),
            }, '保存草稿'),
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              disabled: reportBody.trim() ? undefined : 'true', onClick: copyReport,
            }, '复制'),
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              disabled: reportBody.trim() ? undefined : 'true', onClick: exportReport,
            }, '导出 MD'))),
        reportNotice ? h('p', { className: 'wp-report-notice wp-report-notice-' + reportNotice.kind }, reportNotice.text) : null,
        reportBody.trim()
          ? (reportMode === 'edit'
              ? h('textarea', {
                  className: 'wp-report-editor', value: reportBody, spellCheck: false,
                  placeholder: '用 [[task:id]] / [[log:id]] / [[artifact:id]] 标注依据',
                  onChange: (e) => { setReportBody(e.target.value); setReportDirty(true); },
                })
              : h('div', { className: 'wp-report-preview' }, reportLines))
          : h('div', { className: 'wp-report-empty' },
              h('p', { className: 'wp-report-empty-title' }, '还没有本周报告'),
              h('p', { className: 'wp-report-empty-desc' }, '点「生成本期报告」会读取本期完成的任务、工作记录和成果，生成五段式周报；之后可以编辑、复制或导出 Markdown。'),
              reportEvidenceAll.length === 0
                ? h('p', { className: 'wp-report-empty-warn' }, '本期还没有任何工作记录，生成的内容只会指出资料不足。')
                : null));

      const evidencePanel = h('aside', { className: 'wp-evidence' },
        h('div', { className: 'wp-evidence-head' },
          h('span', { className: 'wp-evidence-title' }, '本期依据'),
          h('span', { className: 'wp-evidence-count' }, reportEvidence.length + ' / ' + reportEvidenceAll.length),
          reportEvidenceAll.length
            ? h('button', { className: 'wp-evidence-all', type: 'button', onClick: toggleAllEvidence }, reportExcluded.length ? '全选' : '全不选')
            : null),
        h('p', { className: 'wp-evidence-hint' }, '勾选只影响下一次生成，不会改动已有正文。'),
        reportEvidenceAll.length === 0
          ? h('p', { className: 'wp-detail-empty' }, '本期没有工作记录。先在任务里记录进展或关联成果。')
          : h('div', { className: 'wp-evidence-list' }, reportEvidenceAll.map((item) =>
              h('label', {
                className: 'wp-evidence-item' + (reportExcluded.indexOf(item.taskId) !== -1 ? ' wp-evidence-off' : ''),
                key: item.taskId,
              },
                h('input', {
                  className: 'wp-evidence-check', type: 'checkbox',
                  checked: reportExcluded.indexOf(item.taskId) === -1,
                  onChange: () => toggleEvidence(item.taskId),
                }),
                h('div', { className: 'wp-evidence-body' },
                  h('div', { className: 'wp-evidence-task' }, item.title),
                  h('div', { className: 'wp-evidence-meta' },
                    item.completedThisPeriod ? '本期完成' : '本期有进展',
                    ' · 记录 ' + item.logs.length,
                    item.artifacts.length ? ' · 成果 ' + item.artifacts.length : ''),
                  item.logs.length
                    ? h('div', { className: 'wp-evidence-last' }, item.logs[item.logs.length - 1].text)
                    : null)))));

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
          h('h1', { className: 'wp-mid-title' }, midTitle),
          h('p', { className: 'wp-mid-stats' }, midStats)),
        h('div', { className: 'wp-mid-head-right' },
          isReportsView ? null : h('div', { className: 'wp-search' },
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

      const middleBody = isReportsView
        ? h('div', { className: 'wp-mid-body wp-mid-body-report' }, reportPanel)
        : h('div', { className: 'wp-mid-body' }, quickAdd, toolbar, groupList);

      const navItems = [
        { key: 'all', label: '全部任务', count: stats.total },
        { key: 'today', label: '今天到期', count: stats.todayCount },
        { key: 'overdue', label: '已逾期', count: stats.overdue },
        { key: 'done', label: '已完成', count: stats.byStatus.done },
        { key: 'reports', label: '周报', count: reports.length },
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

      const selectedLogs = selectedTask ? logsOf(logs, selectedTask.id) : [];
      const selectedArtifacts = selectedTask ? artifactsOf(artifacts, selectedTask.id) : [];

      const detailLogComposer = (selectedTask && logComposerOpen) ? h('div', { className: 'wp-composer-panel' },
        h('div', { className: 'wp-kind-seg' }, LOG_KIND_ORDER.map((k) =>
          h('button', {
            className: 'wp-status-seg-item', key: k, type: 'button',
            'data-active': logKind === k ? 'true' : 'false',
            onClick: () => setLogKind(k),
          }, LOG_KINDS[k]))),
        h('textarea', {
          className: 'wp-composer-panel-input', rows: 3, value: logText,
          placeholder: '做了什么 / 遇到什么 / 决定了什么',
          onChange: (e) => { setLogText(e.target.value); setTidyNote(''); },
        }),
        tidyNote ? h('p', { className: 'wp-composer-panel-hint wp-tidy-note' }, tidyNote) : null,
        h('div', { className: 'wp-composer-panel-actions' },
          h('button', {
            className: 'wp-btn wp-btn-text wp-composer-ai', type: 'button',
            disabled: !logText.trim() || tidyLoading ? 'true' : undefined,
            onClick: () => tidyLog(selectedTask),
          }, tidyLoading ? '整理中…' : 'AI 整理'),
          h('span', { className: 'wp-composer-spacer' }),
          h('button', {
            className: 'wp-btn wp-btn-text', type: 'button',
            onClick: () => { setLogComposerOpen(false); setLogText(''); setTidyNote(''); },
          }, '取消'),
          h('button', {
            className: 'wp-btn wp-btn-primary', type: 'button', disabled: !logText.trim(),
            onClick: () => {
              if (appendLog(selectedTask.id, logText, logKind, 'manual')) {
                setLogText('');
                setLogComposerOpen(false);
              }
            },
          }, '保存'))) : null;

      const detailArtifactComposer = (selectedTask && artifactComposerOpen) ? h('div', { className: 'wp-composer-panel' },
        h('textarea', {
          className: 'wp-composer-panel-input', rows: 2, value: artifactSummary,
          placeholder: '结果摘要（可选）',
          onChange: (e) => setArtifactSummary(e.target.value),
        }),
        h('textarea', {
          className: 'wp-composer-panel-input', rows: 2, value: artifactLinks,
          placeholder: '链接或文件引用，一行一个（可选）',
          onChange: (e) => setArtifactLinks(e.target.value),
        }),
        h('p', { className: 'wp-composer-panel-hint' }, '保存成果不会自动把任务标记为完成。'),
        h('div', { className: 'wp-composer-panel-actions' },
          h('button', {
            className: 'wp-btn wp-btn-text', type: 'button',
            onClick: () => { setArtifactComposerOpen(false); setArtifactSummary(''); setArtifactLinks(''); },
          }, '取消'),
          h('button', {
            className: 'wp-btn wp-btn-primary', type: 'button',
            disabled: !artifactSummary.trim() && !artifactLinks.trim(),
            onClick: () => {
              if (addArtifact(selectedTask.id, artifactSummary, artifactLinks)) {
                setArtifactSummary(''); setArtifactLinks(''); setArtifactComposerOpen(false);
              }
            },
          }, '保存'))) : null;

      const detailAiPanel = (selectedTask && aiPanelOpen) ? h('div', { className: 'wp-ai-panel' },
        h('div', { className: 'wp-ai-head' },
          h('span', { className: 'wp-ai-title' }, 'AI 建议'),
          h('span', { className: 'wp-ai-tag' }, '未确认'),
          h('button', {
            className: 'wp-ai-close', type: 'button', 'aria-label': '收起',
            onClick: () => setAiPanelOpen(false),
          }, '×')),
        aiLoading
          ? h('p', { className: 'wp-ai-loading' }, '正在结合这条任务的记录分析…')
          : h('div', { className: 'wp-ai-body' },
              aiResult && aiResult.reply ? h('p', { className: 'wp-ai-reply' }, aiResult.reply) : null,
              aiResult && aiResult.suggestion ? h('div', { className: 'wp-ai-sugs' },
                aiResult.suggestion.summary ? h('div', { className: 'wp-ai-sug' },
                  h('span', { className: 'wp-ai-sug-label' }, '进展摘要'),
                  h('p', { className: 'wp-ai-sug-text' }, aiResult.suggestion.summary)) : null,
                aiResult.suggestion.nextStep ? h('div', { className: 'wp-ai-sug' },
                  h('span', { className: 'wp-ai-sug-label' }, '建议下一步'),
                  h('p', { className: 'wp-ai-sug-text' }, aiResult.suggestion.nextStep),
                  h('button', {
                    className: 'wp-ai-adopt', type: 'button',
                    disabled: aiAdopted.nextStep ? 'true' : undefined,
                    onClick: () => adoptSuggestion(selectedTask, 'nextStep', aiResult.suggestion.nextStep),
                  }, aiAdopted.nextStep ? '已采纳' : '采纳为下一步')) : null,
                aiResult.suggestion.blockedReason ? h('div', { className: 'wp-ai-sug' },
                  h('span', { className: 'wp-ai-sug-label' }, '疑似阻塞'),
                  h('p', { className: 'wp-ai-sug-text' }, aiResult.suggestion.blockedReason),
                  h('button', {
                    className: 'wp-ai-adopt', type: 'button',
                    disabled: aiAdopted.blockedReason ? 'true' : undefined,
                    onClick: () => adoptSuggestion(selectedTask, 'blockedReason', aiResult.suggestion.blockedReason),
                  }, aiAdopted.blockedReason ? '已采纳' : '采纳为阻塞原因')) : null,
                Array.isArray(aiResult.suggestion.risks) && aiResult.suggestion.risks.length
                  ? h('div', { className: 'wp-ai-sug' },
                      h('span', { className: 'wp-ai-sug-label' }, '风险提示'),
                      aiResult.suggestion.risks.map((risk, i) => h('p', { className: 'wp-ai-sug-text', key: i }, '· ' + risk)))
                  : null) : null),
        h('p', { className: 'wp-ai-hint' }, '以上是 AI 建议，只有点「采纳」才会写入任务。')) : null;

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
          h('div', { className: 'wp-detail-field' },
            h('label', { className: 'wp-detail-field-label' }, '预期结果'),
            h('textarea', {
              className: 'wp-detail-input wp-detail-small', rows: 2, value: selectedTask.expected,
              placeholder: '希望交付什么、怎样判断完成（可选）',
              onChange: (e) => updateTask(selectedTask.id, { expected: e.target.value }),
            })),
          h('div', { className: 'wp-detail-field' },
            h('label', { className: 'wp-detail-field-label' }, '下一步'),
            h('textarea', {
              className: 'wp-detail-input wp-detail-small', rows: 2, value: selectedTask.nextStep,
              placeholder: '当前准备采取的具体动作（可选）',
              onChange: (e) => updateTask(selectedTask.id, { nextStep: e.target.value }),
            })),
          selectedTask.status !== 'done' ? h('div', { className: 'wp-detail-field' },
            h('label', { className: 'wp-detail-field-label' }, '阻塞原因'),
            h('textarea', {
              className: 'wp-detail-input wp-detail-small', rows: 2, value: selectedTask.blockedReason,
              placeholder: '有阻塞时补充原因（可选）',
              onChange: (e) => updateTask(selectedTask.id, { blockedReason: e.target.value }),
            })) : null,
          h('div', { className: 'wp-detail-actions' },
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              'aria-expanded': logComposerOpen ? 'true' : 'false',
              onClick: () => { setLogComposerOpen((v) => !v); setArtifactComposerOpen(false); },
            }, '记录进展'),
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              'aria-expanded': artifactComposerOpen ? 'true' : 'false',
              onClick: () => { setArtifactComposerOpen((v) => !v); setLogComposerOpen(false); },
            }, '关联成果'),
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              'aria-expanded': aiPanelOpen ? 'true' : 'false',
              disabled: aiLoading ? 'true' : undefined,
              onClick: () => {
                if (aiLoading) return;
                if (aiPanelOpen) { setAiPanelOpen(false); return; }
                analyzeTask(selectedTask);
              },
            }, aiLoading ? '分析中…' : 'AI 建议')),
          detailLogComposer,
          detailArtifactComposer,
          detailAiPanel,
          h('div', { className: 'wp-detail-section' },
            h('div', { className: 'wp-detail-section-head' },
              h('span', { className: 'wp-detail-section-title' }, '工作记录'),
              selectedLogs.length ? h('span', { className: 'wp-detail-section-count' }, String(selectedLogs.length)) : null),
            selectedLogs.length
              ? h('div', { className: 'wp-log-list' }, selectedLogs.slice().reverse().map((entry) =>
                  h('div', { className: 'wp-log-item', key: entry.id },
                    h('div', { className: 'wp-log-meta' },
                      h('span', { className: 'wp-log-kind wp-log-kind-' + entry.kind }, LOG_KINDS[entry.kind] || '记录'),
                      entry.source === 'ai' ? h('span', { className: 'wp-log-ai-tag' }, 'AI') : null,
                      h('span', { className: 'wp-log-time' }, formatDateTime(entry.at))),
                    h('div', { className: 'wp-log-text' }, entry.text))))
              : h('p', { className: 'wp-detail-empty' }, '还没有记录。点「记录进展」写下这一次推进。')),
          h('div', { className: 'wp-detail-section' },
            h('div', { className: 'wp-detail-section-head' },
              h('span', { className: 'wp-detail-section-title' }, '实际成果'),
              selectedArtifacts.length ? h('span', { className: 'wp-detail-section-count' }, String(selectedArtifacts.length)) : null),
            selectedArtifacts.length
              ? h('div', { className: 'wp-artifact-list' }, selectedArtifacts.slice().reverse().map((item) =>
                  h('div', { className: 'wp-artifact', key: item.id },
                    item.summary ? h('div', { className: 'wp-artifact-summary' }, item.summary) : null,
                    item.links.length ? h('div', { className: 'wp-artifact-links' }, item.links.map((url, i) => {
                      const href = safeHref(url);
                      return href
                        ? h('a', { className: 'wp-artifact-link', key: i, href, target: '_blank', rel: 'noreferrer noopener' }, url)
                        : h('span', { className: 'wp-artifact-url', key: i }, url);
                    })) : null,
                    h('div', { className: 'wp-artifact-time' }, formatDateTime(item.at)))))
              : h('p', { className: 'wp-detail-empty' }, '还没有关联成果。点「关联成果」补充结果摘要或链接。')),
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
        className: 'wp-send-btn', type: 'button', 'aria-label': '发送',
        title: pendingActions ? '请先确认或取消上方的变更' : '发送',
        disabled: !cmdInput.trim() || sending || !!pendingActions, onClick: () => sendChat(),
      }, h(SendIcon));
      const composer = h('div', { className: 'wp-drawer-composer' },
        h('div', { className: 'wp-composer-box' },
          pendingActions ? h('span', { className: 'wp-composer-locked' }, '先确认上方变更') : null,
          composerInput, composerSend));

      const pendingCard = pendingActions ? h('div', { className: 'wp-action-card', role: 'group', 'aria-label': '待确认变更' },
        h('div', { className: 'wp-action-card-head' },
          h('span', { className: 'wp-action-card-title' }, '待确认变更'),
          h('span', { className: 'wp-action-card-count' }, pendingActions.actions.length + ' 项')),
        h('div', { className: 'wp-action-card-list' }, pendingActions.actions.map((action, i) => {
          const info = describeAction(tasks, action);
          return h('div', {
            className: 'wp-action-item' + (info.duplicateOf || info.invalid ? ' wp-action-item-warn' : ''),
            key: i,
          },
            h('span', { className: 'wp-action-op' }, info.label),
            h('div', { className: 'wp-action-body' },
              h('div', { className: 'wp-action-task' }, info.title),
              info.lines.map((line, j) => h('div', { className: 'wp-action-line', key: j }, line)),
              info.duplicateOf ? h('div', { className: 'wp-action-warn' },
                '已存在相似任务「' + info.duplicateOf + '」，执行时将跳过',
                h('button', {
                  className: 'wp-action-force', type: 'button',
                  onClick: () => forcePendingAction(i),
                }, '仍然创建')) : null,
              info.invalid ? h('div', { className: 'wp-action-warn' }, '无法执行，执行时将跳过') : null));
        })),
        h('div', { className: 'wp-action-card-actions' },
          h('button', { className: 'wp-btn wp-btn-text', type: 'button', onClick: cancelPending }, '取消'),
          h('button', { className: 'wp-btn wp-btn-primary', type: 'button', onClick: confirmPending }, '确认执行'))) : null;

      const undoBar = lastApply ? h('div', { className: 'wp-undo-bar' },
        h('span', { className: 'wp-undo-text' }, '上一次变更已生效'),
        h('button', { className: 'wp-undo-btn', type: 'button', onClick: undoLastApply }, '撤销')) : null;

      const drawer = assistantOpen ? h('aside', { className: 'wp-drawer', role: 'dialog', 'aria-label': 'AI 助手' },
        h('div', { className: 'wp-drawer-head' },
          h(SparkIcon, { size: 15 }),
          h('span', { className: 'wp-drawer-title' }, 'AI 助手'),
          h('span', { className: 'wp-drawer-sub' }, '确认后执行 · 可撤销'),
          h('button', { className: 'wp-drawer-close', type: 'button', 'aria-label': '关闭', onClick: () => setAssistantOpen(false) }, '×')),
        h('div', { className: 'wp-drawer-thread', ref: chatScrollRef },
          messages.map((msg, i) => h('div', { className: 'wp-msg wp-msg-' + msg.role, key: i },
            h('div', { className: 'wp-msg-bubble' }, msg.text))),
          sending ? h('div', { className: 'wp-msg wp-msg-assistant' },
            h('div', { className: 'wp-msg-bubble wp-typing' }, '正在思考…')) : null),
        h('div', { className: 'wp-drawer-suggestions' },
          ['明天10点前完成季度报告，紧急', '本周五下午6点前提交方案', '我有哪些任务'].map((s, i) =>
            h('button', { className: 'wp-suggestion', key: i, type: 'button', onClick: () => sendChat(s) }, s))),
        pendingCard,
        undoBar,
        composer) : null;

      return h('div', { className: 'wp-root', 'data-theme': theme },
        h('style', null, CSS),
        h('div', { className: 'wp-workbench' },
          sidenav,
          h('section', { className: 'wp-mid' }, middleHeader, middleBody),
          isReportsView ? evidencePanel : detailPanel),
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
        withV2Fields, newTask, logsOf, latestLog, artifactsOf, parseLinks, safeHref,
        takeTaskSnapshot, makeLogEntry, makeArtifact, LOG_KINDS,
        normalizeTitle, findDuplicateTask, describeAction, applyActions, summarizeOutcomes,
        weekRangeOf, shiftWeek, periodLabel, periodKey, inPeriod, ymd, isoToYmd,
        collectEvidence, buildEvidenceIndex, resolveRef, parseRefs, refLabel, markdownWithFootnotes,
        REPORT_SECTIONS,
      },
    };
  },
});
