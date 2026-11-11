/**
 * Host half of the work-panel bundle.
 *
 * Exposes one authenticated Fetch route under the Connection `/api` channel:
 * the browser posts its context and the Host asks the configured default model.
 *
 * The model never mutates data directly. It returns a list of typed *actions*;
 * the client shows a preview, the user confirms, and only then are they
 * applied (with an undo snapshot). This keeps every model-initiated change
 * reviewable and reversible.
 */
export const inject = ['connection'];

/** Default conversation model: DeepSeek-V4.1-Flash. */
const DEFAULT_PROVIDER = 'deepseek-account';
const DEFAULT_MODEL = 'deepseek-flash';

/** Hard cap so one reply can never flood the panel with changes. */
const MAX_ACTIONS = 8;
const MAX_ACTION_TEXT = 2000;

const json = (value) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Pull the first balanced JSON object out of a model reply (tolerates ``` fences). */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const candidates = [];
  const trimmed = text.trim();
  candidates.push(trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) candidates.push(fence[1].trim());
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function str(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return typeof max === 'number' ? trimmed.slice(0, max) : trimmed;
}

/** Accepts `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`; anything else is dropped. */
function sanitizeDeadline(raw) {
  if (typeof raw !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(raw.trim());
  if (!match) return '';
  return match[2] ? match[1] + 'T' + match[2] : match[1];
}

const URGENCIES = ['low', 'medium', 'high', 'none'];
const LOG_KINDS = ['progress', 'issue', 'decision', 'ai'];

/** Field-level whitelist for `update` — the model can never write anything else. */
function sanitizePatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const patch = {};
  const title = str(raw.title, 200);
  if (title) patch.title = title;
  const deadline = sanitizeDeadline(raw.deadline);
  if (deadline) patch.deadline = deadline;
  if (URGENCIES.includes(raw.urgency)) patch.urgency = raw.urgency;
  for (const key of ['description', 'expected', 'nextStep', 'blockedReason']) {
    if (typeof raw[key] === 'string') patch[key] = str(raw[key], MAX_ACTION_TEXT);
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * Validates the model's action list against the ids the client actually sent.
 * Anything not understood is dropped rather than guessed at.
 */
function sanitizeActions(raw, knownIds) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_ACTIONS)) {
    if (!item || typeof item !== 'object') continue;
    const op = item.op;
    if (op === 'create') {
      const title = str(item.title, 200);
      if (!title) continue;
      out.push({
        op: 'create',
        title,
        deadline: sanitizeDeadline(item.deadline),
        urgency: URGENCIES.includes(item.urgency) ? item.urgency : 'medium',
      });
      continue;
    }
    const taskId = typeof item.taskId === 'string' ? item.taskId : '';
    if (!taskId || !knownIds.has(taskId)) continue;
    if (op === 'update') {
      const patch = sanitizePatch(item.patch);
      if (patch) out.push({ op: 'update', taskId, patch });
    } else if (op === 'complete' || op === 'reopen') {
      out.push({ op, taskId });
    } else if (op === 'log') {
      const body = str(item.text, MAX_ACTION_TEXT);
      if (!body) continue;
      out.push({
        op: 'log',
        taskId,
        kind: LOG_KINDS.includes(item.kind) ? item.kind : 'progress',
        text: body,
      });
    } else if (op === 'artifact') {
      const summary = str(item.summary, 1000);
      const links = Array.isArray(item.links)
        ? item.links.filter((l) => typeof l === 'string' && /^https?:\/\//i.test(l.trim())).map((l) => l.trim()).slice(0, 5)
        : [];
      if (!summary && links.length === 0) continue;
      out.push({ op: 'artifact', taskId, summary, links });
    }
  }
  return out;
}

function sanitizeSuggestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const suggestion = {};
  const summary = str(raw.summary, MAX_ACTION_TEXT);
  if (summary) suggestion.summary = summary;
  const nextStep = str(raw.nextStep, 500);
  if (nextStep) suggestion.nextStep = nextStep;
  const blockedReason = str(raw.blockedReason, 500);
  if (blockedReason) suggestion.blockedReason = blockedReason;
  if (Array.isArray(raw.risks)) {
    const risks = raw.risks
      .filter((r) => typeof r === 'string' && r.trim())
      .map((r) => r.trim().slice(0, 300))
      .slice(0, 5);
    if (risks.length) suggestion.risks = risks;
  }
  return Object.keys(suggestion).length ? suggestion : null;
}

function sanitizeProposal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const body = str(raw.text, MAX_ACTION_TEXT);
  if (!body) return null;
  return { text: body, kind: LOG_KINDS.includes(raw.kind) ? raw.kind : 'progress' };
}

function buildChatSystemPrompt(today) {
  return [
    '你是一个中文个人任务管理助手，可以查询、创建和修改任务。',
    `今天是 ${today}。`,
    '你会收到：当前任务清单（JSON，含 id）、对话记录，以及最后一条用户消息。',
    '只输出一个 JSON 对象（不要 Markdown 代码块、不要额外解释）：',
    '{"reply":"给用户的简洁中文回复","actions":[]}',
    'actions 的每一项必须是下面之一：',
    '{"op":"create","title":"任务标题","deadline":"YYYY-MM-DDTHH:mm"或"","urgency":"low|medium|high|none"}',
    '{"op":"update","taskId":"清单里的 id","patch":{"title":"","deadline":"","urgency":"","nextStep":"","expected":"","blockedReason":"","description":""}}',
    '{"op":"complete","taskId":"..."}',
    '{"op":"reopen","taskId":"..."}',
    '{"op":"log","taskId":"...","kind":"progress|issue|decision|ai","text":"这次推进的内容"}',
    '{"op":"artifact","taskId":"...","summary":"结果摘要","links":["https://..."]}',
    '规则：',
    '1. 用户只是询问、闲聊或查看清单时 actions 为空数组。系统会先把变更交给用户确认再执行，所以你只需给出准确的变更，不要额外解释协议。',
    '2. taskId 只能取自任务清单里的 id 字段，绝不编造；找不到对应任务时 actions 留空，并在 reply 里说明。',
    '3. 创建任务前先检查清单里是否已有相同或高度相似的任务：已有就用 update，不要重复 create。',
    '4. 相对时间（今天/明天/周五等）换算成具体日期，精确到小时（分钟填 00）。',
    '5. 一次最多给出 6 条 actions，按执行顺序排列。',
    '6. reply 简短友好，说明准备做什么改动。',
  ].join('\n');
}

function buildAnalyzeSystemPrompt(today) {
  return [
    '你是一个中文工作助手，正在帮助用户梳理一条任务。',
    `今天是 ${today}。`,
    '你会收到：任务本身（JSON）、它最近的工作记录、以及已关联的成果。',
    '只输出一个 JSON 对象（不要 Markdown 代码块、不要额外解释）：',
    '{"reply":"给用户的简洁中文回复","suggestion":{"summary":"当前进展摘要","nextStep":"建议的下一步动作","blockedReason":"疑似阻塞原因","risks":["风险提示"]}}',
    '规则：',
    '1. 只基于给定的任务与记录推断，不虚构事实、数据或业绩；suggestion 的每个字段都可省略。',
    '2. 记录不足时，在 reply 里直接指出缺少什么信息，不要补写成事实。',
    '3. nextStep 必须是一个具体、可立刻执行的动作（能在一个番茄钟内开始）。',
    '4. 没有发现阻塞时不要填 blockedReason；没有风险时 risks 为空数组。',
    '5. 你的输出只是建议，用户确认后才会写入任务，因此要措辞谨慎。',
  ].join('\n');
}

function buildTidySystemPrompt(today) {
  return [
    '你是一个中文工作助手。用户会把一次 AI 协作或工作产出的原始文字粘贴给你。',
    `今天是 ${today}。`,
    '把它整理成一条简洁、事实准确的工作记录，只输出一个 JSON 对象（不要 Markdown 代码块）：',
    '{"reply":"给用户的简短说明","proposal":{"text":"整理后的工作记录","kind":"progress|issue|decision"}}',
    '规则：',
    '1. 保留原文的事实与数字，不夸大、不补充原文没有的结论。',
    '2. text 用一句到三句话写清「做了什么 / 结果如何」，不超过 300 字。',
    '3. 如果原文包含问题或决策，kind 用 issue 或 decision；否则用 progress。',
    '4. reply 用一句话说明你整理了什么，方便用户核对。',
  ].join('\n');
}

function countText(body, max) {
  return Array.isArray(body) ? body.slice(0, max) : [];
}

function buildChatUserText(body, tasks) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const history = messages
    .filter((m) => m && typeof m.text === 'string' && m.text.length > 0)
    .map((m) => (m.role === 'assistant' ? '助手：' : '用户：') + m.text)
    .join('\n');
  const list = tasks.map((t) => ({
    id: t.id, title: t.title, status: t.status, urgency: t.urgency,
    deadline: t.deadline, nextStep: t.nextStep || '', blockedReason: t.blockedReason || '',
  }));
  return [
    '当前任务清单（JSON）：',
    JSON.stringify(list),
    '',
    '对话记录：',
    history,
    '',
    '请回答以上对话中最后一条用户消息，并按要求输出 JSON。',
  ].join('\n');
}

function buildTaskUserText(body) {
  const task = body && body.task && typeof body.task === 'object' ? body.task : {};
  const logs = countText(body && body.logs, 10).map((l) => ({
    at: l && l.at, kind: l && l.kind, text: l && l.text,
  }));
  const artifacts = countText(body && body.artifacts, 5).map((a) => ({
    summary: a && a.summary, links: a && Array.isArray(a.links) ? a.links.slice(0, 5) : [],
  }));
  if (body && body.intent === 'tidy') {
    return [
      '任务（JSON）：', JSON.stringify(task), '',
      '用户粘贴的原始内容：', String((body && body.rawText) || '').slice(0, 4000), '',
      '请把它整理成一条工作记录，并按要求输出 JSON。',
    ].join('\n');
  }
  return [
    '任务（JSON）：', JSON.stringify(task), '',
    '最近的工作记录（JSON）：', JSON.stringify(logs), '',
    '已关联的成果（JSON）：', JSON.stringify(artifacts), '',
    '请按要求输出 JSON。',
  ].join('\n');
}

async function complete(llm, provider, model, system, user, maxTokens) {
  let text = '';
  for await (const chunk of llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    temperature: 0.2,
    maxTokens,
  })) {
    if (chunk && chunk.type === 'text-delta') text += chunk.text;
  }
  return text;
}

export function apply(ctx, config) {
  const preferredProvider = (config && config.provider) || DEFAULT_PROVIDER;
  const preferredModel = (config && config.model) || DEFAULT_MODEL;
  const route = {
    path: '/api/work-panel/chat',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad-json' });
      }
      const llm = ctx.get('llm');
      if (!llm || typeof preferredProvider !== 'string' || typeof preferredModel !== 'string') {
        return json({ error: 'model-unavailable' });
      }
      const mode = body && body.mode === 'task' ? 'task' : 'chat';
      const tasks = Array.isArray(body && body.tasks) ? body.tasks : [];
      try {
        if (mode === 'task') {
          const tidy = body && body.intent === 'tidy';
          const raw = await complete(
            llm, preferredProvider, preferredModel,
            tidy ? buildTidySystemPrompt(localToday()) : buildAnalyzeSystemPrompt(localToday()),
            buildTaskUserText(body),
            900,
          );
          const parsed = extractJson(raw);
          const reply = parsed && typeof parsed.reply === 'string' && parsed.reply.trim()
            ? parsed.reply.trim()
            : (raw.trim() || '（模型没有返回内容）');
          if (tidy) {
            return json({ reply, proposal: parsed ? sanitizeProposal(parsed.proposal) : null });
          }
          return json({ reply, suggestion: parsed ? sanitizeSuggestion(parsed.suggestion) : null });
        }

        const raw = await complete(
          llm, preferredProvider, preferredModel,
          buildChatSystemPrompt(localToday()),
          buildChatUserText(body, tasks),
          800,
        );
        const parsed = extractJson(raw);
        if (!parsed) return json({ reply: raw.trim() || '（模型没有返回内容）', actions: [] });
        const knownIds = new Set(tasks.map((t) => t && t.id).filter((id) => typeof id === 'string'));
        return json({
          reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : '已处理。',
          actions: sanitizeActions(parsed.actions, knownIds),
        });
      } catch (error) {
        return json({ error: String((error && error.message) || error) });
      }
    },
  };
  ctx.effect(() => ctx.connection.fetch.register(route), 'work-panel: chat route');
}
