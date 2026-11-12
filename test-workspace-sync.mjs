import assert from 'node:assert/strict';
import { WorkspaceSync } from './workspace-sync.js';

// All storage, networking, clocks and workspace data are private in-memory fakes.
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const ws = label => ({ tasks: [{ id: label, title: label }], projects: [], logs: [], artifacts: [], reports: [], inboxAck: [], reportEdits: {} });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function rig(options = {}) {
  const state = { local: ws('local'), meta: null, pending: null, localOnly: null, remote: options.meta && !options.meta.dirty ? ws('local') : ws('remote'), revision: 3, initialized: true, storeId: 'store-A', statuses: [], backups: [], calls: [], timers: new Map(), failures: {}, getHook: null, postHook: null, ...clone(options) };
  let seq = 0, id = 0;
  const fault = name => { if (state.failures[name]) { if (Number.isFinite(state.failures[name])) state.failures[name]--; return true; } return false; };
  const history = new Map();
  const deps = {
    readLocal: () => { if (fault('readLocal')) throw new Error('readLocal failure'); return clone(state.local); },
    writeRemote: value => { if (fault('writeRemote')) return false; state.local = clone(value); return true; },
    backup: value => { if (fault('backup')) return false; state.backups.push(clone(value)); return true; },
    validateLocal: value => !!value && Array.isArray(value.tasks),
    readLocalOnly: () => clone(state.localOnly),
    writeLocalOnly: value => { if (fault('writeLocalOnly')) return false; state.localOnly = clone(value); return true; },
    readMeta: () => { if (fault('readMeta')) throw new Error('bad metadata'); return clone(state.meta); },
    writeMeta: value => { if (fault('writeMeta')) return false; state.meta = clone(value); return true; },
    readPending: () => { if (fault('readPending')) throw new Error('bad pending'); return clone(state.pending); },
    writePending: value => { if (fault(value ? 'writePending' : 'clearPending')) return false; state.pending = clone(value); return true; },
    onStatus: value => state.statuses.push(clone(value)), makeId: () => 'request-' + (++id),
    schedule(fn, ms) { assert.equal(ms, 600); const token = ++seq; state.timers.set(token, fn); return token; },
    cancel(token) { state.timers.delete(token); },
    async fetch(url, options = {}) {
      assert.equal(url, '/api/work-panel/workspace', 'real network is forbidden');
      if (!options.method || options.method === 'GET') {
        state.calls.push({ method: 'GET' });
        if (fault('networkGET')) throw new Error('network offline');
        if (state.getHook) return state.getHook();
        return response({ ok: true, initialized: state.initialized, revision: state.initialized ? state.revision : 0, workspace: state.initialized ? clone(state.remote) : null, storeId: state.initialized ? state.storeId : null });
      }
      const body = JSON.parse(options.body); state.calls.push({ method: 'POST', body: clone(body) });
      if (fault('networkPOST')) throw new Error('network offline');
      if (state.postHook) return state.postHook(body);
      if (history.has(body.requestId)) return response({ ok: true, ...history.get(body.requestId), currentRevision: state.revision, duplicate: true });
      if ((body.action === 'initialize' && state.initialized) || (body.action === 'commit' && (!state.initialized || body.baseRevision !== state.revision))) return response({ ok: false, error: 'revision-conflict', currentRevision: state.revision });
      if (body.action === 'initialize') { assert.equal(body.baseRevision, 0); state.initialized = true; state.revision = 0; state.storeId = 'new-store'; }
      else assert.equal(body.action, 'commit');
      state.revision++; state.remote = clone(body.workspace);
      const result = { revision: state.revision, currentRevision: state.revision, storeId: state.storeId }; history.set(body.requestId, result);
      return response({ ok: true, ...result });
    },
  };
  const response = data => ({ ok: true, status: 200, json: async () => clone(data) });
  const api = {
    state, deps, response,
    sync: new WorkspaceSync(deps),
    status: () => state.statuses.at(-1),
    posts: () => state.calls.filter(call => call.method === 'POST').map(call => call.body),
    edit(label) { state.local = ws(label); api.sync.changed(); },
    remount() { api.sync.dispose(); api.sync = new WorkspaceSync(deps); return api.sync; },
    async tick() { const jobs = [...state.timers.values()]; state.timers.clear(); for (const fn of jobs) await fn(); await api.sync.flush(); },
  };
  return api;
}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}' : JSON.stringify(value);
const digest = value => { const json = stable(value); let hash = 2166136261; for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619) >>> 0; return 'v1:' + json.length + ':' + hash.toString(16); };
const known = overrides => ({ revision: 3, storeId: 'store-A', dirty: false, lastSyncedDigest: digest(ws('local')), lastSyncedRecords: 1, ...overrides });

