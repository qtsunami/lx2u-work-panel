/**
 * Host half of the work-panel bundle.
 *
 * Exposes one authenticated Fetch route under the Connection `/api` channel:
 * the browser posts the chat history plus the current task list, the Host asks
 * the configured default model, and returns a structured reply + optional task.
 */
export const inject = ['connection'];

/** Default conversation model: DeepSeek-V4.1-Flash. */
const DEFAULT_PROVIDER = 'deepseek-account';
const DEFAULT_MODEL = 'deepseek-flash';

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

/** Validate and normalize one task the model proposed. */
function sanitizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;
  const deadlineMatch =
    typeof raw.deadline === 'string' ? /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(raw.deadline.trim()) : null;
  const deadline = deadlineMatch
    ? deadlineMatch[2]
      ? deadlineMatch[1] + 'T' + deadlineMatch[2]
      : deadlineMatch[1]
    : '';
  const urgency = ['low', 'medium', 'high'].includes(raw.urgency) ? raw.urgency : 'medium';
  let status = ['todo', 'doing', 'done'].includes(raw.status) ? raw.status : 'todo';
  let progress = Math.max(0, Math.min(100, Math.round(Number(raw.progress) || 0)));
  if (status === 'done') progress = 100;
  if (progress >= 100) status = 'done';
  else if (progress > 0 && status === 'todo') status = 'doing';
  return { title, deadline, urgency, status, progress };
}

function buildSystemPrompt(today) {
  return [
    '你是一个中文个人任务管理助手。',
    `今天是 ${today}。`,
    '你会收到：当前任务清单（JSON）、对话记录，以及最后一条用户消息。',
    '请判断用户意图，并且只输出一个 JSON 对象（不要 Markdown 代码块、不要额外解释）：',
    '{"reply":"给用户的简洁中文回复","task":null 或 {"title":"任务标题","deadline":"YYYY-MM-DDTHH:mm" 或 null,"urgency":"low|medium|high","status":"todo|doing|done","progress":0-100}}',
    '规则：',
    '1. 用户想创建或记录任务时填 task；只是询问、闲聊、查看清单时 task 为 null。',
    '2. deadline 用本地时间、精确到小时（分钟填 00），没有明确时间就填 null；相对时间（今天/明天/周五等）请换算成具体日期。',
    '3. progress 与 status 必须一致：0 对应 todo，1-99 对应 doing，100 对应 done。',
    '4. 不要编造任务，也不要擅自修改已有任务。',
    '5. reply 要简短友好；创建任务时说明标题、截止时间与紧急程度。',
  ].join('\n');
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
      const messages = Array.isArray(body && body.messages) ? body.messages : [];
      const tasks = Array.isArray(body && body.tasks) ? body.tasks : [];
      const llm = ctx.get('llm');
      if (!llm || typeof preferredProvider !== 'string' || typeof preferredModel !== 'string') {
        return json({ error: 'model-unavailable' });
      }
      try {
        const history = messages
          .filter((m) => m && typeof m.text === 'string' && m.text.length > 0)
          .map((m) => (m.role === 'assistant' ? '助手：' : '用户：') + m.text)
          .join('\n');
        const userText = [
          '当前任务清单（JSON）：',
          JSON.stringify(tasks),
          '',
          '对话记录：',
          history,
          '',
          '请回答以上对话中最后一条用户消息，并按要求输出 JSON。',
        ].join('\n');

        let text = '';
        for await (const chunk of llm.stream({
          provider: preferredProvider,
          model: preferredModel,
          system: buildSystemPrompt(localToday()),
          messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
          temperature: 0.2,
          maxTokens: 800,
        })) {
          if (chunk && chunk.type === 'text-delta') text += chunk.text;
        }

        const parsed = extractJson(text);
        if (!parsed) {
          return json({ reply: text.trim() || '（模型没有返回内容）', task: null });
        }
        const reply =
          typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : '已处理。';
        return json({ reply, task: sanitizeTask(parsed.task) });
      } catch (error) {
        return json({ error: String((error && error.message) || error) });
      }
    },
  };
  ctx.effect(() => ctx.connection.fetch.register(route), 'work-panel: chat route');
}
