'use strict';
// Shared isolated UI fixture. Never reads browser/profile storage or executes a suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '../../client.js'), 'utf8');
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
            selectionStart: 0, selectionEnd: 0,
            setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
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

module.exports = { PREFIX, KEY, PRE, NOW, PERIOD, editKey, plain, deferred, MemoryStorage, FakeTimers, walk, text, hasClass, createRuntime, task, report, workspace, fixture, seedStorage, harness };
