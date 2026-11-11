// Host-half unit test: chat route handler with mocked llm + connection.
import { apply } from './index.js';

let registered;
function makeCtx(llm) {
  return {
    effect: (fn) => fn(),
    get: (name) => {
      if (name === 'llm') return llm;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) };
      return undefined;
    },
    connection: { fetch: { register: (route) => { registered = route; return () => {}; } } },
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

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' (' + pass + ' passed)');
process.exit(fail === 0 ? 0 : 1);