test('fresh cache backs up before hydrating existing canonical workspace', async () => {
  const r = rig(); await r.sync.start();
  assert.deepEqual(r.state.backups, [ws('local')]); assert.deepEqual(r.state.local, ws('remote'));
  assert.deepEqual(r.state.meta, known({ lastSyncedDigest: digest(ws('remote')) })); assert.equal(r.status().phase, 'ready'); assert.equal(r.status().canEdit, true); assert.equal(r.posts().length, 0);
});
test('first migration backs up and initializes using durable stable pending request', async () => {
  const r = rig({ initialized: false, revision: 0, storeId: null });
  r.state.postHook = async body => {
    assert.deepEqual(r.state.pending, body); assert.equal(r.state.backups.length, 1);
    return r.response({ ok: true, revision: 1, currentRevision: 1, storeId: 'new-store' });
  };
  await r.sync.start(); assert.equal(r.posts()[0].action, 'initialize'); assert.equal(r.posts()[0].baseRevision, 0);
  assert.deepEqual(r.posts()[0].workspace, ws('local')); assert.equal(r.state.pending, null); assert.equal(r.state.meta.revision, 1); assert.equal(r.state.meta.storeId, 'new-store');
});
test('600ms changes coalesce into the newest local snapshot', async () => {
  const r = rig({ meta: known() }); await r.sync.start();
  r.edit('one'); r.edit('two'); r.edit('three'); assert.equal(r.posts().length, 0); assert.equal(r.state.timers.size, 1); assert.equal(r.state.meta.dirty, true);
  await r.tick(); assert.equal(r.posts().length, 1); assert.deepEqual(r.posts()[0].workspace, ws('three')); assert.equal(r.posts()[0].baseRevision, 3); assert.equal(r.state.meta.dirty, false);
});
test('inflight pending is immutable; latest cache drains against applied revision', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); r.edit('first');
  const d = deferred(); r.state.postHook = () => d.promise;
  const running = r.sync.flush(); await Promise.resolve(); await Promise.resolve();
  const original = clone(r.state.pending); assert.ok(original); r.edit('second'); assert.deepEqual(r.state.pending, original); assert.equal(r.state.meta.dirty, true);
  r.state.postHook = null; r.state.revision = 4; d.resolve(r.response({ ok: true, revision: 4, currentRevision: 4, storeId: 'store-A' })); await running;
  assert.equal(r.posts().length, 2); assert.equal(r.posts()[1].baseRevision, 4); assert.deepEqual(r.posts()[1].workspace, ws('second')); assert.deepEqual(r.state.remote, ws('second'));
});
test('reload/restart resolves pending before any canonical hydration', async () => {
  const pending = { action: 'commit', baseRevision: 3, requestId: 'durable-id', workspace: ws('inflight'), storeId: 'store-A' };
  const r = rig({ meta: known({ dirty: true }), pending, local: ws('newer') });
  let post = 0;
  r.state.postHook = async body => { post++; if (post === 1) { assert.deepEqual(body, pending); assert.deepEqual(r.state.local, ws('newer')); return r.response({ ok: true, revision: 4, currentRevision: 4, storeId: 'store-A' }); } return r.response({ ok: true, revision: 5, currentRevision: 5, storeId: 'store-A' }); };
  await r.sync.start(); assert.equal(r.posts().length, 2); assert.equal(r.posts()[1].baseRevision, 4); assert.deepEqual(r.posts()[1].workspace, ws('newer')); assert.deepEqual(r.state.local, ws('newer'));
});
test('restart detects cache newer than pending even if dirty metadata was not updated', async () => {
  const pending = { action: 'commit', baseRevision: 3, requestId: 'durable-id', workspace: ws('inflight'), storeId: 'store-A' };
  const r = rig({ meta: known(), pending, local: ws('crash-window-edit') });
  let count = 0; r.state.postHook = async () => r.response({ ok: true, revision: ++count + 3, currentRevision: count + 3, storeId: 'store-A' });
  await r.sync.start(); assert.equal(r.posts().length, 2); assert.deepEqual(r.posts()[1].workspace, ws('crash-window-edit'));
});
test('uncertain POST network failure retries the exact requestId on explicit retry', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); r.edit('edited'); r.state.failures.networkPOST = 1;
  await r.sync.flush(); const pending = clone(r.state.pending); assert.equal(r.status().phase, 'offline'); assert.equal(r.status().canEdit, true);
  await r.sync.retry(); assert.equal(r.posts()[1].requestId, pending.requestId); assert.equal(r.state.pending, null); assert.equal(r.status().phase, 'ready');
});
test('first handshake failure retains a backup, then enables clearly unsynced local-only editing', async () => {
  const r = rig({ failures: { networkGET: 1 } }); await r.sync.start(); assert.equal(r.status().phase, 'local'); assert.equal(r.status().canEdit, true); assert.equal(r.posts().length, 0); assert.equal(r.state.backups.length, 1); assert.deepEqual(r.state.local, ws('local'));
  r.edit('new local task'); await r.sync.flush(); assert.equal(r.posts().length, 0);
  r.remount(); await r.sync.start(); assert.equal(r.status().phase, 'local'); assert.deepEqual(r.state.local, ws('new local task')); assert.equal(r.posts().length, 0);
  await r.sync.retry(); assert.equal(r.posts().length, 0);
  await r.sync.reload(); assert.equal(r.status().phase, 'ready'); assert.equal(r.state.localOnly, null); assert.deepEqual(r.state.local, ws('remote')); assert.deepEqual(r.state.backups.at(-1), ws('new local task'));
});
test('corrupt local-only marker blocks both editing and migration without overwriting browser data', async () => {
  const r = rig({ localOnly: { version: 99, startedAt: 'unknown' } }); await r.sync.start();
  assert.equal(r.status().phase, 'error'); assert.equal(r.status().canEdit, false); assert.equal(r.state.calls.length, 0);
  assert.deepEqual(r.state.local, ws('local'));
});
test('first handshake failure with no durable local-mode marker remains read-only', async () => {
  const r = rig({ failures: { networkGET: 1, writeLocalOnly: 1 } }); await r.sync.start();
  assert.equal(r.status().canEdit, false); assert.equal(r.state.localOnly, null); assert.equal(r.posts().length, 0);
});
test('an emptied browser cache never auto-commits over a non-empty canonical baseline', async () => {
  const empty = ws('local'); empty.tasks = [];
  const r = rig({ meta: known({ lastSyncedRecords: 3 }), local: empty });
  await r.sync.start();
  assert.equal(r.status().phase, 'conflict'); assert.equal(r.status().canEdit, false);
  assert.equal(r.posts().length, 0); assert.deepEqual(r.state.local.tasks, []);
  assert.deepEqual(r.state.remote, ws('local'), 'canonical data must be untouched');
});
test('a cache with records still commits after intentional deletions', async () => {
  const fewer = ws('local'); fewer.tasks = [{ id: 'kept', title: 'kept' }];
  const r = rig({ meta: known({ lastSyncedRecords: 3 }), local: fewer }); await r.sync.start();
  assert.equal(r.status().phase, 'ready'); assert.deepEqual(r.state.remote.tasks.map(t => t.id), ['kept']);
});
test('known cache with retryable Host storage-load error stays editable and queues changes', async () => {
  const r = rig({ meta: known() });
  r.state.getHook = () => r.response({ ok: false, error: 'workspace-load-failed', retryable: true });
  await r.sync.start(); assert.equal(r.status().phase, 'offline'); assert.equal(r.status().canEdit, true);
  r.edit('saved despite backend error'); assert.equal(r.state.meta.dirty, true); assert.equal(r.posts().length, 0);
  r.state.getHook = null; await r.sync.retry(); assert.deepEqual(r.state.remote, ws('saved despite backend error')); assert.equal(r.status().phase, 'ready');
});
test('known offline workspace remains editable and queues dirty without automatic network retries', async () => {
  const r = rig({ meta: known(), failures: { networkGET: 1 } }); await r.sync.start(); assert.equal(r.status().canEdit, true); r.edit('offline newer'); assert.equal(r.state.meta.dirty, true); assert.equal(r.state.timers.size, 0);
  await r.sync.retry(); assert.deepEqual(r.posts()[0].workspace, ws('offline newer'));
});
for (const remote of [{ initialized: false, revision: 0, storeId: null }, { initialized: true, revision: 3, storeId: 'other-store' }]) test('existing bound cache refuses missing or different canonical store ' + JSON.stringify(remote), async () => {
  const r = rig({ meta: known(), ...remote }); await r.sync.start(); assert.equal(r.status().phase, 'conflict'); assert.equal(r.status().canEdit, false); assert.equal(r.posts().length, 0); assert.deepEqual(r.state.local, ws('local'));
});
test('dirty known cache with advanced server revision conflicts without overwriting local', async () => {
  const r = rig({ meta: known({ dirty: true }), revision: 9 }); await r.sync.start(); assert.equal(r.status().phase, 'conflict'); assert.equal(r.posts().length, 0); assert.deepEqual(r.state.local, ws('local'));
  r.edit('still retain this'); assert.equal(r.state.timers.size, 0); await r.sync.retry(); assert.equal(r.posts().length, 0);
});
test('CAS conflict preserves cache and pending and never automatically retries', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); r.edit('local conflict'); r.state.postHook = async () => r.response({ ok: false, error: 'revision-conflict', currentRevision: 8 });
  await r.sync.flush(); assert.equal(r.status().phase, 'conflict'); assert.ok(r.state.pending); assert.deepEqual(r.state.local, ws('local conflict')); await r.sync.retry(); assert.equal(r.posts().length, 1);
});
test('old duplicate applied revision never jumps base to current server revision', async () => {
  const pending = { action: 'commit', baseRevision: 2, requestId: 'old-duplicate', workspace: ws('old'), storeId: 'store-A' };
  const r = rig({ meta: known({ revision: 2, dirty: true }), pending, revision: 8, local: ws('newer') });
  r.state.postHook = async () => r.response({ ok: true, duplicate: true, revision: 3, currentRevision: 8, storeId: 'store-A' });
  await r.sync.start(); assert.equal(r.status().phase, 'conflict'); assert.equal(r.posts().length, 1); assert.notEqual(r.state.meta.revision, 8); assert.deepEqual(r.state.local, ws('newer'));
});
test('POST storeId mismatch is a conflict rather than accepting replacement canonical store', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); r.edit('local'); r.state.postHook = async () => r.response({ ok: true, revision: 4, currentRevision: 4, storeId: 'replaced' }); await r.sync.flush(); assert.equal(r.status().phase, 'conflict'); assert.equal(r.state.meta.storeId, 'store-A');
});
test('explicit reload requires backup then safely replaces cache and clears obsolete pending', async () => {
  const pending = { action: 'commit', baseRevision: 1, requestId: 'stale', workspace: ws('old'), storeId: 'store-A' };
  const r = rig({ meta: known({ dirty: true }), pending, storeId: 'new-master', revision: 10 }); await r.sync.start(); assert.equal(r.status().phase, 'conflict');
  await r.sync.reload(); assert.deepEqual(r.state.backups.at(-1), ws('local')); assert.deepEqual(r.state.local, ws('remote')); assert.equal(r.state.pending, null); assert.deepEqual(r.state.meta, known({ revision: 10, storeId: 'new-master', lastSyncedDigest: digest(ws('remote')) })); assert.equal(r.status().phase, 'ready');
});
test('explicit reload never initializes missing master from an already bound cache', async () => {
  const r = rig({ meta: known(), initialized: false, revision: 0, storeId: null }); await r.sync.start(); await r.sync.reload(); assert.equal(r.posts().length, 0); assert.deepEqual(r.state.local, ws('local')); assert.equal(r.status().canEdit, false);
});
for (const failure of ['backup', 'writeRemote', 'writeMeta']) test('fresh hydrate ' + failure + ' failure is explicit error and blocks editing', async () => {
  const r = rig({ failures: { [failure]: 1 } }); await r.sync.start(); assert.equal(r.status().phase, 'error'); assert.equal(r.status().canEdit, false); assert.equal(r.posts().length, 0);
});
for (const failure of ['backup', 'writePending', 'writeMeta']) test('initialization ' + failure + ' failure blocks network POST', async () => {
  const r = rig({ initialized: false, revision: 0, storeId: null, failures: { [failure]: 1 } }); await r.sync.start(); assert.equal(r.status().phase, 'error'); assert.equal(r.posts().length, 0); assert.deepEqual(r.state.local, ws('local'));
});
for (const failure of ['readMeta', 'readPending', 'readLocal']) test('storage read failure ' + failure + ' must not become empty/fresh migration', async () => {
  const r = rig({ initialized: false, revision: 0, storeId: null, failures: { [failure]: 1 } }); await r.sync.start(); assert.equal(r.status().phase, 'error'); assert.equal(r.posts().length, 0);
});
for (const field of ['meta', 'pending']) test('malformed ' + field + ' fails closed', async () => {
  const r = rig({ [field]: { nonsense: true } }); await r.sync.start(); assert.equal(r.status().phase, 'error'); assert.equal(r.posts().length, 0);
});
test('writePending failure before commit prevents POST and retains dirty cache', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); r.edit('new'); r.state.failures.writePending = 1; await r.sync.flush(); assert.equal(r.status().phase, 'error'); assert.equal(r.posts().length, 0); assert.equal(r.state.meta.dirty, true);
});
test('changed metadata write failure keeps in-memory dirty for explicit retry', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); r.state.failures.writeMeta = 1; r.edit('must survive retry'); assert.equal(r.status().phase, 'error'); assert.equal(r.posts().length, 0); await r.sync.retry(); assert.deepEqual(r.state.local, ws('must survive retry')); assert.deepEqual(r.posts()[0].workspace, ws('must survive retry'));
});
for (const failure of ['writeMeta', 'clearPending']) test('ack persistence failure ' + failure + ' preserves stable pending', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); r.edit('new');
  r.state.postHook = async () => { r.state.failures[failure] = 1; return r.response({ ok: true, revision: 4, currentRevision: 4, storeId: 'store-A' }); };
  await r.sync.flush(); assert.equal(r.status().phase, 'error'); assert.ok(r.state.pending); assert.equal(r.posts().length, 1);
});
test('reload backup failure preserves dirty cache and pending', async () => {
  const r = rig({ meta: known({ dirty: true }), revision: 10 }); await r.sync.start(); r.state.failures.backup = 1; await r.sync.reload(); assert.equal(r.status().phase, 'error'); assert.deepEqual(r.state.local, ws('local'));
});
test('dispose cancels debounce and ignores late asynchronous responses', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); r.edit('new'); const d = deferred(); r.state.postHook = () => d.promise;
  const flushing = r.sync.flush(); await Promise.resolve(); await Promise.resolve(); const count = r.state.statuses.length; const pending = clone(r.state.pending); r.sync.dispose();
  d.resolve(r.response({ ok: true, revision: 4, currentRevision: 4, storeId: 'store-A' })); await flushing;
  assert.equal(r.state.statuses.length, count); assert.deepEqual(r.state.pending, pending); assert.equal(r.state.timers.size, 0);
});
test('multiple start calls share one handshake', async () => {
  const r = rig(); const d = deferred(); r.state.getHook = () => d.promise; const first = r.sync.start(); const second = r.sync.start(); await Promise.resolve(); assert.equal(r.state.calls.length, 1); d.resolve(r.response({ ok: true, initialized: true, revision: 3, storeId: 'store-A', workspace: ws('remote') })); await Promise.all([first, second]); assert.equal(r.state.calls.length, 1);
});
test('malformed server JSON does not imply missing canonical workspace', async () => {
  const r = rig(); r.state.getHook = async () => r.response({ ok: true }); await r.sync.start(); assert.equal(r.status().phase, 'error'); assert.equal(r.posts().length, 0); assert.deepEqual(r.state.local, ws('local'));
});

