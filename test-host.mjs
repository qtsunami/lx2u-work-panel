// Host-half unit test: chat route handler with mocked llm + connection.
import { apply } from './index.js';

let registered;
let routes = [];
function mockStorage() {
  const state = { disk: null, units: {}, failNext: false, opens: 0, closes: 0, writes: 0 };
  const backend = { kv: { open: async (descriptor) => {
    const name = descriptor.name;
    state.opens += 1;
    let memory = structuredClone(state.units[name] ?? null);
    return {
      loadAll: async () => ({ tables: {}, global: structuredClone(memory) }),
      setGlobal: async (value) => {
        state.writes += 1;
        memory = structuredClone(value);
        if (state.failNext) { state.failNext = false; throw new Error('disk full'); }
        state.units[name] = structuredClone(value);
        if (name === 'work-panel-inbox') state.disk = structuredClone(value);
      },
      close: async () => { state.closes += 1; },
    };
  } } };
  return { state, backend: { names: () => ['json'], get: (name) => name === 'json' ? backend : undefined } };
}
function makeCtx(llm, options = {}) {
  const captured = [];
  const disposers = [];
  const storage = options.storage === false ? undefined : (options.storage || mockStorage());
  routes = captured;
  return {
    dispose: async () => { for (const dispose of disposers.reverse()) await dispose(); },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    get: (name) => {
      if (name === 'llm') return llm;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) };
      if (name === 'tools') return options.tools;
      if (name === 'storage') return storage;
      return undefined;
    },
    connection: {
      fetch: {
        register: (route) => { captured.push(route); registered = route; return () => {}; },
      },
    },
  };
}

// mock llm that yields one JSON text-delta
function mockLlm(payload) {
  return {
    stream: async function* () {
      yield { type: 'text-delta', text: payload };
    },
  };
}

// mock llm that records the prompt it was given
function captureLlm(payload) {
  const captured = {};
  return {
    captured,
    stream: async function* (args) {
      captured.system = args && args.system;
      captured.user = args && args.messages && args.messages[0] && args.messages[0].content && args.messages[0].content[0] && args.messages[0].content[0].text;
      yield { type: 'text-delta', text: payload };
    },
  };
}

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log('  ok  ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + '\n        got: ' + a + '\n        exp: ' + e); }
}
async function call(body) {
  const res = await registered.fetch({ json: async () => body });
  return res.json();
}
function routeFor(path) {
  const route = routes.find((item) => item.path === path);
  if (!route) throw new Error('missing route: ' + path);
  return route;
}
async function callRoute(path, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await routeFor(path).fetch({ method, json: async () => body });
  return res.json();
}

const TASKS = [
  { id: 't-1', title: '完成报告', status: 'todo', urgency: 'high', deadline: '2026-11-10T10:00', nextStep: '', blockedReason: '' },
  { id: 't-2', title: '整理纪要', status: 'done', urgency: 'medium', deadline: '', nextStep: '', blockedReason: '' },
];

console.log('\n# route');
registered = undefined;
apply(makeCtx(mockLlm('{}')));
check('route-registered', typeof registered?.fetch, 'function');
check('route-path', registered?.path, '/api/work-panel/chat');
check('route-methods', registered?.methods, ['POST']);

console.log('\n# chat mode: actions');
registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({
  reply: '已准备 3 项变更',
  actions: [
    { op: 'complete', taskId: 't-1' },
    { op: 'update', taskId: 't-2', patch: { urgency: 'high', nextStep: '写提纲' } },
    { op: 'create', title: '写周报', deadline: '2026-11-14T18:00', urgency: 'low' },
  ],
}))));
const r1 = await call({ messages: [{ role: 'user', text: '帮我整理一下' }], tasks: TASKS });
check('chat-reply', r1.reply, '已准备 3 项变更');
check('chat-actions-kept', r1.actions.map((a) => a.op), ['complete', 'update', 'create']);
check('update-patch-filtered', r1.actions[1].patch, { urgency: 'high', nextStep: '写提纲' });
check('create-normalized', [r1.actions[2].title, r1.actions[2].deadline, r1.actions[2].urgency], ['写周报', '2026-11-14T18:00', 'low']);

