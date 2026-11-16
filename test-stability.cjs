'use strict';
// Stateful, isolated VM regression suite. Never reads browser/profile storage.
// Run: node work-panel/test-stability.cjs [optional test-name substring]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const PREFIX = '@local/work-panel:';
const KEY = Object.fromEntries(['tasks', 'projects', 'logs', 'artifacts', 'reports', 'inbox-ack', 'report-edits', 'transaction', 'workspace-extras', 'host-meta', 'host-pending'].map(k => [k, PREFIX + k + ':v1']));
const PRE = PREFIX + 'backup:pre-import:v1';
const NOW = '2026-11-12T04:00:00.000Z';
const PERIOD = { start: '2026-11-09', end: '2026-11-15' };
const editKey = (scope = '', kind = 'week', period = PERIOD) => JSON.stringify([kind, period.start, period.end, scope]);
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class MemoryStorage {
  constructor(entries = []) { this.map = new Map(entries); this.failures = []; this.calls = []; }
  fail(op, key, times = 1, predicate = () => true) { this.failures.push({ op, key, times, predicate }); }
  check(op, key, value) {
    this.calls.push({ op, key, value });
    const fault = this.failures.find(f => f.times > 0 && f.op === op && (f.key === '*' || f.key === key) && f.predicate(value));
    if (fault) { fault.times--; throw new Error('injected localStorage ' + op + ': ' + key); }
  }
  getItem(key) { key = String(key); this.check('get', key); return this.map.get(key) ?? null; }
  setItem(key, value) { key = String(key); value = String(value); this.check('set', key, value); this.map.set(key, value); }
  removeItem(key) { key = String(key); this.check('remove', key); this.map.delete(key); }
  key(index) { return [...this.map.keys()][index] ?? null; }
  get length() { return this.map.size; }
  json(key, fallback = null) { const value = this.map.get(key); return value == null ? fallback : JSON.parse(value); }
}
class FakeTimers {
  constructor() { this.now = 0; this.next = 1; this.jobs = new Map(); }
  add(fn, delay = 0, interval = false) { const id = this.next++; this.jobs.set(id, { fn, at: this.now + Number(delay), interval: interval ? Math.max(1, Number(delay)) : 0 }); return id; }
  clear(id) { this.jobs.delete(id); }
  advance(ms) {
    const end = this.now + ms;
    for (let n = 0; n < 1000; n++) {
      const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) { this.now = end; return; }
      const [id, job] = next; this.now = job.at;
      if (job.interval) job.at += job.interval; else this.jobs.delete(id);
      job.fn();
    }
    throw new Error('fake timer runaway');
  }
}
function walk(node, output = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, output));
  else if (node && typeof node === 'object') { output.push(node); walk(node.children || [], output); }
  return output;
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return text(node.children || []);
}
const hasClass = (node, cls) => String(node.props?.className || '').split(/\s+/).includes(cls);

