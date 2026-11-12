import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceStore, WORKSPACE_DESCRIPTOR, validateWorkspace, workspaceContext, workspaceFailure } from './workspace-store.js';

const copy = (value) => structuredClone(value);
const empty = () => ({ tasks: [], projects: [], logs: [], artifacts: [], reports: [], inboxAck: [], reportEdits: {} });
const task = (id, extra = {}) => ({ id, title: '任务' + id, status: 'todo', projectId: '', expected: '通过测试', ...extra });
const workspace = (tasks = [task('t-1')]) => ({ ...empty(), tasks });
const initialize = (value = workspace(), requestId = 'initialize') => ({ action: 'initialize', baseRevision: 0, requestId, workspace: value, storeId: null });
const commit = (storeId, baseRevision, value = workspace(), requestId = 'commit-' + baseRevision) => ({ action: 'commit', baseRevision, requestId, workspace: value, storeId });
function mockStorage(initial = null) {
  const state = { disk: copy(initial), opens: 0, closes: 0, writes: 0, active: 0, maxActive: 0, failures: [], closeFailures: 0, beforeWrite: null };
  const backend = { kv: { open: async (descriptor) => {
    assert.deepEqual(descriptor, WORKSPACE_DESCRIPTOR);
    state.opens += 1;
    let memory = copy(state.disk);
    let closed = false;
    return {
      loadAll: async () => { assert.equal(closed, false); return { tables: {}, global: copy(memory) }; },
      setGlobal: async (value) => {
        assert.equal(closed, false);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        try {
          memory = copy(value);
          state.writes += 1;
          if (state.beforeWrite) await state.beforeWrite();
          const fail = state.failures.shift();
          if (fail === 'before') throw new Error('write failed before publication');
          state.disk = copy(value);
          if (fail === 'after') throw new Error('write failed after publication');
        } finally { state.active -= 1; }
      },
      close: async () => {
        if (state.closeFailures > 0) { state.closeFailures -= 1; throw new Error('close failed'); }
        closed = true; state.closes += 1;
      },
    };
  } } };
  return { state, backend, storage: { backend: { names: () => ['json'], get: (name) => name === 'json' ? backend : undefined } } };
}
const makeStore = (mock, options) => new WorkspaceStore(() => mock.storage, options);
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

// Every assertion observes the public operation or mock durable medium, never internal mutable state.
test('uninitialized GET is explicit null and does not create a unit document', async () => {
  const mock = mockStorage();
  const store = makeStore(mock);
  assert.deepEqual(await store.get(), { ok: true, initialized: false, revision: 0, workspace: null, updatedAt: null, storeId: null });
  assert.equal(mock.state.writes, 0);
  await store.close();
});

test('initialize atomically preserves original JSON, extension fields, migration backup, identity and receipt', async () => {
  const mock = mockStorage();
  const store = makeStore(mock);
  const value = workspace();
  value.tasks[0].custom = { nested: [null, 3, { kept: true }] };
  value.settings = { layout: 'compact' };
  value.delegations = [{ taskId: 't-1', sourceSessionId: 'session-1' }];
  value.future = JSON.parse('{"__proto__":{"safe":true},"nested":[1,2]}');
  const result = await store.write(initialize(value));
  assert.equal(result.revision, 1);
  assert.equal(result.currentRevision, 1);
  assert.equal(typeof result.storeId, 'string');
  assert.deepEqual(mock.state.disk.workspace, value);
  assert.deepEqual(mock.state.disk.migrationBackup, { workspace: value, at: result.updatedAt });
  assert.equal(mock.state.disk.storeId, result.storeId);
  assert.equal(mock.state.disk.receipts[0].requestId, 'initialize');
  assert.equal(mock.state.writes, 1);
  const updated = workspace([task('t-2')]);
  await store.write(commit(result.storeId, 1, updated));
  assert.deepEqual(mock.state.disk.migrationBackup.workspace, value);
  assert.equal((await store.get()).storeId, result.storeId);
  await store.close();
  const restarted = makeStore(mock);
  assert.deepEqual((await restarted.get()).workspace, updated);
  assert.equal((await restarted.get()).storeId, result.storeId);
  await restarted.close();
});

