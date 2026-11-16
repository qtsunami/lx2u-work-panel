// Browser-safe, side-effect-free local search; no imports, clock, storage or model.
// searchWorkspace(workspace, query) returns { tasks, logs, artifacts, reports, total }.
// Results retain source order, one result per matching item. `matches` contains
// the original field text and the first match's UTF-16 [start,end) offsets;
// array fields use e.g. `files[0]`. Treat text as text, never as HTML.
// Query is trimmed and matched as a literal, case-insensitive substring, not a
// regular expression or a tokenized query. Empty/non-string queries match nothing.
// Reports are historical standalone documents: their body remains searchable even
// when referenced tasks have been deleted. Only *live* task IDs appear in their
// taskIds. Deleted/orphaned tasks' own records and artifacts are never returned.

function searchObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function searchId(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function searchList(workspace, key) {
  return Array.isArray(workspace[key]) ? workspace[key] : [];
}

function searchMatches(record, fields, pattern) {
  const matches = [];
  for (const field of fields) {
    const value = record[field];
    const values = Array.isArray(value) ? value : [value];
    for (let index = 0; index < values.length; index += 1) {
      const text = values[index];
      if (typeof text !== 'string') continue;
      const match = pattern.exec(text);
      if (match) matches.push({ field: Array.isArray(value) ? field + '[' + index + ']' : field,
        text, start: match.index, end: match.index + match[0].length });
    }
  }
  return matches;
}

/**
 * Search known human-readable workspace fields; never mutate input or return
 * references to its mutable objects. Missing/malformed arrays are treated as empty.
 * Each result is {type,id,taskId,taskTitle,matches}; reports additionally expose
 * taskIds (deduplicated live references). Reports have null taskId/taskTitle.
 * `total` counts results, not occurrences; no hidden limit or ranking is applied.
 */
export function searchWorkspace(workspace, query) {
  const result = { tasks: [], logs: [], artifacts: [], reports: [], total: 0 };
  if (!searchObject(workspace) || typeof query !== 'string' || !query.trim()) return result;
  // Escaping metacharacters prevents queries such as '[' or '.*' being executed.
  const pattern = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  const tasks = new Map();
  for (const task of searchList(workspace, 'tasks')) {
    if (searchObject(task) && searchId(task.id) && !task.deletedAt) tasks.set(task.id, task);
  }
  const add = (group, type, record, fields, task, extra) => {
    if (!searchObject(record) || !searchId(record.id)) return;
    const matches = searchMatches(record, fields, pattern);
    if (!matches.length) return;
    result[group].push({ type, id: record.id, taskId: task ? task.id : null,
      taskTitle: task && typeof task.title === 'string' ? task.title : null, matches, ...extra });
    result.total += 1;
  };
  for (const task of tasks.values()) {
    add('tasks', 'task', task, ['title', 'description', 'expected', 'nextStep', 'blockedReason'], task);
  }
  for (const log of searchList(workspace, 'logs')) {
    if (!searchObject(log)) continue;
    const task = tasks.get(log.taskId);
    if (task) add('logs', 'log', log, ['text', 'files'], task);
  }
  for (const artifact of searchList(workspace, 'artifacts')) {
    if (!searchObject(artifact)) continue;
    const task = tasks.get(artifact.taskId);
    if (task) add('artifacts', 'artifact', artifact, ['summary', 'links', 'files'], task);
  }
  for (const report of searchList(workspace, 'reports')) {
    if (!searchObject(report)) continue;
    const taskIds = [];
    if (Array.isArray(report.refs)) {
      for (const ref of report.refs) {
        if (searchObject(ref) && tasks.has(ref.taskId) && !taskIds.includes(ref.taskId)) taskIds.push(ref.taskId);
      }
    }
    add('reports', 'report', report, ['body', 'projectName'], null, { taskIds });
  }
  return result;
}