// One hook list per mounted root, persistent slots, queued functional state
// updates, dependency-aware post-commit effects and cleanup. No state indexes
// are exposed to tests: every application mutation enters through a UI handler.
function createRuntime() {
  const slots = [], pending = [], refs = new Map();
  let cursor = 0, root, tree, dirty = true, mounted = true, effects = [];
  const slot = (kind, init) => {
    const index = cursor++;
    if (!slots[index]) slots[index] = { kind, ...init() };
    assert.equal(slots[index].kind, kind, 'hook order changed');
    return slots[index];
  };
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const React = {
    createElement: (type, props, ...children) => ({
      type, props: props || {}, children,
      // Deterministic measurement so layout-dependent UI (context submenu
      // alignment) can be asserted without a real layout engine.
      getBoundingClientRect() {
        const tag = String((props && props.className) || type || '');
        return { top: tag.includes('wp-row-menu-parent') ? 96 : 0, left: 0, width: 224, height: 24 };
      },
    }),
    useState(init) {
      const item = slot('state', () => ({ value: typeof init === 'function' ? init() : init }));
      if (!item.set) item.set = update => { if (mounted) pending.push([item, update]); };
      return [item.value, item.set];
    },
    useRef(init) { return slot('ref', () => ({ value: { current: init } })).value; },
    useMemo(fn, deps) {
      const item = slot('memo', () => ({ ready: false }));
      if (!item.ready || !sameDeps(item.deps, deps)) { item.value = fn(); item.deps = deps; item.ready = true; }
      return item.value;
    },
    useEffect(fn, deps) {
      const item = slot('effect', () => ({ ready: false }));
      if (!item.ready || !sameDeps(item.deps, deps)) effects.push({ item, fn, deps });
    },
  };
  function flush() {
    if (!mounted || !root) return;
    for (let round = 0; round < 100; round++) {
      while (pending.length) {
        const [item, update] = pending.shift();
        const next = typeof update === 'function' ? update(item.value) : update;
        if (!Object.is(next, item.value)) { item.value = next; dirty = true; }
      }
      if (!dirty) return;
      cursor = 0; effects = []; dirty = false;
      tree = root();
      for (const node of walk(tree)) {
        const ref = node.props.ref;
        if (ref && typeof ref === 'object') {
          if (!refs.has(ref)) refs.set(ref, {
            focus() {}, click() {}, contains: () => false, scrollTop: 0, scrollHeight: 0,
            // Deterministic geometry so layout-dependent UI (the context submenu
            // anchor) can be asserted without a layout engine. The class-based
            // value lets one element be distinguished from another.
            getBoundingClientRect() { return { top: 72, left: 100, width: 224, height: 26 }; },
          });
          ref.current = refs.get(ref);
        }
      }
      const committed = effects; effects = [];
      for (const { item, fn, deps } of committed) {
        if (typeof item.cleanup === 'function') item.cleanup();
        item.ready = true; item.deps = deps; item.cleanup = fn();
      }
    }
    throw new Error('render/effect loop did not settle');
  }
  return {
    React, flush,
    mount(component) { root = component; flush(); },
    get tree() { return tree; },
    unmount() { mounted = false; for (const item of slots) if (item.kind === 'effect' && typeof item.cleanup === 'function') item.cleanup(); for (const ref of refs.keys()) ref.current = null; },
  };
}
function task(id, projectId = '', title = id) {
  return { id, title, projectId, status: 'done', urgency: 'medium', progress: 100, description: '', deadline: '', expected: '', nextStep: '', blockedReason: '', deletedAt: null, droppedAt: null, completedAt: NOW, createdAt: NOW, updatedAt: NOW };
}
function report(scope = '', body = 'saved-' + (scope || 'all'), period = PERIOD, kind = 'week') {
  return { id: 'r-' + kind + '-' + period.start + '-' + scope, kind, period, projectId: scope, body, refs: [], excluded: [], status: 'draft', createdAt: NOW, updatedAt: NOW };
}
function workspace(overrides = {}) {
  return { tasks: [], projects: [], logs: [], artifacts: [], reports: [], inboxAck: [], reportEdits: {}, ...overrides };
}
function fixture() {
  return workspace({ tasks: [task('ta', 'pa'), task('tb', 'pb')], projects: [{ id: 'pa', name: '项目A', description: '', color: '', status: 'active', archivedAt: null, createdAt: NOW, updatedAt: NOW }, { id: 'pb', name: '项目B', description: '', color: '', status: 'active', archivedAt: null, createdAt: NOW, updatedAt: NOW }], reports: [report(''), report('pa'), report('pb')] });
}
function seedStorage(state) {
  return new MemoryStorage([
    [KEY.tasks, JSON.stringify(state.tasks)], [KEY.projects, JSON.stringify(state.projects)],
    [KEY.logs, JSON.stringify(state.logs)], [KEY.artifacts, JSON.stringify(state.artifacts)],
    [KEY.reports, JSON.stringify(state.reports)], [KEY['inbox-ack'], JSON.stringify(state.inboxAck)],
    [KEY['report-edits'], JSON.stringify(state.reportEdits)], [PREFIX + 'migration:projects:v1', 'v1'],
    [KEY['workspace-extras'], JSON.stringify(Object.fromEntries(Object.entries(state).filter(([key]) => !['tasks', 'projects', 'logs', 'artifacts', 'reports', 'inboxAck', 'reportEdits'].includes(key))))],
  ]);
}
function harness(state = fixture(), storage = seedStorage(state), options = {}) {
  const runtime = createRuntime(), timers = new FakeTimers(), requests = [], events = new Map(), downloads = [];
  // The fake Host is not a browser-storage key: remounts share canonical state
  // without contaminating exported localStorage or workspace assertions.
  if (!storage.workspaceServer) storage.workspaceServer = { initialized: true, revision: 1, storeId: 'vm-store', workspace: plain(state), updatedAt: NOW, history: new Map(), calls: [], offline: false };
  const server = storage.workspaceServer;
  const harnessOptions = options;
  if (options.workspaceGetFailure) server.getHook = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, error: 'workspace-load-failed', retryable: true }) });
  const response = data => Promise.resolve({ ok: true, status: 200, json: async () => plain(data) });
  const workspaceFetch = (options = {}) => {
    const body = options.method === 'POST' ? JSON.parse(options.body) : null;
    server.calls.push({ method: body ? 'POST' : 'GET', body: body && plain(body) });
    if (server.offline) return Promise.reject(new Error('fake Host offline'));
    if (!body) {
      if (server.getHook) return server.getHook();
      return response({ ok: true, initialized: server.initialized, revision: server.initialized ? server.revision : 0, storeId: server.initialized ? server.storeId : null, workspace: server.initialized ? server.workspace : null, updatedAt: server.updatedAt });
    }
    if (server.postHook) return server.postHook(body);
    if (!['initialize', 'commit'].includes(body.action) || typeof body.requestId !== 'string') return response({ ok: false, error: 'invalid-request' });
    if (body.action === 'commit' && body.storeId !== server.storeId) return response({ ok: false, error: 'store-id-conflict', currentRevision: server.revision });
    const fingerprint = JSON.stringify(body);
    if (server.history.has(body.requestId)) {
      const old = server.history.get(body.requestId);
      if (old.fingerprint !== fingerprint) return response({ ok: false, error: 'request-id-conflict' });
      return response({ ok: true, revision: old.revision, currentRevision: server.revision, storeId: server.storeId, updatedAt: server.updatedAt, duplicate: true });
    }
    if ((body.action === 'initialize' && (server.initialized || body.baseRevision !== 0)) || (body.action === 'commit' && (!server.initialized || body.baseRevision !== server.revision))) return response({ ok: false, error: 'revision-conflict', currentRevision: server.revision });
    if (!body.workspace || typeof body.workspace !== 'object' || !['tasks', 'projects', 'logs', 'artifacts', 'reports', 'inboxAck'].every(key => Array.isArray(body.workspace[key])) || !body.workspace.reportEdits) return response({ ok: false, error: 'invalid-workspace' });
    if (body.action === 'initialize') { server.initialized = true; server.revision = 0; server.storeId = 'vm-migrated-store'; }
    server.workspace = plain(body.workspace); server.revision++; server.updatedAt = NOW;
    server.history.set(body.requestId, { fingerprint, revision: server.revision });
    return response({ ok: true, revision: server.revision, currentRevision: server.revision, storeId: server.storeId, updatedAt: server.updatedAt });
  };
  const fetch = (url, options = {}) => {
    if (url === '/api/work-panel/workspace') return workspaceFetch(options);
    if (url === '/api/work-panel/context') {
      const body = JSON.parse(options.body);
      const value = harnessOptions.contextHook ? harnessOptions.contextHook(body, server) : { ok: false, error: 'no-context-fixture' };
      return Promise.resolve(value).then(response);
    }
    if (url === '/api/work-panel/inbox') {
      if (harnessOptions.inboxHook) return Promise.resolve().then(() => harnessOptions.inboxHook()).then(response);
      return response({ items: harnessOptions.inboxItems || [] });
    }
    if (url === '/api/work-panel/inbox/ack') {
      const body = JSON.parse(options.body);
      return Promise.resolve(harnessOptions.ackHook ? harnessOptions.ackHook(body, server) : { ok: true }).then(response);
    }
    assert.equal(url, '/api/work-panel/chat', 'unexpected fetch; real networking prohibited');
    const d = deferred();
    const request = { url, options, body: JSON.parse(options.body), ...d, respond(data, ok = true) { d.resolve({ ok, status: ok ? 200 : 500, json: async () => data }); } };
    requests.push(request);
    return d.promise;
  };
  let registration;
  const doc = {
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); },
    createElement: () => ({ click() {}, select() {} }), body: { appendChild() {}, removeChild() {} }, execCommand() {},
  };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [Date.parse(NOW) + timers.now])); } static now() { return Date.parse(NOW) + timers.now; } }
  const sandbox = { console, Date: ClockDate, JSON, Math, Map, Set, Promise, Blob, URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} }, navigator: options.navigator || {}, document: doc, fetch,
    setTimeout: (fn, ms) => timers.add(fn, ms), clearTimeout: id => timers.clear(id),
    setInterval: (fn, ms) => timers.add(fn, ms, true), clearInterval: id => timers.clear(id),
    window: { localStorage: storage, matchMedia: () => ({ matches: false }), __ModuleLoader__: { load: reg => { registration = reg; } } },
  };
  sandbox.window.addEventListener = doc.addEventListener.bind(doc); sandbox.window.removeEventListener = doc.removeEventListener.bind(doc);
  vm.createContext(sandbox); vm.runInContext(SOURCE, sandbox, { filename: 'client.js' });
  const plugin = registration.factory(name => { assert.equal(name, 'react'); return runtime.React; });
  let WorkPanel;
  plugin.apply({ get: (name) => options.services && options.services[name], slots: { inject: (_, fn) => fn(), register(spec, component) { if (spec.key === 'work-panel') WorkPanel = component; return () => {}; } } });
  assert.equal(typeof WorkPanel, 'function'); runtime.mount(WorkPanel);
  const ui = {
    storage, server, workspaceFetch, response, timers, requests, downloads, debug: plugin.__debug, runtime, events,
    nodes: () => walk(runtime.tree),
    text: () => text(runtime.tree),
    one(predicate, description = 'UI node') { const found = this.nodes().filter(predicate); assert.equal(found.length, 1, description + ': expected one, found ' + found.length); return found[0]; },
    byClass(cls) { return this.one(node => hasClass(node, cls), cls); },
    button(label) { return this.one(node => node.type === 'button' && (text(node) === label || (node.children || []).some(child => child && hasClass(child, 'wp-nav-label') && text(child) === label) || node.props['aria-label'] === label || node.props.title === label), 'button ' + label); },
    fire(node, event, value = {}) {
      const disabledPath = (current, blocked = false) => {
        if (Array.isArray(current)) return current.some(child => disabledPath(child, blocked));
        if (!current || typeof current !== 'object') return false;
        const disabled = blocked || (current.type === 'fieldset' && !!current.props.disabled);
        return current === node ? disabled : disabledPath(current.children || [], disabled);
      };
      assert.ok(!node.props.disabled && !disabledPath(runtime.tree), 'cannot interact with disabled control ' + text(node));
      assert.equal(typeof node.props[event], 'function', 'missing ' + event);
      const result = node.props[event]({ preventDefault() {}, stopPropagation() {}, ...value }); runtime.flush(); return result;
    },
    click(label) { return this.fire(this.button(label), 'onClick'); },
    change(cls, value) { return this.fire(this.byClass(cls), 'onChange', { target: { value } }); },
    scope(id) { this.change('wp-report-scope', id); },
    reports() { this.click('周报/月报'); this.click('编辑'); },
    body() { const editor = this.nodes().find(node => hasClass(node, 'wp-report-editor')); return editor ? editor.props.value : text(this.nodes().find(node => hasClass(node, 'wp-report-preview'))); },
    dirty() { return text(this.byClass('wp-report-dirty')) === '未保存'; },
    edit(value) { this.change('wp-report-editor', value); },
    nextRequest(mode = 'report') { const request = requests.find(r => !r.taken && r.body.mode === mode); assert.ok(request, 'expected deferred request ' + mode); request.taken = true; return request; },
    import(raw) { const file = deferred(); const target = { files: [{ text: () => file.promise }], value: 'backup.json' }; const done = this.fire(this.byClass('wp-data-file'), 'onChange', { target }); file.resolve(JSON.stringify(raw)); return done; },
    startFile() { const file = deferred(); const target = { files: [{ text: () => file.promise }], value: 'backup.json' }; const done = this.fire(this.byClass('wp-data-file'), 'onChange', { target }); return { ...file, done, target }; },
    async settle() { // Drain known promise continuations, never poll wall-clock time/network.
      for (let i = 0; i < 40; i++) { await Promise.resolve(); runtime.flush(); }
    },
    async respond(request, data) { request.respond(data); await this.settle(); },
    close() { timers.advance(0); runtime.flush(); runtime.unmount(); assert.equal(timers.jobs.size, 0, 'timer cleanup on unmount'); },
  };
  return ui;
}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function backup(state = workspace()) { return { app: 'work-panel', schema: 1, version: '1.3.2', exportedAt: NOW, ...state }; }
function storedWorkspace(ui) { return { ...ui.storage.json(KEY['workspace-extras'], {}), tasks: ui.storage.json(KEY.tasks, []), projects: ui.storage.json(KEY.projects, []), logs: ui.storage.json(KEY.logs, []), artifacts: ui.storage.json(KEY.artifacts, []), reports: ui.storage.json(KEY.reports, []), inboxAck: ui.storage.json(KEY['inbox-ack'], []), reportEdits: ui.storage.json(KEY['report-edits'], {}) }; }
function data(ui) { ui.click('数据'); }
function clear(ui) { ui.click('清空本地数据'); ui.click('确认清空'); }
async function chat(ui, actions) {
  if (!ui.nodes().some(n => hasClass(n, 'wp-drawer'))) ui.click('AI 助手');
  ui.change('wp-composer-input', '测试修改任务'); ui.click('发送');
  const request = ui.nextRequest('chat'); await ui.respond(request, { reply: '请确认', actions });
}

