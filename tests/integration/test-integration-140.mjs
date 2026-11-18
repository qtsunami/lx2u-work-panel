// End-to-end (minus the browser) integration: the real Host plugin routes write a
// real single-layout JSON unit on disk using the Host's own unit-name grammar, and
// the shipped WorkspaceSync class drives migration, commits and restart recovery
// through that HTTP contract. Everything runs in a private temporary directory.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../../src/host/index.js';
import { WorkspaceSync } from '../../src/shared/workspace-sync.js';

const UNIT_RE = /^[a-z][a-z0-9_]*$/;
const now = () => new Date().toISOString();
const task = (id, title, status = 'todo') => ({ id, title, status, urgency: 'medium', deadline: '', nextStep: '', blockedReason: '', createdAt: now(), updatedAt: now() });
const workspace = (tasks) => ({ tasks, projects: [], logs: [], artifacts: [], reports: [], inboxAck: [], reportEdits: {} });

function diskBackend(root) {
  return {
    root,
    kv: { open: async (descriptor) => {
      if (!UNIT_RE.test(descriptor.name)) {
        const error = new Error(`invalid unit name '${descriptor.name}'`);
        error.code = 'malformed-medium';
        throw error;
      }
      const file = join(root, descriptor.name + '.json');
      let closed = false;
      const read = async () => {
        let text;
        try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
        const document = JSON.parse(text);
        if (document.unit?.name !== descriptor.name || document.unit?.version !== descriptor.version) {
          const error = new Error('foreign header');
          error.code = 'malformed-medium';
          throw error;
        }
        return document.global;
      };
      const assertOpen = () => { if (closed) { const error = new Error('closed'); error.code = 'closed'; throw error; } };
      return {
        loadAll: async () => { assertOpen(); return { tables: {}, global: (await read()) ?? null }; },
        setGlobal: async (value) => {
          assertOpen();
          const temp = file + '.tmp';
          await readFile(file, 'utf8').catch(() => '');
          const { writeFile, rename } = await import('node:fs/promises');
          await writeFile(temp, JSON.stringify({ unit: { name: descriptor.name, version: descriptor.version }, global: value, tables: {} }, null, 2) + '\n');
          await rename(temp, file);
        },
        close: async () => { closed = true; },
      };
    } },
  };
}

