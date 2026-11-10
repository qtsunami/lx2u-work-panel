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

// 1. happy path: model returns a task
registered = undefined;
apply(makeCtx(mockLlm('{"reply":"已创建任务","task":{"title":"完成报告","deadline":"2026-11-10T10:00","urgency":"high","status":"todo","progress":0}}')));
check('route-registered', typeof registered?.fetch, 'function');
check('route-path', registered?.path, '/api/work-panel/chat');
check('route-methods', registered?.methods, ['POST']);

const res1 = await registered.fetch({ json: async () => ({ messages: [{ role: 'user', text: '明天10点前完成报告，紧急' }], tasks: [] }) });
check('happy', await res1.json(), { reply: '已创建任务', task: { title: '完成报告', deadline: '2026-11-10T10:00', urgency: 'high', status: 'todo', progress: 0 } });

// 2. model replies with fenced JSON
registered = undefined;
apply(makeCtx(mockLlm('```json\n{"reply":"好的","task":null}\n```')));
const res2 = await registered.fetch({ json: async () => ({ messages: [{ role: 'user', text: '你好' }], tasks: [] }) });
check('fenced', await res2.json(), { reply: '好的', task: null });

// 3. model returns non-JSON text
registered = undefined;
apply(makeCtx(mockLlm('我不太明白')));
const res3 = await registered.fetch({ json: async () => ({ messages: [{ role: 'user', text: '?' }], tasks: [] }) });
check('plain-text', await res3.json(), { reply: '我不太明白', task: null });

// 4. no model available
registered = undefined;
apply(makeCtx(undefined));
const res4 = await registered.fetch({ json: async () => ({ messages: [], tasks: [] }) });
check('no-model', await res4.json(), { error: 'model-unavailable' });

// 5. bad request json
registered = undefined;
apply(makeCtx(mockLlm('{}')));
const res5 = await registered.fetch({ json: async () => { throw new Error('bad'); } });
check('bad-json', await res5.json(), { error: 'bad-json' });

// 6. model error path
registered = undefined;
apply(makeCtx({ stream: async function* () { throw new Error('boom'); } }));
const res6 = await registered.fetch({ json: async () => ({ messages: [], tasks: [] }) });
check('llm-error', await res6.json(), { error: 'boom' });

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' (' + pass + ' passed)');
process.exit(fail === 0 ? 0 : 1);