test('harness: persistent hooks, functional setters, dependencies, post-render effects and cleanup', async () => {
  const runtime = createRuntime(), calls = []; let set, ref, renders = 0;
  runtime.mount(() => {
    renders++; const [n, update] = runtime.React.useState(() => 0); set = update;
    const current = runtime.React.useRef('initial'); if (ref) assert.equal(current, ref); ref = current;
    assert.equal(ref.current, 'initial');
    runtime.React.useEffect(() => { calls.push('effect:' + n + ':' + renders); return () => calls.push('cleanup:' + n); }, [n]);
    return runtime.React.createElement('div', null, n);
  });
  assert.deepEqual(calls, ['effect:0:1']);
  set(n => n + 1); set(n => n + 1); runtime.flush();
  assert.equal(text(runtime.tree), '2'); assert.deepEqual(calls, ['effect:0:1', 'cleanup:0', 'effect:2:2']);
  set(2); runtime.flush(); assert.equal(renders, 2);
  runtime.unmount(); assert.equal(calls.at(-1), 'cleanup:2');
});

test('harness: fake timers and deferred fetch are deterministic and cleanup stops polling', async () => {
  const ui = harness(); await ui.settle();
  await ui.settle();
  const polls = [...ui.timers.jobs.values()].filter(job => job.interval);
  assert.equal(polls.length, 1); assert.equal(polls[0].interval, 5000);
  ui.timers.advance(5000); await ui.settle();
  assert.equal(ui.timers.now, 5000);
  ui.reports(); ui.click('重新生成'); const request = ui.nextRequest();
  await ui.settle(); assert.equal(ui.button('生成中…').props.disabled, 'true');
  await ui.respond(request, { report: { body: 'deterministically resolved' } });
  assert.equal(ui.body(), 'deterministically resolved');
  ui.close();
});