function makeCtx(backend, routes) {
  const storage = { backend: { names: () => ['json'], get: (name) => (name === 'json' ? backend : undefined) } };
  const disposers = [];
  return {
    dispose: async () => { for (const dispose of disposers.reverse()) await dispose(); },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    get: (name) => {
      if (name === 'storage') return storage;
      if (name === 'llm') return { stream: async function* () { yield { type: 'text-delta', text: '{}' }; } };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      if (name === 'tools') return { register: () => () => {} };
      return undefined;
    },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
}

const request = (options = {}) => ({ method: options.method || 'GET', json: async () => JSON.parse(options.body) });

function rig(root, routes) {
  const state = { cache: workspace([task('t-1', '迁移前浏览器任务')]), meta: null, pending: null, backups: [], statuses: [] };
  const sync = new WorkspaceSync({
    fetch: async (url, options) => {
      const route = routes.get(url);
      assert.ok(route, 'unexpected endpoint ' + url);
      return route.fetch(request(options));
    },
    readLocal: () => JSON.parse(JSON.stringify(state.cache)),
    writeRemote: (next) => { state.cache = JSON.parse(JSON.stringify(next)); return true; },
    backup: (local) => { state.backups.push(local); return true; },
    readMeta: () => (state.meta ? JSON.parse(JSON.stringify(state.meta)) : null),
    writeMeta: (value) => { state.meta = value ? JSON.parse(JSON.stringify(value)) : null; return true; },
    readPending: () => (state.pending ? JSON.parse(JSON.stringify(state.pending)) : null),
    writePending: (value) => { state.pending = value ? JSON.parse(JSON.stringify(value)) : null; return true; },
    validateLocal: () => true,
    makeId: () => `w${++rigSeq}-request-${++state.ids}`,
    schedule: (fn) => { state.timer = fn; return 1; },
    cancel: () => { state.timer = null; },
    onStatus: (status) => state.statuses.push(status),
  });
  state.ids = 0;
  state.seq = rigSeq;
  state.status = () => state.statuses.at(-1);
  return { state, sync };
}

const tests = [];
let rigSeq = 0;
const test = (name, run) => tests.push({ name, run });

test('fresh Host migrates the browser workspace into a legal on-disk unit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wp-e2e-'));
  const routes = new Map();
  const ctx = makeCtx(diskBackend(root), routes);
  apply(ctx, { inboxBackend: 'json' });
  try {
    const r = rig(root, routes);
    await r.sync.start();
    assert.equal(r.state.status().phase, 'ready');
    assert.equal(r.state.status().canEdit, true);
    assert.equal(r.state.backups.length, 1, 'migration must keep a browser backup first');
    assert.deepEqual(await readdir(root), ['work_panel_workspace.json']);
    const document = JSON.parse(await readFile(join(root, 'work_panel_workspace.json'), 'utf8'));
    assert.equal(document.unit.name, 'work_panel_workspace');
    assert.equal(document.unit.version, 1);
    assert.equal(document.global.revision, 1);
    assert.equal(document.global.workspace.tasks[0].title, '迁移前浏览器任务');
    assert.ok(document.global.storeId);
    assert.equal(document.global.migrationBackup.workspace.tasks[0].title, '迁移前浏览器任务');
  } finally { await ctx.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('subsequent edits commit a new revision and survive a simulated restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wp-e2e-'));
  const routes = new Map();
  const ctx = makeCtx(diskBackend(root), routes);
  apply(ctx, { inboxBackend: 'json' });
  try {
    const first = rig(root, routes);
    await first.sync.start();
    first.state.cache = workspace([task('t-1', '完成后的任务', 'done')]);
    first.sync.changed();
    await first.sync.flush();
    assert.equal(first.state.status().phase, 'ready');
    let document = JSON.parse(await readFile(join(root, 'work_panel_workspace.json'), 'utf8'));
    assert.equal(document.global.revision, 2);
    assert.equal(document.global.workspace.tasks[0].status, 'done');
    assert.equal(document.global.migrationBackup.workspace.tasks[0].status, 'todo', 'the original migration snapshot must not be rewritten');

    // Same browser storage, new page mount: metadata already matches the Host.
    const restarted = rig(root, routes);
    restarted.state.cache = first.state.cache;
    restarted.state.meta = first.state.meta;
    await restarted.sync.start();
    assert.equal(restarted.state.status().phase, 'ready');
    assert.equal(restarted.state.meta.revision, 2);
    assert.deepEqual(restarted.state.cache.tasks.map((t) => t.id), ['t-1']);
    document = JSON.parse(await readFile(join(root, 'work_panel_workspace.json'), 'utf8'));
    assert.equal(document.global.revision, 2, 'a clean restart must not write');
  } finally { await ctx.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('stale canonical revision from another window is never overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wp-e2e-'));
  const routes = new Map();
  const ctx = makeCtx(diskBackend(root), routes);
  apply(ctx, { inboxBackend: 'json' });
  try {
    const a = rig(root, routes); await a.sync.start();
    const b = rig(root, routes);
    b.state.cache = workspace([task('t-b', '另一个窗口的副本')]);
    b.state.meta = { ...a.state.meta };
    // B commits first from the same base; A must then fail closed.
    await b.sync.start();
    a.state.cache = workspace([task('t-a', '本窗口的修改')]);
    a.sync.changed();
    await a.sync.flush();
    assert.equal(a.state.status().phase, 'conflict');
    assert.equal(a.state.meta.revision, 1, 'a rejected writer must not advance its base revision');
    assert.equal(b.state.meta.revision, 2);
    const document = JSON.parse(await readFile(join(root, 'work_panel_workspace.json'), 'utf8'));
    assert.equal(document.global.workspace.tasks[0].id, 't-b');
  } finally { await ctx.dispose(); await rm(root, { recursive: true, force: true }); }
});

let failed = 0;
for (const { name, run } of tests) {
  try { await run(); console.log('PASS ' + name); }
  catch (error) { failed += 1; console.error('FAIL ' + name + '\n' + (error && error.stack)); }
}
console.log(`INTEGRATION 1.4: ${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