console.log('\n# chat mode: validation drops unknown/garbage');
registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({
  reply: 'ok',
  actions: [
    { op: 'complete', taskId: 't-9' },                       // unknown task id
    { op: 'update', taskId: 't-1', patch: { bogus: 1 } },     // nothing whitelisted
    { op: 'log', taskId: 't-1', text: '   ' },                // empty body
    { op: 'delete', taskId: 't-1' },                          // unsupported op
    { op: 'create', title: '   ' },                           // empty title
    { op: 'artifact', taskId: 't-1', summary: 'x', links: ['javascript:alert(1)', 'https://a.com'] },
    { op: 'log', taskId: 't-2', kind: 'weird', text: '推进了' },
  ],
}))));
const r2 = await call({ messages: [], tasks: TASKS });
check('garbage-dropped', r2.actions.map((a) => a.op), ['artifact', 'log']);
check('unsafe-link-dropped', r2.actions[0].links, ['https://a.com']);
check('unknown-kind-defaults', r2.actions[1].kind, 'progress');

console.log('\n# chat mode: caps and truncation');
registered = undefined;
const many = [];
for (let i = 0; i < 12; i += 1) many.push({ op: 'create', title: 'T' + i });
apply(makeCtx(mockLlm(JSON.stringify({ reply: 'ok', actions: many }))));
const r3 = await call({ messages: [], tasks: [] });
check('actions-capped', r3.actions.length, 8);
check('actions-capped-first', r3.actions[7].title, 'T7');

registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({
  reply: 'ok',
  actions: [{ op: 'log', taskId: 't-1', text: 'x'.repeat(3000) }],
}))));
const r4 = await call({ messages: [], tasks: TASKS });
check('log-text-truncated', r4.actions[0].text.length, 2000);

console.log('\n# chat mode: tolerant decoding');
registered = undefined;
apply(makeCtx(mockLlm('```json\n{"reply":"好的","actions":[]}\n```')));
check('fenced', await call({ messages: [], tasks: [] }), { reply: '好的', actions: [] });

registered = undefined;
apply(makeCtx(mockLlm('我不太明白')));
check('plain-text', await call({ messages: [], tasks: [] }), { reply: '我不太明白', actions: [] });

registered = undefined;
apply(makeCtx(mockLlm('{"reply":"  "}')));
check('empty-reply-default', (await call({ messages: [], tasks: [] })).reply, '已处理。');

console.log('\n# task mode: analyze');
registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({
  reply: '还缺验收标准',
  suggestion: { summary: '已完成第一步', nextStep: '补验收标准', blockedReason: '   ', risks: ['x', 'y', 'z', 'a', 'b', 'c'], extra: 'drop me' },
}))));
const a1 = await call({ mode: 'task', intent: 'analyze', task: { id: 't-1', title: '完成报告' }, logs: [] });
check('analyze-reply', a1.reply, '还缺验收标准');
check('suggestion-fields', [a1.suggestion.summary, a1.suggestion.nextStep], ['已完成第一步', '补验收标准']);
check('blank-blocker-omitted', 'blockedReason' in a1.suggestion, false);
check('risks-capped', a1.suggestion.risks.length, 5);
check('unknown-field-dropped', 'extra' in a1.suggestion, false);
check('no-actions-in-task-mode', 'actions' in a1, false);

console.log('\n# task mode: tidy');
registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({
  reply: '整理好了',
  proposal: { text: '  用 AI 生成了初稿，人工修订后确认  ', kind: 'decision' },
}))));
const t1 = await call({ mode: 'task', intent: 'tidy', task: { id: 't-1' }, rawText: '原始文字' });
check('tidy-proposal', t1.proposal, { text: '用 AI 生成了初稿，人工修订后确认', kind: 'decision' });

registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({ reply: '没有内容', proposal: { text: '', kind: 'progress' } }))));
check('tidy-empty-proposal-null', (await call({ mode: 'task', intent: 'tidy' })).proposal, null);

registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({ reply: 'ok', proposal: { text: 'x', kind: 'bogus' } }))));
check('tidy-kind-fallback', (await call({ mode: 'task', intent: 'tidy' })).proposal.kind, 'progress');