test('same week project drafts load only matching scope', async () => {
  const ui = harness(); await ui.settle(); try {
    ui.reports(); assert.equal(ui.body(), 'saved-all');
    ui.scope('pa'); assert.equal(ui.body(), 'saved-pa');
    ui.scope('pb'); assert.equal(ui.body(), 'saved-pb');
    ui.scope(''); assert.equal(ui.body(), 'saved-all');
  } finally { ui.close(); }
});

test('unsaved buffers survive scope round trips, period changes and refresh', async () => {
  let ui = harness(); await ui.settle(); const storage = ui.storage;
  try {
    ui.reports(); ui.scope('pa'); ui.edit('A unsaved');
    ui.scope('pb'); assert.equal(ui.body(), 'saved-pb'); ui.edit('B unsaved');
    ui.scope('pa'); assert.equal(ui.body(), 'A unsaved'); assert.ok(ui.dirty());
    ui.click('上一周'); ui.click('下一周'); assert.equal(ui.body(), 'A unsaved');
    assert.equal(storage.json(KEY['report-edits'])[editKey('pa')].body, 'A unsaved');
    assert.equal(storage.json(KEY['report-edits'])[editKey('pb')].body, 'B unsaved');
    ui.close(); ui = harness(fixture(), storage); await ui.settle();
    ui.reports(); ui.scope('pb'); assert.equal(ui.body(), 'B unsaved'); assert.ok(ui.dirty());
    ui.scope('pa'); assert.equal(ui.body(), 'A unsaved'); assert.ok(ui.dirty());
    ui.click('保存草稿'); assert.ok(!ui.dirty());
    assert.equal(storage.json(KEY.reports).find(r => r.projectId === 'pa').body, 'A unsaved');
    assert.ok(!storage.json(KEY['report-edits'])[editKey('pa')], 'saved buffer should be retired');
  } finally { ui.close(); }
});

test('async generation A then switch/edit B cannot touch B', async () => {
  const ui = harness(); await ui.settle(); try {
    ui.reports(); ui.scope('pa'); ui.click('重新生成'); const request = ui.nextRequest();
    assert.equal(request.body.projectId, 'pa'); ui.scope('pb'); ui.edit('B latest manual');
    await ui.respond(request, { report: { body: 'A generated' } });
    assert.equal(ui.body(), 'B latest manual'); assert.ok(ui.dirty());
    assert.equal(ui.storage.json(KEY.reports).find(r => r.projectId === 'pb').body, 'saved-pb');
    ui.scope('pa'); assert.equal(ui.body(), 'A generated');
  } finally { ui.close(); }
});

test('same-key generation never overwrites edits made while awaiting model', async () => {
  const ui = harness(); await ui.settle(); try {
    ui.reports(); ui.scope('pa'); ui.click('重新生成'); const request = ui.nextRequest();
    ui.edit('A manual newer than request');
    await ui.respond(request, { report: { body: 'stale model text' } });
    assert.equal(ui.body(), 'A manual newer than request'); assert.ok(ui.dirty());
    assert.equal(ui.storage.json(KEY['report-edits'])[editKey('pa')].body, 'A manual newer than request');
    assert.notEqual(ui.storage.json(KEY.reports).find(r => r.projectId === 'pa').body, 'stale model text');
  } finally { ui.close(); }
});

test('saving a newer same-key draft during generation invalidates the old response', async () => {
  const ui = harness(); await ui.settle(); try {
    ui.reports(); ui.scope('pa'); ui.click('重新生成'); const request = ui.nextRequest();
    ui.edit('newer explicitly saved draft'); ui.click('保存草稿');
    await ui.respond(request, { report: { body: 'older generated response' } });
    assert.equal(ui.body(), 'newer explicitly saved draft'); assert.ok(!ui.dirty());
    assert.equal(ui.storage.json(KEY.reports).find(r => r.projectId === 'pa').body, 'newer explicitly saved draft');
  } finally { ui.close(); }
});

test('first import into empty workspace can undo back to completely empty', async () => {
  const ui = harness(workspace()); await ui.settle(); try {
    data(ui); const done = ui.import(backup(fixture())); await done; await ui.settle();
    assert.equal(ui.storage.json(KEY.tasks).length, 2);
    ui.click('撤销上次导入/清空');
    assert.deepEqual(storedWorkspace(ui), workspace());
    assert.ok(ui.text().includes('0 任务 · 0 记录 · 0 成果 · 0 报告'));
  } finally { ui.close(); }
});