test('unmarked cache mutation with no pending commits rather than hydrating over it', async () => {
  const r = rig({ meta: known(), local: ws('writeLocal-before-changed-crash') });
  await r.sync.start(); assert.equal(r.posts().length, 1); assert.deepEqual(r.posts()[0].workspace, ws('writeLocal-before-changed-crash')); assert.deepEqual(r.state.local, ws('writeLocal-before-changed-crash')); assert.equal(r.status().phase, 'ready');
});
test('unmarked cache mutation plus advanced canonical revision conflicts without losing cache', async () => {
  const r = rig({ meta: known(), revision: 4, local: ws('unmarked mutation') }); await r.sync.start();
  assert.equal(r.status().phase, 'conflict'); assert.equal(r.posts().length, 0); assert.deepEqual(r.state.local, ws('unmarked mutation')); assert.equal(r.state.meta.dirty, true);
});
test('legacy metadata without digest is upgraded only from an exactly matching baseline', async () => {
  const r = rig({ meta: { revision: 3, storeId: 'store-A', dirty: false }, local: ws('remote'), remote: ws('remote') }); await r.sync.start(); assert.equal(r.status().phase, 'ready'); assert.equal(r.state.meta.lastSyncedDigest, digest(ws('remote')));
  const bad = rig({ meta: { revision: 3, storeId: 'store-A', dirty: false }, remote: ws('remote') }); await bad.sync.start(); assert.equal(bad.status().phase, 'conflict'); assert.deepEqual(bad.state.local, ws('local'));
});
test('uncertain initialize restart replays null-storeId pending even after server acquired identity', async () => {
  const r = rig({ initialized: false, revision: 0, storeId: null });
  r.state.postHook = async () => { r.state.initialized = true; r.state.revision = 1; r.state.storeId = 'new-store'; r.state.remote = ws('local'); throw new Error('reply lost after commit'); };
  await r.sync.start(); assert.equal(r.status().phase, 'offline'); assert.equal(r.status().canEdit, false);
  const original = clone(r.state.pending); assert.equal(original.action, 'initialize'); assert.equal(original.storeId, null);
  r.state.postHook = async body => { assert.deepEqual(body, original); return r.response({ ok: true, duplicate: true, revision: 1, currentRevision: 1, storeId: 'new-store' }); };
  r.remount(); await r.sync.start(); assert.equal(r.status().phase, 'ready'); assert.equal(r.state.pending, null); assert.equal(r.state.meta.storeId, 'new-store'); assert.equal(r.state.backups.length, 1);
});
test('pending creation crash before any metadata still replays existing request rather than creating new id', async () => {
  const pending = { action: 'initialize', baseRevision: 0, requestId: 'persisted-before-meta', workspace: ws('local'), storeId: null };
  const r = rig({ meta: null, pending, initialized: true, revision: 1, storeId: 'new-store', remote: ws('local') });
  r.state.postHook = async body => { assert.deepEqual(body, pending); return r.response({ ok: true, revision: 1, currentRevision: 1, storeId: 'new-store', duplicate: true }); };
  await r.sync.start(); assert.equal(r.posts().length, 1); assert.equal(r.state.backups.length, 0); assert.equal(r.status().phase, 'ready');
});
test('GET missing storage identity cannot be interpreted as an empty initialized store', async () => {
  const r = rig(); r.state.getHook = async () => r.response({ ok: true, initialized: false, revision: 0, workspace: null }); await r.sync.start(); assert.equal(r.status().phase, 'error'); assert.equal(r.posts().length, 0);
});
test('malformed applied revision does not clear durable pending', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); r.edit('new');
  r.state.postHook = async () => r.response({ ok: true, revision: 8, currentRevision: 8, storeId: 'store-A' }); await r.sync.flush(); assert.equal(r.status().phase, 'error'); assert.ok(r.state.pending); assert.equal(r.state.meta.revision, 3);
});
test('explicit reload detects newer page edits made during its GET instead of overwriting', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); const d = deferred(); r.state.getHook = () => d.promise;
  const run = r.sync.reload(); await Promise.resolve(); r.edit('edit during reload');
  d.resolve(r.response({ ok: true, initialized: true, revision: 4, storeId: 'store-A', workspace: ws('canonical newer') })); await run;
  assert.equal(r.status().phase, 'conflict'); assert.deepEqual(r.state.local, ws('edit during reload')); assert.equal(r.state.backups.length, 0);
});
test('canonical key ordering prevents false dirty commits', async () => {
  const local = ws('local'); const reverse = Object.fromEntries(Object.entries(local).reverse());
  const r = rig({ meta: known(), local: reverse }); await r.sync.start(); assert.equal(r.posts().length, 0); assert.equal(r.status().phase, 'ready');
});
test('public async methods return actionable latest statuses and flush never reports offline as ready', async () => {
  const r = rig({ meta: known() }); const started = await r.sync.start(); assert.equal(started.phase, 'ready');
  r.edit('new'); r.state.failures.networkPOST = 1; const flushed = await r.sync.flush(); assert.equal(flushed.phase, 'offline'); assert.equal(flushed.canEdit, true); assert.ok(r.state.pending);
  const retried = await r.sync.retry(); assert.equal(retried.phase, 'ready'); assert.deepEqual(retried, r.sync.getStatus());
});
test('retry cannot bypass a still-failing initial metadata write by replaying pending', async () => {
  const r = rig({ initialized: false, revision: 0, storeId: null, failures: { writeMeta: Infinity } });
  // JSON fixtures cannot encode Infinity, so install the persistent fault directly.
  r.state.failures.writeMeta = Infinity;
  await r.sync.start(); assert.ok(r.state.pending); assert.equal(r.posts().length, 0);
  await r.sync.retry(); assert.equal(r.posts().length, 0); assert.equal(r.status().phase, 'error');
  r.state.failures.writeMeta = 0; await r.sync.retry(); assert.equal(r.posts().length, 1); assert.equal(r.status().phase, 'ready');
});
test('failure to clear pending after explicit reload does not masquerade as ready', async () => {
  const r = rig({ meta: known({ dirty: true }), revision: 8 }); await r.sync.start(); r.state.failures.clearPending = 1;
  const status = await r.sync.reload(); assert.equal(status.phase, 'error'); assert.equal(status.canEdit, false);
});