console.log('\n# report mode');
const EVIDENCE = [{
  taskId: 't-1', title: '上线插件', status: 'done', completedThisPeriod: true,
  expected: 'v1 发布', nextStep: '', blockedReason: '',
  logs: [{ id: 'l-1', at: '2026-11-10T04:00:00.000Z', kind: 'progress', text: '完成发布' }],
  artifacts: [{ id: 'a-1', summary: '发布记录', links: ['https://a.com'] }],
}];
registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({
  reply: '依据 1 个任务',
  body: '## 一、本期主要成果\n- 上线插件已完成 [[task:t-1]]\n- 编造的引用 [[task:t-9]]\n- 记录 [[log:l-1]]',
}))));
const rp = await call({ mode: 'report', kind: 'week', period: { start: '2026-11-09', end: '2026-11-15' }, evidence: EVIDENCE });
check('report-reply', rp.reply, '依据 1 个任务');
check('report-keeps-known-refs', [rp.report.body.indexOf('[[task:t-1]]') > 0, rp.report.body.indexOf('[[log:l-1]]') > 0], [true, true]);
check('report-drops-unknown-ref', rp.report.body.indexOf('t-9'), -1);
check('report-drop-count', rp.droppedRefs, 1);

registered = undefined;
apply(makeCtx(mockLlm('随便一段话，没有 JSON')));
const rpBad = await call({ mode: 'report', evidence: EVIDENCE });
check('report-unparseable', [rpBad.error, rpBad.report], ['empty-report', null]);

registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({ reply: '', body: '## 一、本期主要成果\n本期缺少相关记录' }))));
const rpEmpty = await call({ mode: 'report', evidence: [] });
check('report-empty-evidence-ok', rpEmpty.report.body.indexOf('缺少相关记录') > 0, true);
check('report-no-refs-zero-dropped', rpEmpty.droppedRefs, 0);

console.log('\n# report mode: monthly prompt');
const WEEKLY = [{ period: '2026-11-09 ~ 2026-11-15', body: '本周完成了发布 [[task:t-1]]' }];
const capMonth = captureLlm(JSON.stringify({ reply: 'ok', body: '## 一、本期主要成果\n- 月度完成 [[task:t-1]]' }));
registered = undefined;
apply(makeCtx(capMonth));
await call({ mode: 'report', kind: 'month', period: { start: '2026-11-01', end: '2026-11-30' }, evidence: EVIDENCE, weeklies: WEEKLY });
check('month-prompt-says-month', capMonth.captured.system.indexOf('月报') > 0, true);
check('month-prompt-demands-summary', capMonth.captured.system.indexOf('不要逐条拼接') > 0, true);
check('month-prompt-asks-dedupe', capMonth.captured.system.indexOf('只写一次') > 0, true);
check('month-prompt-carries-weeklies', capMonth.captured.user.indexOf('2026-11-09 ~ 2026-11-15') > 0, true);
check('month-prompt-has-weekly-body', capMonth.captured.user.indexOf('本周完成了发布') > 0, true);
check('month-prompt-has-period', capMonth.captured.user.indexOf('2026-11-01 ~ 2026-11-30') > 0, true);

const capWeek = captureLlm(JSON.stringify({ reply: 'ok', body: '## 一、本期主要成果\n- 周度完成 [[task:t-1]]' }));
registered = undefined;
apply(makeCtx(capWeek));
await call({ mode: 'report', kind: 'week', period: { start: '2026-11-09', end: '2026-11-15' }, evidence: EVIDENCE, weeklies: WEEKLY });
check('week-prompt-says-week', capWeek.captured.system.indexOf('整理成周报') > 0, true);
check('week-prompt-no-weeklies-instruction', capWeek.captured.system.indexOf('不要逐条拼接'), -1);
check('week-prompt-ignores-weeklies', capWeek.captured.user.indexOf('周报 2026-11-09'), -1);

console.log('\n# polish mode');
registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({ reply: '更紧凑', polished: '- 上线插件已完成 [[task:t-1]]' }))));
const pol = await call({ mode: 'polish', kind: 'week', paragraph: '- 上线插件已完成，而且已经收尾了 [[task:t-1]]' });
check('polish-reply', pol.reply, '更紧凑');
check('polish-text', pol.polished, '- 上线插件已完成 [[task:t-1]]');

registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({ reply: 'x', polished: '- 上线插件已完成' }))));
check('polish-rejects-lost-marker', (await call({ mode: 'polish', paragraph: '- 完成 [[task:t-1]]' })).error, 'lost-evidence');

registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({ reply: 'x', polished: '新增依据 [[task:t-9]]' }))));
check('polish-rejects-invented-marker', (await call({ mode: 'polish', paragraph: '没有依据的句子' })).error, 'lost-evidence');

registered = undefined;
apply(makeCtx(mockLlm('{}')));
check('polish-empty-paragraph', (await call({ mode: 'polish', paragraph: '   ' })).error, 'empty-paragraph');

registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({ reply: '', polished: '  ' }))));
check('polish-empty-result', (await call({ mode: 'polish', paragraph: '有内容' })).error, 'empty-polish');

registered = undefined;
apply(makeCtx(undefined));
check('polish-no-model', (await call({ mode: 'polish', paragraph: 'x' })).error, 'model-unavailable');

console.log('\n# project-aware actions');
const PROJECTS = [{ id: 'p-1', name: '工作台', status: 'active' }, { id: 'p-2', name: '客户', status: 'archived' }];
registered = undefined;
apply(makeCtx(mockLlm(JSON.stringify({ reply: 'ok', actions: [
  { op: 'update', taskId: 't-1', patch: { projectId: 'p-1' } },
  { op: 'update', taskId: 't-2', patch: { projectId: 'p-9' } },
  { op: 'create', title: '新任务', projectId: 'p-2' },
  { op: 'create', title: '编造项目', projectId: 'p-9' },
  { op: 'update', taskId: 't-1', patch: { projectId: '' } },
]}))));
const projRes = await call({ messages: [], tasks: TASKS, projects: PROJECTS });
check('unknown-project-update-dropped', projRes.actions.length, 4);
check('known-project-kept', projRes.actions[0].patch, { projectId: 'p-1' });
check('create-keeps-project', projRes.actions[1].projectId, 'p-2');
check('create-drops-unknown-project', 'projectId' in projRes.actions[2], false);
check('ungroup-kept', projRes.actions[3].patch, { projectId: '' });

registered = undefined;
const capProjects = captureLlm(JSON.stringify({ reply: 'ok', actions: [] }));
apply(makeCtx(capProjects));
await call({ messages: [], tasks: TASKS, projects: PROJECTS });
check('prompt-lists-projects', capProjects.captured.user.indexOf('工作台') > 0, true);
check('prompt-warns-against-inventing-projects', capProjects.captured.system.indexOf('绝不编造') > 0, true);
check('prompt-schema-mentions-projectId', capProjects.captured.system.indexOf('"projectId"') > 0, true);

console.log('\n# report mode: project context');
registered = undefined;
const capReportProject = captureLlm(JSON.stringify({ reply: 'ok', body: '## 一、本期主要成果\n- 完成 [[task:t-1]]' }));
apply(makeCtx(capReportProject));
await call({
  mode: 'report', kind: 'week',
  period: { start: '2026-11-09', end: '2026-11-15' },
  project: { name: '工作台', description: '插件开发' },
  evidence: EVIDENCE,
});
check('report-user-names-project', capReportProject.captured.user.indexOf('报告项目：工作台') > 0, true);
check('report-user-carries-description', capReportProject.captured.user.indexOf('插件开发') > 0, true);
check('report-user-scope-warning', capReportProject.captured.user.indexOf('不要提及无关项目') > 0, true);

console.log('\n# failure paths');
registered = undefined;
apply(makeCtx(undefined));
check('no-model', await call({ messages: [], tasks: [] }), { error: 'model-unavailable' });
check('no-model-task-mode', await call({ mode: 'task' }), { error: 'model-unavailable' });

registered = undefined;
apply(makeCtx(mockLlm('{}')));
const res5 = await registered.fetch({ json: async () => { throw new Error('bad'); } });
check('bad-json', await res5.json(), { error: 'bad-json' });

registered = undefined;
apply(makeCtx({ stream: async function* () { throw new Error('boom'); } }));
check('llm-error', await call({ messages: [], tasks: [] }), { error: 'boom' });

console.log('\n# execution report-back inbox');
registered = undefined;
apply(makeCtx(mockLlm('{}')));
check('inbox-route', routeFor('/api/work-panel/inbox').methods, ['GET']);
check('report-back-route', routeFor('/api/work-panel/report-back').methods, ['POST']);
check('ack-route', routeFor('/api/work-panel/inbox/ack').methods, ['POST']);