for (const operation of ['clear', 'import', 'daily restore']) test('PRE_IMPORT write failure blocks ' + operation, async () => {
  const ui = harness(); await ui.settle(); try {
    await ui.settle(); data(ui); const before = storedWorkspace(ui);
    ui.storage.fail('set', PRE, Infinity);
    if (operation === 'clear') clear(ui);
    else if (operation === 'import') { ui.click('覆盖'); const done = ui.import(backup(workspace({ tasks: [task('replacement')] }))); await done; await ui.settle(); }
    else ui.click('恢复到每日快照');
    assert.deepEqual(storedWorkspace(ui), before, 'failed pre-operation backup must leave all stores unchanged');
    assert.match(ui.text(), /失败|未能|无法|未.*保存|不能/);
    assert.ok(!ui.nodes().some(n => n.type === 'button' && text(n) === '撤销上次导入/清空'));
  } finally { ui.close(); }
});

test('unrelated batch-added project reports preserve current dirty editor', async () => {
  const state = fixture(); state.reports = [report('')];
  const ui = harness(state); await ui.settle(); try {
    ui.reports(); ui.click('按项目生成'); ui.click('确认生成');
    const a = ui.nextRequest(); assert.equal(a.body.projectId, 'pa'); ui.edit('global unsaved during batch');
    await ui.respond(a, { report: { body: 'batch A' } });
    assert.equal(ui.body(), 'global unsaved during batch'); assert.ok(ui.dirty());
    const b = ui.nextRequest(); assert.equal(b.body.projectId, 'pb');
    await ui.respond(b, { report: { body: 'batch B' } });
    assert.equal(ui.body(), 'global unsaved during batch'); assert.ok(ui.dirty());
    const saved = ui.storage.json(KEY.reports); assert.equal(saved.length, 3);
    assert.equal(saved.find(r => r.projectId === '').body, 'saved-all');
  } finally { ui.close(); }
});

test('workspace replacement invalidates old undo and pending assistant actions', async () => {
  const ui = harness(); await ui.settle(); try {
    await chat(ui, [{ op: 'update', taskId: 'ta', patch: { title: 'changed A' } }]);
    ui.click('确认执行'); assert.ok(ui.nodes().some(n => hasClass(n, 'wp-undo-bar')), 'setup should create undo snapshot');
    await chat(ui, [{ op: 'create', title: 'old pending task' }]);
    assert.ok(ui.nodes().some(n => hasClass(n, 'wp-action-card')));
    data(ui); ui.click('覆盖'); const done = ui.import(backup(workspace({ tasks: [task('new', '', 'new workspace task')] }))); await done; await ui.settle();
    assert.ok(!ui.nodes().some(n => hasClass(n, 'wp-undo-bar')), 'old undo must be discarded');
    assert.ok(!ui.nodes().some(n => hasClass(n, 'wp-action-card')), 'old pending changes must be discarded');
    assert.deepEqual(ui.storage.json(KEY.tasks).map(t => t.id), ['new']);
  } finally { ui.close(); }
});

test('workspace replacement invalidates in-flight report generation', async () => {
  const ui = harness(); await ui.settle(); try {
    ui.reports(); ui.scope('pa'); ui.click('重新生成'); const request = ui.nextRequest();
    data(ui); ui.click('覆盖'); const replacement = workspace({ tasks: [task('new')], reports: [report('', 'new workspace body')] });
    const done = ui.import(backup(replacement)); await done; await ui.settle();
    await ui.respond(request, { report: { body: 'OLD request result' } });
    assert.deepEqual(ui.storage.json(KEY.reports).map(r => r.body), ['new workspace body']);
    assert.deepEqual(ui.storage.json(KEY.tasks).map(t => t.id), ['new']);
    assert.deepEqual(ui.storage.json(KEY['report-edits']), {});
  } finally { ui.close(); }
});

test('workspace replacement invalidates in-flight assistant response', async () => {
  const ui = harness(); await ui.settle(); try {
    ui.click('AI 助手'); ui.change('wp-composer-input', '创建旧工作区任务'); ui.click('发送'); const request = ui.nextRequest('chat');
    data(ui); clear(ui); await ui.respond(request, { reply: 'old reply', actions: [{ op: 'create', title: 'stale create' }] });
    assert.ok(!ui.nodes().some(n => hasClass(n, 'wp-action-card')), 'late chat must not recreate pending actions');
    assert.deepEqual(ui.storage.json(KEY.tasks), []);
    assert.ok(!ui.text().includes('old reply'));
  } finally { ui.close(); }
});

test('deferred file.text cannot replace a workspace cleared after file selection', async () => {
  const ui = harness(); await ui.settle(); try {
    data(ui); ui.click('覆盖'); const file = ui.startFile(); clear(ui);
    file.resolve(JSON.stringify(backup(fixture()))); await file.done; await ui.settle();
    assert.deepEqual(storedWorkspace(ui), workspace());
    assert.equal(file.target.value, '');
  } finally { ui.close(); }
});

test('deferred merge file keeps normal task additions made while file.text is pending', async () => {
  const ui = harness(); await ui.settle(); try {
    data(ui); const file = ui.startFile(); ui.click('全部任务'); ui.change('wp-quick-input', 'added while file pending');
    ui.fire(ui.byClass('wp-quick-input'), 'onKeyDown', { key: 'Enter', altKey: true });
    assert.ok(ui.storage.json(KEY.tasks).some(t => t.title === 'added while file pending'));
    file.resolve(JSON.stringify(backup(workspace({ tasks: [task('imported-later')] })))); await file.done; await ui.settle();
    const saved = ui.storage.json(KEY.tasks);
    assert.ok(saved.some(t => t.title === 'added while file pending'), 'ordinary edits must not invalidate or be lost to merge');
    assert.ok(saved.some(t => t.id === 'imported-later')); assert.equal(saved.length, 4);
  } finally { ui.close(); }
});