test('clean same-version start and repeated focus retries never hydrate or invalidate caller editor state', async () => {
  const r = rig({ meta: known() }); let hydrations = 0;
  const writeRemote = r.deps.writeRemote; r.deps.writeRemote = value => { hydrations++; return writeRemote(value); };
  assert.equal((await r.sync.start()).phase, 'ready');
  assert.equal((await r.sync.retry()).phase, 'ready');
  assert.equal((await r.sync.retry()).phase, 'ready');
  assert.equal(hydrations, 0); assert.equal(r.posts().length, 0); assert.deepEqual(r.state.local, ws('local'));
});
test('same-version different canonical contents conflict instead of silently hydrating', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); let hydrations = 0;
  r.deps.writeRemote = () => { hydrations++; return true; }; r.state.remote = ws('illegal same-version replacement');
  const status = await r.sync.retry(); assert.equal(status.phase, 'conflict'); assert.equal(hydrations, 0); assert.deepEqual(r.state.local, ws('local')); assert.equal(r.state.meta.revision, 3);
});
test('newer canonical revision still hydrates once, later equal-version focus does not', async () => {
  const r = rig({ meta: known() }); let hydrations = 0;
  const writeRemote = r.deps.writeRemote; r.deps.writeRemote = value => { hydrations++; return writeRemote(value); };
  await r.sync.start(); r.state.revision = 4; r.state.remote = ws('canonical newer');
  assert.equal((await r.sync.retry()).phase, 'ready'); assert.equal(hydrations, 1); assert.deepEqual(r.state.local, ws('canonical newer'));
  await r.sync.retry(); assert.equal(hydrations, 1); assert.equal(r.state.meta.revision, 4);
});
test('explicit equal-version reload still backs up and hydrates by user intent', async () => {
  const r = rig({ meta: known() }); await r.sync.start(); let hydrations = 0;
  const writeRemote = r.deps.writeRemote; r.deps.writeRemote = value => { hydrations++; return writeRemote(value); };
  const status = await r.sync.reload(); assert.equal(status.phase, 'ready'); assert.equal(hydrations, 1); assert.deepEqual(r.state.backups, [ws('local')]);
});

let passed = 0, failed = 0;
for (const { name, fn } of tests.filter(test => !process.argv[2] || test.name.includes(process.argv[2]))) {
  try { await fn(); console.log('PASS ' + name); passed++; } catch (error) { console.error('FAIL ' + name + '\n' + error.stack); failed++; }
}
console.log(`WORKSPACE SYNC: ${passed} passed, ${failed} failed`);
if (failed || !passed) process.exitCode = 1;