const emptyReport = await callRoute('/api/work-panel/report-back', { taskId: 't-1' });
check('report-back-requires-text', emptyReport.error, 'empty-report');

const queued = await callRoute('/api/work-panel/report-back', {
  taskId: 't-1',
  text: '  写完了方案初稿  ',
  kind: 'bogus',
  artifacts: [
    { summary: '方案 v1', links: ['https://a.com', 'javascript:alert(1)'] },
    { summary: '', links: [] },
  ],
});
check('report-back-accepted', [queued.ok, queued.pending], [true, 1]);

const inboxAfter = await callRoute('/api/work-panel/inbox', {});
check('inbox-lists-item', inboxAfter.items.length, 1);
check('item-text-trimmed', inboxAfter.items[0].text, '写完了方案初稿');
check('item-unknown-kind-defaults', inboxAfter.items[0].kind, 'progress');
check('item-links-filtered', inboxAfter.items[0].artifacts.length, 1);
check('item-links-safe', inboxAfter.items[0].artifacts[0].links, ['https://a.com']);
check('item-has-timestamp', typeof inboxAfter.items[0].receivedAt, 'string');

const acked = await callRoute('/api/work-panel/inbox/ack', { ids: [inboxAfter.items[0].id] });
check('ack-removes-item', [acked.ok, acked.removed], [true, 1]);
check('inbox-empty-after-ack', (await callRoute('/api/work-panel/inbox', {})).items.length, 0);

console.log('\n# execution report tool');
const toolDefs = [];
registered = undefined;
apply(makeCtx(mockLlm('{}'), { tools: { register: (definition) => { toolDefs.push(definition); return () => {}; } } }));
check('tools-registered', toolDefs.map((definition) => definition.name), ['work_panel_report', 'work_panel_context']);
const tool = toolDefs[0];
check('tool-name', tool.name, 'work_panel_report');
check('tool-requires-text', (tool.description || '').length > 20, true);
check('tool-params-require-text', tool.parameters.required, ['text']);
const toolCall = await tool.execute({ taskId: 't-1', text: '用脚本生成周报草稿', sourceSessionId: 'spoofed', artifacts: [{ files: ['/tmp/产物.txt'], links: ['file:///tmp/产物.txt', '/tmp/产物.txt'] }] }, { agent: { id: 'real-session' } });
check('tool-enqueues', [toolCall.ok, toolCall.pending], [true, 1]);
const inboxFromTool = await callRoute('/api/work-panel/inbox', {});
check('tool-item-visible', inboxFromTool.items[0].text, '用脚本生成周报草稿');
check('tool-item-source', inboxFromTool.items[0].source, 'execution');
check('tool-true-source-session', inboxFromTool.items[0].sourceSessionId, 'real-session');
check('tool-files-plain-text', inboxFromTool.items[0].artifacts[0].files, ['/tmp/产物.txt']);
check('tool-local-path-not-open-link', inboxFromTool.items[0].artifacts[0].links, []);
const toolEmpty = await tool.execute({});
check('tool-rejects-empty', [toolEmpty.ok, toolEmpty.error], [false, 'empty-report']);
check('tool-render-reports-failure', tool.output.render({}, toolEmpty)[0].text.includes('未确认成功'), true);
check('tool-schema-has-request-id', tool.parameters.properties.requestId.type, 'string');

// A profile without the tool registry still loads: routes work, no tool.
registered = undefined;
apply(makeCtx(mockLlm('{}')));
check('no-tool-without-registry', routeFor('/api/work-panel/inbox') !== undefined, true);