for (const failedKey of [KEY.transaction, KEY.tasks, KEY.projects, KEY.logs, KEY.artifacts, KEY.reports, KEY['inbox-ack'], KEY['report-edits'], KEY['workspace-extras']]) test('workspace import transaction rolls back failed store ' + failedKey, async () => {
  const ui = harness(); await ui.settle(); try {
    data(ui); ui.click('覆盖'); const before = storedWorkspace(ui);
    ui.storage.fail('set', failedKey);
    const incoming = workspace({ tasks: [task('replacement')], projects: [{ id: 'new-project', name: 'new project' }], logs: [{ id: 'new-log', taskId: 'replacement', text: 'new log', at: NOW }], artifacts: [{ id: 'new-artifact', taskId: 'replacement', summary: 'new', links: [] }], reports: [report('', 'replacement report')], inboxAck: ['new-ack'], reportEdits: { [editKey()]: { body: 'incoming dirty', excluded: [] } } });
    const done = ui.import(backup(incoming)); await done; await ui.settle();
    assert.deepEqual(storedWorkspace(ui), before, 'no partial multi-store replacement');
    assert.equal(ui.storage.getItem(KEY.transaction), null, 'successful rollback clears journal');
    assert.match(ui.text(), /失败|未.*保存|无法/);
    ui.reports(); assert.equal(ui.body(), 'saved-all', 'failed transaction must not publish replacement React state');
  } finally { ui.close(); }
});

test('durable journal recovery restores interrupted transaction before state initialization', async () => {
  const state = fixture(), storage = seedStorage(state);
  const before = [...storage.map].filter(([key]) => Object.values(KEY).includes(key) && key !== KEY.transaction);
  storage.setItem(KEY.transaction, JSON.stringify({ schema: 1, before }));
  storage.setItem(KEY.tasks, JSON.stringify([task('partial')])); storage.setItem(KEY.reports, '[]');
  const ui = harness(state, storage); await ui.settle(); try {
    assert.deepEqual(storedWorkspace(ui), state); assert.equal(storage.getItem(KEY.transaction), null);
    ui.reports(); assert.equal(ui.body(), 'saved-all');
  } finally { ui.close(); }
});

test('report snapshots remain resolvable after source task hard deletion and report re-save', async () => {
  const state = fixture();
  state.tasks[0] = { ...state.tasks[0], status: 'todo', progress: 0, completedAt: null };
  state.logs = [{ id: 'log-a', taskId: 'ta', at: NOW, kind: 'progress', text: 'historical progress' }];
  state.artifacts = [{ id: 'artifact-a', taskId: 'ta', at: NOW, summary: 'historical artifact', links: ['https://example.test/history'] }];
  const ui = harness(state); await ui.settle(); try {
    ui.reports(); ui.scope('pa'); ui.edit('Historical [[task:ta]] [[log:log-a]] [[artifact:artifact-a]]'); ui.click('保存草稿');
    const saved = ui.storage.json(KEY.reports).find(r => r.projectId === 'pa');
    assert.equal(saved.refs.length, 3, 'setup stores three evidence snapshots');
    ui.click('全部任务');
    const row = ui.one(n => hasClass(n, 'wp-row') && text(n).includes('ta'), 'task A row');
    ui.fire(row, 'onClick'); ui.click('移入回收站'); ui.click('删除'); ui.click('回收站'); ui.click('彻底删除'); ui.click('确认删除');
    assert.ok(!ui.storage.json(KEY.tasks).some(t => t.id === 'ta'));
    assert.deepEqual(ui.storage.json(KEY.logs), []); assert.deepEqual(ui.storage.json(KEY.artifacts), []);
    ui.reports(); ui.scope('pa'); ui.edit(ui.body() + '\nEdited after source removal'); ui.click('保存草稿');
    const resaved = ui.storage.json(KEY.reports).find(r => r.projectId === 'pa');
    assert.deepEqual(resaved.refs, saved.refs, 'saving a historical draft must retain cited deleted-source snapshots');
    for (const ref of resaved.refs) assert.ok(ui.debug.resolveFromDraft(resaved, ref.type, ref.id), 'historical ref must resolve: ' + ref.type);
  } finally { ui.close(); }
});

test('actual exported empty schema includes every store and round-trips through replace/undo', async () => {
  const empty = harness(workspace()); await empty.settle(); let exported;
  try {
    data(empty); empty.click('导出备份'); assert.equal(empty.downloads.length, 1);
    exported = JSON.parse(await empty.downloads[0].text());
    assert.equal(exported.app, 'work-panel'); assert.equal(exported.schema, 1);
    for (const key of ['tasks', 'projects', 'logs', 'artifacts', 'reports', 'inboxAck']) assert.deepEqual(exported[key], [], 'empty export field ' + key);
    assert.deepEqual(exported.reportEdits, {});
  } finally { empty.close(); }
  const ui = harness(); await ui.settle(); try {
    data(ui); ui.click('覆盖'); const before = storedWorkspace(ui);
    const done = ui.import(exported); await done; await ui.settle(); assert.deepEqual(storedWorkspace(ui), workspace());
    ui.click('撤销上次导入/清空'); assert.deepEqual(storedWorkspace(ui), before);
  } finally { ui.close(); }
});

test('workspace clear invalidates in-flight batch and prevents later project requests', async () => {
  const ui = harness(); await ui.settle(); try {
    ui.reports(); ui.click('按项目生成'); ui.click('确认生成'); const request = ui.nextRequest();
    data(ui); clear(ui); await ui.respond(request, { report: { body: 'old batch body' } });
    assert.deepEqual(storedWorkspace(ui), workspace());
    assert.equal(ui.requests.filter(r => r.body.mode === 'report').length, 1, 'obsolete batch must not launch project B request');
  } finally { ui.close(); }
});