test('two competing initialize/commit calls admit exactly one CAS winner without replacing the first migration backup', async () => {
  const mock = mockStorage();
  const store = makeStore(mock);
  const init = await Promise.allSettled([store.write(initialize(workspace([task('first')]), 'init-a')), store.write(initialize(workspace([task('second')]), 'init-b'))]);
  assert.deepEqual(init.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.equal(init[1].reason.code, 'revision-conflict');
  assert.equal(init[1].reason.details.currentRevision, 1);
  const storeId = init[0].value.storeId;
  const updates = await Promise.allSettled([store.write(commit(storeId, 1, workspace([task('third')]), 'a')), store.write(commit(storeId, 1, workspace([task('fourth')]), 'b'))]);
  assert.deepEqual(updates.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.equal(updates[1].reason.details.currentRevision, 2);
  assert.equal((await store.get()).workspace.tasks[0].id, 'third');
  assert.equal(mock.state.disk.migrationBackup.workspace.tasks[0].id, 'first');
  assert.equal(mock.state.maxActive, 1);
  await store.close();
});

test('stable request retry returns applied and current revision separately, never overwrites a later commit', async () => {
  const mock = mockStorage();
  let store = makeStore(mock);
  const first = await store.write(initialize());
  const original = commit(first.storeId, 1, workspace([task('my-write')]), 'same');
  const applied = await store.write(original);
  await store.write(commit(first.storeId, 2, workspace([task('other-write')]), 'other'));
  await store.close();
  store = makeStore(mock);
  const duplicate = await store.write(original);
  assert.deepEqual([duplicate.ok, duplicate.duplicate, duplicate.revision, duplicate.currentRevision, duplicate.updatedAt, duplicate.storeId], [true, true, 2, 3, applied.updatedAt, first.storeId]);
  assert.equal((await store.get()).workspace.tasks[0].id, 'other-write');
  const samePayloadReordered = { workspace: { reportEdits: {}, inboxAck: [], reports: [], artifacts: [], logs: [], projects: [], tasks: [task('my-write')] }, storeId: first.storeId, requestId: 'same', baseRevision: 1, action: 'commit' };
  assert.equal((await store.write(samePayloadReordered)).duplicate, true);
  for (const changed of [{ ...original, baseRevision: 3 }, { ...original, workspace: workspace([task('different')]) }]) await assert.rejects(store.write(changed), { code: 'request-id-conflict' });
  // Initial null/missing storeId are compatible and initialization retries remain safe after later writes.
  const initRetry = initialize(); delete initRetry.storeId;
  const initResult = await store.write(initRetry);
  assert.deepEqual([initResult.revision, initResult.currentRevision, initResult.duplicate], [1, 3, true]);
  await store.close();
});

test('commit storeId guard rejects equal-revision replacement and runs before receipt dedupe', async () => {
  const mock = mockStorage();
  const store = makeStore(mock);
  const init = await store.write(initialize());
  await store.write(commit(init.storeId, 1, workspace(), 'write'));
  await assert.rejects(store.write(commit('other-store', 1, workspace(), 'write')), { code: 'store-id-conflict' });
  await assert.rejects(store.write(commit('other-store', 2, workspace(), 'new-write')), { code: 'store-id-conflict' });
  const missing = commit(init.storeId, 2); delete missing.storeId;
  await assert.rejects(store.write(missing), { code: 'invalid-store-id' });
  assert.equal((await store.get()).revision, 2);
  await store.close();
});

test('receipt history retains exactly last 100 requests; evicted stale retries cannot overwrite current state', async () => {
  const mock = mockStorage();
  const store = makeStore(mock);
  const init = await store.write(initialize());
  for (let revision = 1; revision <= 105; revision += 1) await store.write(commit(init.storeId, revision));
  assert.equal(mock.state.disk.receipts.length, 100);
  assert.equal(mock.state.disk.receipts[0].revision, 7);
  await assert.rejects(store.write(commit(init.storeId, 1)), { code: 'revision-conflict' });
  assert.equal((await store.get()).revision, 106);
  await store.close();
});

test('success is delayed until the atomic save resolves, and snapshots capture caller data', async () => {
  const mock = mockStorage();
  const entered = deferred(); const release = deferred();
  mock.state.beforeWrite = () => { entered.resolve(); return release.promise; };
  const store = makeStore(mock);
  const command = initialize();
  let resolved = false;
  const pending = store.write(command).then((result) => { resolved = true; return result; });
  command.workspace.tasks[0].title = 'mutated';
  await entered.promise;
  assert.equal(resolved, false);
  assert.equal(mock.state.disk, null);
  release.resolve();
  await pending;
  const result = await store.get();
  assert.equal(result.workspace.tasks[0].title, '任务t-1');
  result.workspace.tasks[0].title = 'mutated snapshot';
  assert.equal((await store.get()).workspace.tasks[0].title, '任务t-1');
  await store.close();
});

test('failure before publication does not publish dirty handle data or poison the serial chain', async () => {
  const mock = mockStorage();
  const store = makeStore(mock);
  const init = await store.write(initialize());
  mock.state.failures.push('before');
  const failed = store.write(commit(init.storeId, 1, workspace([task('failed')]), 'failed'));
  const following = store.write(commit(init.storeId, 1, workspace([task('following')]), 'following'));
  await assert.rejects(failed, { code: 'workspace-write-failed', details: { retryable: true, uncertain: true } });
  assert.equal((await following).revision, 2);
  assert.equal(mock.state.opens, 2);
  assert.equal((await store.get()).workspace.tasks[0].id, 'following');
  assert.equal(mock.state.disk.receipts.some((receipt) => receipt.requestId === 'failed'), false);
  await store.close();
});

test('uncertain failure after publication recovers identity and original receipt; retry needs its own durability barrier', async () => {
  const mock = mockStorage();
  const store = makeStore(mock);
  mock.state.failures.push('after');
  const initial = initialize();
  let failure;
  try { await store.write(initial); } catch (error) { failure = workspaceFailure(error); }
  assert.deepEqual(failure && [failure.ok, failure.error, failure.uncertain], [false, 'workspace-write-failed', true]);
  const persistedId = mock.state.disk.storeId;
  mock.state.failures.push('before');
  await assert.rejects(store.write(initial), { code: 'workspace-write-failed' });
  const retry = await store.write(initial);
  assert.deepEqual([retry.duplicate, retry.revision, retry.currentRevision, retry.storeId], [true, 1, 1, persistedId]);
  assert.equal(mock.state.writes, 3);
  await store.close();
});

test('invalid full-workspace records and non-JSON values are rejected without any truncation or writes', async () => {
  const bad = [ {}, { ...empty(), tasks: [task('x'), task('x')] }, { ...empty(), logs: [{ id: 'l', taskId: 't', text: 2 }] },
    { ...empty(), projects: [{ id: 'p', name: '' }] }, { ...empty(), artifacts: [{ id: 'a', taskId: 't', links: [4] }] },
    { ...empty(), reports: [{ id: 'r', body: 'x', kind: 'week', period: { start: '2026-11-30', end: '2026-11-01' } }] },
    { ...empty(), reportEdits: { r: { body: 'x', excluded: false } } }, { ...empty(), inboxAck: [null] },
    { ...empty(), future: undefined }, { ...empty(), future: NaN }, { ...empty(), future: new Date() },
  ];
  const cycle = empty(); cycle.future = cycle; bad.push(cycle);
  const mock = mockStorage(); const store = makeStore(mock);
  for (const value of bad) await assert.rejects(store.write(initialize(value)), { code: 'invalid-workspace' });
  assert.equal(mock.state.writes, 0);
  assert.equal(mock.state.opens, 0);
  await store.close();
});

test('invalid commands/revisions/keys and commit-before-initialization have clear errors', async () => {
  const mock = mockStorage(); const store = makeStore(mock);
  await assert.rejects(store.write({ ...initialize(), action: 'init' }), { code: 'invalid-workspace-command' });
  await assert.rejects(store.write({ ...initialize(), extra: true }), { code: 'invalid-workspace-command' });
  for (const baseRevision of [-1, 0.2, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(store.write({ ...initialize(), baseRevision }), { code: 'invalid-base-revision' });
  for (const requestId of ['', ' '.repeat(3), 'x'.repeat(201), 42]) await assert.rejects(store.write({ ...initialize(), requestId }), { code: 'invalid-request-id' });
  await assert.rejects(store.write(commit('unknown', 0)), { code: 'workspace-uninitialized' });
  await store.close();
});

test('corrupt persistent medium fails closed without overwriting or resetting', async () => {
  for (const invalid of [{ version: 2 }, { version: 1, revision: 1, storeId: 'x', workspace: empty(), updatedAt: 'bad', receipts: [] }]) {
    const mock = mockStorage(invalid); const store = makeStore(mock);
    await assert.rejects(store.write(initialize()), { code: 'workspace-corrupt' });
    assert.deepEqual(mock.state.disk, invalid);
    assert.equal(mock.state.writes, 0);
    await store.close();
  }
});

test('optional storage is never an in-memory success; route ambiguity and explicit selection are predictable', async () => {
  await assert.rejects(new WorkspaceStore(() => undefined).get(), { code: 'storage-unavailable' });
  const mock = mockStorage();
  const multi = { backend: { names: () => ['json', 'other'], get: () => mock.backend } };
  await assert.rejects(new WorkspaceStore(() => multi).get(), { code: 'storage-backend-ambiguous' });
  const explicit = new WorkspaceStore(() => multi, { backend: 'json' });
  assert.equal((await explicit.get()).initialized, false);
  await explicit.close();
  await assert.rejects(makeStore(mock, { backend: 'missing' }).get(), { code: 'storage-backend-unavailable' });
});

test('failed close blocks already queued writers; disposal retries release and never closes shared backend', async () => {
  const mock = mockStorage(); const store = makeStore(mock);
  const init = await store.write(initialize());
  mock.state.failures.push('before'); mock.state.closeFailures = 1;
  const failed = store.write(commit(init.storeId, 1));
  const queued = store.write(commit(init.storeId, 1, workspace(), 'queued'));
  await assert.rejects(failed, { code: 'workspace-write-failed' });
  await assert.rejects(queued, { code: 'workspace-close-failed' });
  await assert.rejects(store.get(), { code: 'workspace-close-failed' });
  assert.equal(mock.state.opens, 1);
  await store.close();
  assert.equal(mock.state.closes, 1);
});

test('bounded list/read/prepare are pure reads, omit recycle-bin tasks and use recent records consistently', async () => {
  const mock = mockStorage(); const store = makeStore(mock);
  const value = workspace(Array.from({ length: 60 }, (_, index) => task('t-' + index, { projectId: index % 2 ? 'p' : '', status: index % 2 ? 'todo' : 'done' })));
  value.tasks.push(task('deleted', { deletedAt: '2026-11-12' }));
  value.tasks[1].description = 'x'.repeat(20000);
  value.logs = Array.from({ length: 9 }, (_, i) => ({ id: 'l-' + i, taskId: 't-1', text: '记录' + i, at: '2026-11-' + String(i + 1).padStart(2, '0') })).reverse();
  value.artifacts = Array.from({ length: 8 }, (_, i) => ({ id: 'a-' + i, taskId: 't-1', summary: '成果' + i, at: '2026-11-' + String(i + 1).padStart(2, '0'), links: [] }));
  const init = await store.write(initialize(value));
  const before = copy(mock.state.disk); const writes = mock.state.writes;
  const listed = await workspaceContext(store, { action: 'list' });
  assert.equal(listed.items.length, 20); assert.equal(listed.hasMore, true); assert.equal(listed.revision, 1);
  assert.deepEqual(Object.keys(listed.items[0]), ['id', 'title', 'projectId', 'status']);
  const filtered = await workspaceContext(store, { action: 'list', projectId: 'p', status: 'todo', query: '任务', limit: 50 });
  assert.equal(filtered.items.length, 30); assert.equal(filtered.hasMore, false);
  const page = await workspaceContext(store, { action: 'list', offset: 50, limit: 10 });
  assert.equal(page.items.length, 10); assert.equal(page.hasMore, false);
  const read = await workspaceContext(store, { action: 'read', taskId: 't-1' });
  assert.deepEqual(read.logs.map((entry) => entry.id), ['l-4', 'l-5', 'l-6', 'l-7', 'l-8']);
  assert.deepEqual(read.artifacts.map((entry) => entry.id), ['a-3', 'a-4', 'a-5', 'a-6', 'a-7']);
  assert.ok(read.task.description.length < 2100);
  const prepared = await workspaceContext(store, { action: 'prepare', taskId: 't-1' });
  assert.equal(prepared.taskId, 't-1'); assert.equal(prepared.revision, init.revision);
  assert.ok(prepared.prompt.includes('通过测试')); assert.ok(prepared.prompt.includes('work_panel_report')); assert.ok(prepared.prompt.includes('t-1'));
  assert.ok(prepared.prompt.length < 25000);
  assert.deepEqual(mock.state.disk, before); assert.equal(mock.state.writes, writes);
  for (const args of [{ action: 'write' }, { action: 'read' }, { action: 'read', taskId: 'deleted' }, { action: 'list', limit: 51 }]) await assert.rejects(workspaceContext(store, args));
  await store.close();
});

test('size/depth limits reject explicitly, and a transient load failure can reopen without poisoning the queue', async () => {
  const mock = mockStorage(); const store = makeStore(mock);
  const huge = empty(); huge.future = 'x'.repeat(32 * 1024 * 1024);
  await assert.rejects(store.write(initialize(huge)), { code: 'workspace-too-large' });
  assert.equal(mock.state.writes, 0);
  let nested = {}; for (let i = 0; i < 66; i += 1) nested = { child: nested };
  await assert.rejects(store.write(initialize({ ...empty(), nested })), { code: 'invalid-workspace' });
  const sparse = empty(); sparse.future = Array(3);
  await assert.rejects(store.write(initialize(sparse)), { code: 'invalid-workspace' });
  const open = mock.backend.kv.open;
  let failLoad = true;
  mock.backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor);
    if (failLoad) { failLoad = false; unit.loadAll = async () => { const error = new Error('read failed'); error.code = 'EACCES'; throw error; }; }
    return unit;
  };
  await assert.rejects(store.get(), { code: 'workspace-load-failed', details: { retryable: true, storageCode: 'EACCES' } });
  assert.equal((await store.write(initialize())).ok, true);
  assert.equal(mock.state.opens, 2);
  await store.close();
});

test('context refuses uninitialized data and close drains admitted writes', async () => {
  const mock = mockStorage(); const store = makeStore(mock);
  await assert.rejects(workspaceContext(store, { action: 'list' }), { code: 'workspace-uninitialized' });
  const entered = deferred(); const release = deferred();
  mock.state.beforeWrite = () => { entered.resolve(); return release.promise; };
  const pending = store.write(initialize());
  await entered.promise;
  const closing = store.close();
  await assert.rejects(store.get(), { code: 'workspace-closed' });
  release.resolve(); await pending; await closing; await store.close();
  assert.equal(mock.state.closes, 1);
});