console.log('\n# durable inbox across plugin restart');
const persistent = mockStorage();
let persistentCtx = makeCtx(mockLlm('{}'), { storage: persistent });
apply(persistentCtx);
const persisted = await callRoute('/api/work-panel/report-back', { requestId: 'retry-1', taskId: 't-1', text: '持久保存' });
check('accepted-is-persisted', persistent.state.disk.items[0].id, persisted.id);
await persistentCtx.dispose();
persistentCtx = makeCtx(mockLlm('{}'), { storage: persistent });
apply(persistentCtx);
check('restart-recovers-inbox', (await callRoute('/api/work-panel/inbox', {})).items[0].id, persisted.id);
const duplicate = await callRoute('/api/work-panel/report-back', { requestId: 'retry-1', taskId: 't-1', text: '持久保存' });
check('retry-reuses-persisted-id', [duplicate.ok, duplicate.id, duplicate.duplicate, duplicate.pending], [true, persisted.id, true, 1]);
const conflict = await callRoute('/api/work-panel/report-back', { requestId: 'retry-1', taskId: 't-1', text: '不同内容' });
check('request-id-conflict', [conflict.ok, conflict.error], [false, 'request-id-conflict']);
check('bad-request-id', (await callRoute('/api/work-panel/report-back', { requestId: '', text: 'x' })).error, 'invalid-request-id');
check('non-string-request-id', (await callRoute('/api/work-panel/report-back', { requestId: 42, text: 'x' })).error, 'invalid-request-id');
check('long-request-id', (await callRoute('/api/work-panel/report-back', { requestId: 'x'.repeat(201), text: 'x' })).error, 'invalid-request-id');
check('ack-validation', (await callRoute('/api/work-panel/inbox/ack', { ids: 'all' })).error, 'invalid-ack');
await callRoute('/api/work-panel/inbox/ack', { ids: [persisted.id, persisted.id] });
check('duplicate-ack', await callRoute('/api/work-panel/inbox/ack', { ids: [persisted.id] }), { ok: true, removed: 0 });
await persistentCtx.dispose();
persistentCtx = makeCtx(mockLlm('{}'), { storage: persistent });
apply(persistentCtx);
check('ack-persists-across-restart', (await callRoute('/api/work-panel/inbox', {})).items.length, 0);
check('acked-request-id-still-dedupes', (await callRoute('/api/work-panel/report-back', { requestId: 'retry-1', taskId: 't-1', text: '持久保存' })).id, persisted.id);
check('acked-retry-does-not-requeue', (await callRoute('/api/work-panel/inbox', {})).items.length, 0);

console.log('\n# write failures are not successful and chain recovers');
persistent.state.failNext = true;
const failedWrite = await callRoute('/api/work-panel/report-back', { text: '未保存' });
check('report-write-failure-not-ok', [failedWrite.ok, failedWrite.error, failedWrite.uncertain], [false, 'inbox-write-failed', true]);
const goodWrite = await callRoute('/api/work-panel/report-back', { text: '之后成功' });
check('next-report-after-failed-write', [goodWrite.ok, goodWrite.pending], [true, 1]);
check('failed-write-not-leaked', (await callRoute('/api/work-panel/inbox', {})).items.map((entry) => entry.text), ['之后成功']);
persistent.state.failNext = true;
const failedAck = await callRoute('/api/work-panel/inbox/ack', { ids: [goodWrite.id] });
check('ack-write-failure-not-ok', [failedAck.ok, failedAck.error], [false, 'inbox-write-failed']);
check('ack-failure-preserves-item', (await callRoute('/api/work-panel/inbox', {})).items.length, 1);
await persistentCtx.dispose();

console.log('\n# unavailable storage fails closed for routes and tool');
const missingTools = [];
apply(makeCtx(mockLlm('{}'), { storage: false, tools: { register: (definition) => { missingTools.push(definition); return () => {}; } } }));
const missingStorage = await callRoute('/api/work-panel/report-back', { text: '不应接受' });
check('storage-missing-no-ok', [missingStorage.ok, missingStorage.error], [false, 'storage-unavailable']);
const missingList = await callRoute('/api/work-panel/inbox', {});
check('storage-missing-list-no-empty-success', [missingList.ok, missingList.error, 'items' in missingList], [false, 'storage-unavailable', false]);
check('storage-missing-ack-no-ok', (await callRoute('/api/work-panel/inbox/ack', { ids: [] })).ok, false);
const missingToolResult = await missingTools[0].execute({ text: '不应接受' });
check('storage-missing-tool-no-ok', [missingToolResult.ok, missingToolResult.error], [false, 'storage-unavailable']);
check('storage-missing-tool-render', missingTools[0].output.render({}, missingToolResult)[0].text.includes('未确认成功'), true);
const badJsonReport = await routeFor('/api/work-panel/report-back').fetch({ json: async () => { throw new Error('bad'); } });
check('report-bad-json-structured', (await badJsonReport.json()).ok, false);
const badJsonAck = await routeFor('/api/work-panel/inbox/ack').fetch({ json: async () => { throw new Error('bad'); } });
check('ack-bad-json-structured', (await badJsonAck.json()).error, 'bad-json');