test('transaction rollback failure remains recoverable after remount', async () => {
  const ui = harness(); await ui.settle(); const storage = ui.storage; const before = storedWorkspace(ui);
  try {
    assert.equal(typeof ui.debug.writeStoredTransaction, 'function', 'Lead should export writeStoredTransaction');
    storage.fail('set', KEY.projects);
    storage.fail('set', KEY.tasks, 1, value => value === JSON.stringify(before.tasks));
    assert.equal(ui.debug.writeStoredTransaction([[KEY.tasks, '[]'], [KEY.projects, '[]']]), false);
    assert.ok(storage.getItem(KEY.transaction), 'rollback journal must survive failed rollback');
    assert.match(ui.debug.storageMessage(), /停止写入|回退|恢复/);
    assert.equal(ui.debug.writeStoredTransaction([[KEY.reports, '[]']]), false, 'blocked runtime cannot continue writing');
  } finally { ui.close(); }
  const restarted = harness(fixture(), storage); await restarted.settle(); try { assert.deepEqual(storedWorkspace(restarted), before); assert.equal(storage.getItem(KEY.transaction), null); } finally { restarted.close(); }
});

test('dirty buffer failed writes remain exportable and retry to durable storage', async () => {
  const ui = harness(); await ui.settle(); try {
    ui.reports(); ui.scope('pa'); ui.storage.fail('set', KEY['report-edits'], Infinity); ui.edit('buffer held through quota fault');
    assert.equal(ui.body(), 'buffer held through quota fault'); assert.ok(ui.dirty());
    assert.match(ui.debug.storageMessage(), /尚未保存|未保存/);
    ui.storage.failures = []; assert.equal(ui.debug.retryStorageWrites(), true);
    assert.equal(ui.storage.json(KEY['report-edits'])[editKey('pa')].body, 'buffer held through quota fault');
    assert.equal(ui.debug.storageMessage(), '');
  } finally { ui.close(); }
});

test('AI confirmation write failure rolls back every task store and retains preview', async () => {
  const ui = harness(); await ui.settle();
  try {
    await chat(ui, [{ op: 'update', taskId: 'ta', patch: { title: 'must-not-partially-commit' } }]);
    const before = plain(storedWorkspace(ui));
    ui.storage.fail('set', KEY.logs);
    ui.click('确认执行');
    assert.deepEqual(plain(storedWorkspace(ui)), before);
    assert.ok(ui.nodes().some(node => hasClass(node, 'wp-action-card')));
    assert.ok(ui.text().includes('变更未生效'));
  } finally { ui.close(); }
});

test('offline task parser still asks before changing task data', async () => {
  const ui = harness(); await ui.settle();
  try {
    ui.click('AI 助手'); ui.change('wp-composer-input', '明天完成离线任务'); ui.click('发送');
    const request = ui.nextRequest('chat');
    const before = plain(storedWorkspace(ui));
    request.respond({}, false); await ui.settle();
    assert.deepEqual(plain(storedWorkspace(ui)), before);
    assert.ok(ui.nodes().some(node => hasClass(node, 'wp-action-card')));
    ui.click('确认执行');
    assert.equal(ui.storage.json(KEY.tasks).length, before.tasks.length + 1);
  } finally { ui.close(); }
});

test('another window change suspends stale writes instead of overwriting its tasks', async () => {
  const ui = harness(); await ui.settle();
  try {
    const external = [task('external')];
    ui.storage.setItem(KEY.tasks, JSON.stringify(external));
    for (const handler of ui.events.get('storage') || []) handler({ key: KEY.tasks });
    ui.runtime.flush();
    assert.ok(ui.text().includes('另一窗口已修改'));
    assert.equal(ui.debug.retryStorageWrites(), false);
    assert.deepEqual(ui.storage.json(KEY.tasks), external);
  } finally { ui.close(); }
});

test('malformed local store is protected and intentional restore keeps original raw bytes', async () => {
  const storage = seedStorage(fixture());
  storage.setItem(KEY.tasks, 'not-json-original');
  const ui = harness(fixture(), storage); await ui.settle();
  try {
    assert.ok(ui.text().includes('本地数据读取失败'));
    data(ui); ui.click('覆盖'); await ui.import(backup(fixture())); await ui.settle();
    assert.deepEqual(ui.storage.json(KEY.tasks), fixture().tasks);
    const raw = ui.storage.json(PREFIX + 'backup:raw-before-restore:v1');
    assert.equal(raw.raw.find(([key]) => key === KEY.tasks)[1], 'not-json-original');
    assert.equal(ui.debug.storageMessage(), '');
  } finally { ui.close(); }
});

for (const selectionChange of ['different paragraph', 'close and reselect']) test('polish response stays owned by original selection: ' + selectionChange, async () => {
  const ui = harness(); await ui.settle();
  try {
    ui.reports(); ui.edit('PARAGRAPH_A\nPARAGRAPH_B'); ui.click('保存草稿'); ui.click('预览');
    const pick = label => ui.fire(ui.one(node => hasClass(node, 'wp-report-line-pick') && text(node) === label), 'onClick');
    pick('PARAGRAPH_A'); ui.click('润色'); const request = ui.nextRequest('polish');
    if (selectionChange === 'different paragraph') pick('PARAGRAPH_B');
    else { ui.fire(ui.byClass('wp-polish-close'), 'onClick'); pick('PARAGRAPH_A'); }
    await ui.respond(request, { polished: 'POLISHED_A', reply: 'old result' });
    assert.ok(!ui.nodes().some(node => hasClass(node, 'wp-polish-result')));
    ui.click('编辑'); assert.equal(ui.body(), 'PARAGRAPH_A\nPARAGRAPH_B');
  } finally { ui.close(); }
});

test('empty report remains editable after clearing and after remount', async () => {
  const ui = harness(); await ui.settle(); let next;
  try {
    ui.reports(); ui.edit(''); assert.equal(ui.body(), '');
    assert.equal(ui.nodes().filter(node => hasClass(node, 'wp-report-editor')).length, 1);
    next = harness(fixture(), ui.storage); await next.settle(); next.reports();
    assert.equal(next.body(), ''); next.edit('typed after empty'); assert.equal(next.body(), 'typed after empty');
  } finally { next?.close(); ui.close(); }
});

test('backup edit buffer validation agrees with startup excluded-id validation', async () => {
  const ui = harness(); await ui.settle();
  try {
    const invalid = backup({ ...fixture(), reportEdits: { [editKey()]: { body: 'text', excluded: [42] } } });
    assert.equal(ui.debug.validateBackup(invalid), 'invalid-record');
    const before = plain(storedWorkspace(ui)); data(ui); ui.click('覆盖'); await ui.import(invalid); await ui.settle();
    assert.deepEqual(plain(storedWorkspace(ui)), before);
    assert.equal(ui.debug.storageMessage(), '');
  } finally { ui.close(); }
});

test('canonical migration initializes only after retaining the old local workspace backup', async () => {
  const ui = harness();
  ui.server.initialized = false; ui.server.revision = 0; ui.server.storeId = null; ui.server.workspace = null;
  try {
    assert.throws(() => ui.change('wp-quick-input', 'must wait for handshake'), /disabled/);
    await ui.settle();
    const posts = ui.server.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1); assert.equal(posts[0].body.action, 'initialize'); assert.equal(posts[0].body.storeId, null);
    assert.deepEqual(ui.server.workspace, fixture());
    const localBackup = ui.storage.json(PREFIX + 'backup:before-host:v1');
    assert.deepEqual(localBackup.backup.tasks, fixture().tasks);
    assert.equal(ui.storage.json(KEY['host-meta']).storeId, ui.server.storeId);
    assert.equal(ui.storage.json(KEY['host-meta']).revision, 1); assert.equal(ui.storage.json(KEY['host-pending']), null);
    assert.ok(!ui.byClass('wp-sync-guard').props.disabled);
  } finally { ui.close(); }
});

test('persisted inflight canonical request resumes on refresh without first hydrating over newer cache', async () => {
  let ui = harness(), next; await ui.settle(); const storage = ui.storage;
  try {
    const gate = deferred(); ui.server.postHook = () => gate.promise;
    ui.change('wp-quick-input', 'queued before refresh'); ui.fire(ui.byClass('wp-quick-input'), 'onKeyDown', { key: 'Enter', altKey: true });
    ui.timers.advance(600); await ui.settle(); const pending = storage.json(KEY['host-pending']); assert.ok(pending);
    assert.equal(pending.action, 'commit'); assert.equal(pending.workspace.tasks[0].title, 'queued before refresh');
    ui.close(); ui.server.postHook = null;
    next = harness(fixture(), storage); await next.settle();
    const posts = next.server.calls.filter(call => call.method === 'POST');
    assert.equal(posts.at(-1).body.requestId, pending.requestId);
    assert.ok(storage.json(KEY.tasks).some(task => task.title === 'queued before refresh'));
    assert.ok(next.server.workspace.tasks.some(task => task.title === 'queued before refresh'));
    assert.equal(storage.json(KEY['host-pending']), null); assert.ok(!next.byClass('wp-sync-guard').props.disabled);
    gate.resolve({ ok: true, json: async () => ({ ok: true, revision: 2, currentRevision: 2, storeId: next.server.storeId }) });
    await next.settle(); assert.ok(storage.json(KEY.tasks).some(task => task.title === 'queued before refresh'));
  } finally { next?.close(); ui.close(); }
});

test('Alt+Enter directly adds exactly once without AI calls or losing edits to an older AI response', async () => {
  const ui = harness(); await ui.settle();
  try {
    const before = ui.storage.json(KEY.tasks).length;
    ui.change('wp-quick-input', 'older AI interpretation'); ui.click('AI 记录');
    const request = ui.nextRequest('chat'); assert.equal(ui.storage.json(KEY.tasks).length, before);
    ui.change('wp-quick-input', 'direct manual new task'); ui.fire(ui.byClass('wp-quick-input'), 'onKeyDown', { key: 'Enter', altKey: true });
    assert.equal(ui.requests.filter(request => request.body.mode === 'chat').length, 1, 'Alt+Enter must not issue another AI request');
    assert.equal(ui.storage.json(KEY.tasks).length, before + 1); assert.equal(ui.storage.json(KEY.tasks)[0].title, 'direct manual new task');
    await ui.respond(request, { reply: 'older response', actions: [{ op: 'create', title: 'old AI proposed task' }] });
    assert.equal(ui.storage.json(KEY.tasks).length, before + 1, 'late AI response remains preview-only');
    assert.equal(ui.storage.json(KEY.tasks)[0].title, 'direct manual new task');
    assert.ok(ui.nodes().some(node => hasClass(node, 'wp-action-card')));
  } finally { ui.close(); }
});

test('canonical hydrate, local edit, backup export and host commit preserve JSON workspace extensions', async () => {
  const extra = { settings: { locale: 'zh', nested: { enabled: true } }, delegations: [{ id: 'delegation-fixture', taskId: 'ta', status: 'prepared' }], customExtension: { items: [1, 'two', null] } };
  const state = fixture(), storage = seedStorage(state), ui = harness(state, storage);
  ui.server.workspace = { ...plain(state), ...plain(extra) };
  try {
    await ui.settle(); assert.deepEqual(storedWorkspace(ui), { ...state, ...extra });
    ui.change('wp-quick-input', 'extension preserving change'); ui.fire(ui.byClass('wp-quick-input'), 'onKeyDown', { key: 'Enter', altKey: true });
    ui.timers.advance(600); await ui.settle();
    for (const key of Object.keys(extra)) assert.deepEqual(ui.server.workspace[key], extra[key], 'canonical extension ' + key);
    data(ui); ui.click('导出备份'); const exported = JSON.parse(await ui.downloads.at(-1).text());
    for (const key of Object.keys(extra)) assert.deepEqual(exported[key], extra[key], 'exported extension ' + key);
  } finally { ui.close(); }
});

async function main() {
  let failed = 0, passed = 0;
  for (const { name, fn } of tests.filter(t => !process.argv[2] || t.name.includes(process.argv[2]))) {
    try { await fn(); console.log('PASS ' + name); passed++; }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`STABILITY: ${passed} passed, ${failed} failed`); if (!passed && !failed) throw new Error('test filter matched nothing');
  if (failed) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { MemoryStorage, FakeTimers, createRuntime, harness, deferred };