console.log('\n# default capacity is explicit rejection, not eviction');
const capacity = mockStorage();
apply(makeCtx(mockLlm('{}'), { storage: capacity }));
const submissions = await Promise.all(Array.from({ length: 201 }, (_, i) => callRoute('/api/work-panel/report-back', { text: '条目' + i })));
check('capacity-accepts-200', submissions.filter((result) => result.ok).length, 200);
check('capacity-rejects-overflow', [submissions[200].ok, submissions[200].error], [false, 'inbox-full']);
check('capacity-keeps-first-item', (await callRoute('/api/work-panel/inbox', {})).items[0].id, submissions[0].id);
check('capacity-persisted-count', capacity.state.disk.items.length, 200);

console.log('\n# explicit backend configuration does not guess');
apply(makeCtx(mockLlm('{}')), { inboxBackend: 'missing' });
check('configured-missing-backend', (await callRoute('/api/work-panel/report-back', { text: 'x' })).error, 'storage-backend-unavailable');

console.log('\n# Host authoritative workspace and shared read-only context');
const workspaceStorage = mockStorage();
const workspaceTools = [];
let workspaceCtx = makeCtx(mockLlm('{}'), { storage: workspaceStorage, tools: { register: (definition) => { workspaceTools.push(definition); return () => {}; } } });
apply(workspaceCtx, { inboxBackend: 'json' });
const initialWorkspace = await callRoute('/api/work-panel/workspace');
check('workspace-route-methods', routeFor('/api/work-panel/workspace').methods, ['GET', 'POST']);
check('uninitialized-workspace-explicit', [initialWorkspace.ok, initialWorkspace.initialized, initialWorkspace.revision, initialWorkspace.workspace, initialWorkspace.storeId], [true, false, 0, null, null]);
const snapshot = { tasks: [{ id: 't-1', title: 'Host任务', status: 'todo', projectId: '', expected: '通过验收' }], projects: [], logs: [], artifacts: [], reports: [], inboxAck: [], reportEdits: {}, settings: { density: 'compact' }, future: ['保留'] };
const initWorkspace = { action: 'initialize', baseRevision: 0, requestId: 'workspace-init', workspace: snapshot, storeId: null };
const initialized = await callRoute('/api/work-panel/workspace', initWorkspace);
check('workspace-init-success', [initialized.ok, initialized.revision, initialized.currentRevision, typeof initialized.storeId], [true, 1, 1, 'string']);
check('workspace-migration-backup', workspaceStorage.state.units['work-panel-workspace'].migrationBackup.workspace, snapshot);
const commitWorkspace = { action: 'commit', baseRevision: 1, requestId: 'workspace-commit', workspace: { ...snapshot, tasks: [{ ...snapshot.tasks[0], title: '已修改' }] }, storeId: initialized.storeId };
const committed = await callRoute('/api/work-panel/workspace', commitWorkspace);
check('workspace-commit-success', [committed.ok, committed.revision, committed.storeId], [true, 2, initialized.storeId]);
const conflictWorkspace = await callRoute('/api/work-panel/workspace', { ...commitWorkspace, requestId: 'stale' });
check('workspace-cas-conflict', [conflictWorkspace.ok, conflictWorkspace.error, conflictWorkspace.currentRevision], [false, 'revision-conflict', 2]);
const storeConflict = await callRoute('/api/work-panel/workspace', { ...commitWorkspace, requestId: 'wrong-store', baseRevision: 2, storeId: 'other-store' });
check('workspace-store-id-conflict', [storeConflict.ok, storeConflict.error], [false, 'store-id-conflict']);
const repeatedInit = await callRoute('/api/work-panel/workspace', initWorkspace);
check('workspace-replay-keeps-applied-revision', [repeatedInit.duplicate, repeatedInit.revision, repeatedInit.currentRevision], [true, 1, 2]);
const contextTool = workspaceTools.find((definition) => definition.name === 'work_panel_context');
const contextReadRoute = await callRoute('/api/work-panel/context', { action: 'read', taskId: 't-1' });
const contextReadTool = await contextTool.execute({ action: 'read', taskId: 't-1' });
check('context-route-tool-identical', contextReadRoute, contextReadTool);
check('context-read-latest-host-state', [contextReadRoute.task.title, contextReadRoute.revision], ['已修改', 2]);
const contextList = await contextTool.execute({ action: 'list' });
check('context-bounded-task-list', contextList.items, [{ id: 't-1', title: '已修改', projectId: '', status: 'todo' }]);
const preparedTask = await contextTool.execute({ action: 'prepare', taskId: 't-1' });
check('context-prepare-includes-acceptance', preparedTask.prompt.includes('通过验收'), true);
check('context-prepare-not-execution', (await callRoute('/api/work-panel/workspace')).revision, 2);
check('context-no-task-write-action', (await contextTool.execute({ action: 'complete', taskId: 't-1' })).error, 'invalid-context-action');
check('workspace-extensions-kept', (await callRoute('/api/work-panel/workspace')).workspace.future, ['保留']);
const badWorkspaceJson = await routeFor('/api/work-panel/workspace').fetch({ method: 'POST', json: async () => { throw new Error('bad'); } });
check('workspace-bad-json-structured', (await badWorkspaceJson.json()).error, 'bad-json');
workspaceStorage.state.failNext = true;
const workspaceWriteFailure = await callRoute('/api/work-panel/workspace', { ...commitWorkspace, baseRevision: 2, requestId: 'failed-workspace' });
check('workspace-write-failure-not-ok', [workspaceWriteFailure.ok, workspaceWriteFailure.error, workspaceWriteFailure.uncertain], [false, 'workspace-write-failed', true]);
check('workspace-failed-write-preserves-revision', (await callRoute('/api/work-panel/workspace')).revision, 2);
await workspaceCtx.dispose();
workspaceCtx = makeCtx(mockLlm('{}'), { storage: workspaceStorage }); apply(workspaceCtx, { inboxBackend: 'json' });
const workspaceRestarted = await callRoute('/api/work-panel/workspace');
check('workspace-restart-recovers', [workspaceRestarted.revision, workspaceRestarted.storeId, workspaceRestarted.workspace.tasks[0].title], [2, initialized.storeId, '已修改']);
// The two stores use different units even though they share a backend.
await callRoute('/api/work-panel/report-back', { text: '独立回传', sourceSessionId: 'spoofed-http' });
const independentInbox = await callRoute('/api/work-panel/inbox', {});
check('inbox-is-separate-unit', independentInbox.items.length, 1);
check('http-cannot-spoof-source-session', 'sourceSessionId' in independentInbox.items[0], false);
check('inbox-write-does-not-replace-workspace', (await callRoute('/api/work-panel/workspace')).revision, 2);
await workspaceCtx.dispose();

console.log('\n# selected context and local path action metadata');
const selectedLlm = captureLlm(JSON.stringify({ reply: '待确认', actions: [
  { op: 'artifact', taskId: 't-2', files: ['/tmp/result.md'], links: ['file:///tmp/result.md'] },
  { op: 'log', taskId: 't-2', text: '已完成校验', files: ['/tmp/check.txt'] },
] }));
apply(makeCtx(selectedLlm));
const selectedReply = await call({ tasks: TASKS, projects: PROJECTS, messages: [{ text: '这条' }], context: { taskId: 't-2', projectId: 'p-1', report: { kind: 'week', period: { start: '2026-11-01', end: '2026-11-07' }, body: 'x'.repeat(5000) } } });
check('selected-task-first-in-prompt', selectedLlm.captured.user.indexOf('"id":"t-2"') < selectedLlm.captured.user.indexOf('"id":"t-1"'), true);
check('selected-context-explicit', selectedLlm.captured.user.includes('"taskId":"t-2"'), true);
check('report-context-bounded', selectedLlm.captured.user.includes('x'.repeat(4001)), false);
check('prompt-distinguishes-proposal-from-history', selectedLlm.captured.system.includes('建议、计划、假设不得写成log'), true);
check('artifact-local-path-metadata', selectedReply.actions[0].files, ['/tmp/result.md']);
check('artifact-local-path-not-url', selectedReply.actions[0].links, []);
check('log-local-path-metadata', selectedReply.actions[1].files, ['/tmp/check.txt']);

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' (' + pass + ' passed)');
process.exit(fail === 0 ? 0 : 1);
