import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { InboxStore, INBOX_DESCRIPTOR, inboxFailure } from './inbox-store.js';

const copy = (value) => structuredClone(value);
function mockStorage(initial = null) {
  const state = { disk: copy(initial), opens: 0, closes: 0, writes: 0, active: 0, maxActive: 0, failures: [], beforeWrite: null };
  const backend = { kv: { open: async (descriptor) => {
    assert.deepEqual(descriptor, INBOX_DESCRIPTOR);
    // Faithful to the Host backend's UNIT_NAME_RE (no hyphens allowed).
    assert.match(descriptor.name, /^[a-z][a-z0-9_]*$/);
    state.opens += 1;
    // Real single-layout backends cache state; loadAll does not reread disk.
    let memory = copy(state.disk);
    let closed = false;
    return {
      loadAll: async () => { assert.equal(closed, false); return { tables: {}, global: copy(memory) }; },
      setGlobal: async (value) => {
        assert.equal(closed, false);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        try {
          state.writes += 1;
          memory = copy(value);
          if (state.beforeWrite) await state.beforeWrite();
          const fail = state.failures.shift();
          if (fail === 'before') throw new Error('write failed before publication');
          state.disk = copy(value);
          if (fail === 'after') throw new Error('sync failed after publication');
        } finally { state.active -= 1; }
      },
      close: async () => { closed = true; state.closes += 1; },
    };
  } } };
  return { state, backend, storage: { backend: { names: () => ['json'], get: (name) => name === 'json' ? backend : undefined } } };
}
const item = (id, requestId, text = id) => ({
  id, ...(requestId ? { requestId } : {}), taskId: 't-1', taskTitle: '', source: 'execution', kind: 'progress',
  text, artifacts: [], receivedAt: '2026-11-12T04:00:00.000Z',
});
const storeFor = (mock, options) => new InboxStore(() => mock.storage, options);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('success waits for durable write; reads do not expose an uncommitted item', async () => {
  const mock = mockStorage();
  const entered = deferred();
  const release = deferred();
  mock.state.beforeWrite = () => { entered.resolve(); return release.promise; };
  const store = storeFor(mock);
  let returned = false;
  const pending = store.enqueue(item('one')).then((result) => { returned = true; return result; });
  await entered.promise;
  assert.equal(returned, false);
  assert.equal(mock.state.disk, null);
  const read = store.list();
  release.resolve();
  assert.deepEqual(await pending, { ok: true, id: 'one', pending: 1 });
  assert.deepEqual((await read).items.map((entry) => entry.id), ['one']);
  await store.close();
});

test('pending reports and ack receipts survive restart, with stable dedupe IDs', async () => {
  const mock = mockStorage();
  let store = storeFor(mock);
  await store.enqueue(item('one', 'req-1'));
  await store.enqueue(item('two', 'req-2'));
  await store.ack(['one']);
  await store.close();
  store = storeFor(mock);
  assert.deepEqual((await store.list()).items.map((entry) => entry.id), ['two']);
  assert.deepEqual(await store.enqueue(item('new-id', 'req-1', 'one')), { ok: true, id: 'one', pending: 1, duplicate: true });
  assert.deepEqual(await store.enqueue(item('other-id', 'req-2', 'two')), { ok: true, id: 'two', pending: 1, duplicate: true });
  assert.deepEqual(await store.ack(['one', 'one', 'missing']), { ok: true, removed: 0 });
  await store.close();
});

test('concurrent submissions and acknowledgements serialize without losing accepted data', async () => {
  const mock = mockStorage();
  const store = storeFor(mock);
  await Promise.all(Array.from({ length: 60 }, (_, i) => store.enqueue(item('item-' + i))));
  assert.equal((await store.list()).items.length, 60);
  const result = await Promise.all([store.ack(['item-0', 'item-1']), store.enqueue(item('last')), store.ack(['item-1', 'item-2'])]);
  assert.deepEqual(result.map((entry) => entry.removed ?? entry.pending), [2, 59, 1]);
  assert.equal((await store.list()).items.length, 58);
  assert.equal(mock.state.maxActive, 1);
  assert.equal(mock.state.disk.items.length, 58);
  await store.close();
});

test('concurrent retries dedupe; changed normalized payload conflicts; absent requestId does not dedupe', async () => {
  const mock = mockStorage();
  const store = storeFor(mock);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.enqueue(item('id-' + i, 'same', 'same text'))));
  assert.equal(new Set(results.map((entry) => entry.id)).size, 1);
  assert.equal(results.filter((entry) => entry.duplicate).length, 19);
  assert.equal(mock.state.writes, 20);
  await assert.rejects(store.enqueue(item('conflict', 'same', 'different')), { code: 'request-id-conflict' });
  await store.enqueue(item('plain-a', undefined, 'same text'));
  await store.enqueue(item('plain-b', undefined, 'same text'));
  assert.equal((await store.list()).items.length, 3);
  await store.close();
});

test('full inbox explicitly rejects without eviction; retry of accepted key still succeeds when full', async () => {
  const mock = mockStorage();
  const store = storeFor(mock, { limit: 2 });
  await store.enqueue(item('one', 'r1'));
  await store.enqueue(item('two'));
  await assert.rejects(store.enqueue(item('three')), { code: 'inbox-full' });
  assert.equal((await store.enqueue(item('new', 'r1', 'one'))).id, 'one');
  assert.deepEqual((await store.list()).items.map((entry) => entry.id), ['one', 'two']);
  await store.ack(['two']);
  await store.enqueue(item('three'));
  await store.close();
});

test('write failure before publication does not poison chain or publish dirty cached data', async () => {
  const mock = mockStorage();
  const store = storeFor(mock);
  await store.enqueue(item('accepted'));
  mock.state.failures.push('before');
  const failed = store.enqueue(item('failed'));
  const following = store.enqueue(item('following'));
  await assert.rejects(failed, { code: 'inbox-write-failed', uncertain: true });
  assert.equal((await following).ok, true);
  assert.equal(mock.state.opens, 2);
  assert.deepEqual(mock.state.disk.items.map((entry) => entry.id), ['accepted', 'following']);
  await store.close();
});

test('write failure after publication is not ok; reopen recovers data and requestId makes retry safe', async () => {
  const mock = mockStorage();
  const store = storeFor(mock);
  mock.state.failures.push('after');
  let failure;
  try { await store.enqueue(item('one', 'r1')); } catch (error) { failure = inboxFailure(error); }
  assert.deepEqual([failure.ok, failure.error, failure.retryable, failure.uncertain], [false, 'inbox-write-failed', true, true]);
  const retry = await store.enqueue(item('different-id', 'r1', 'one'));
  assert.deepEqual(retry, { ok: true, id: 'one', pending: 1, duplicate: true });
  assert.equal(mock.state.opens, 2);
  assert.equal(mock.state.writes, 2);
  await store.close();
});

test('ack failures before and after publication recover; repeated ack never removes other reports', async () => {
  for (const failure of ['before', 'after']) {
    const mock = mockStorage();
    const store = storeFor(mock);
    await store.enqueue(item('one', 'r1'));
    await store.enqueue(item('two'));
    mock.state.failures.push(failure);
    await assert.rejects(store.ack(['one']), { code: 'inbox-write-failed' });
    assert.deepEqual(await store.ack(['one']), { ok: true, removed: failure === 'before' ? 1 : 0 });
    assert.deepEqual((await store.list()).items.map((entry) => entry.id), ['two']);
    assert.equal((await store.enqueue(item('new', 'r1', 'one'))).id, 'one');
    await store.close();
  }
});

test('only bounded ack receipts expire, never the dedupe keys of still-pending reports', async () => {
  const mock = mockStorage();
  const store = storeFor(mock, { receiptLimit: 2 });
  await store.enqueue(item('pending', 'pending'));
  for (const id of ['a', 'b', 'c']) { await store.enqueue(item(id, id)); await store.ack([id]); }
  assert.deepEqual(mock.state.disk.receipts.map((entry) => entry.requestId), ['b', 'c']);
  assert.equal((await store.enqueue(item('new-pending', 'pending', 'pending'))).duplicate, true);
  await store.enqueue(item('new-a', 'a', 'a'));
  assert.equal((await store.list()).items.length, 2);
  await store.close();
});

test('list snapshots cannot mutate persisted or live state; queued inputs are captured', async () => {
  const mock = mockStorage();
  const store = storeFor(mock);
  const input = item('one');
  const pending = store.enqueue(input);
  input.text = 'mutated';
  await pending;
  const result = await store.list();
  result.items[0].text = 'mutated again';
  assert.equal((await store.list()).items[0].text, 'one');
  assert.equal(mock.state.disk.items[0].text, 'one');
  await store.close();
});

test('missing service, missing/non-KV backend, ambiguous routes, and explicit route have clear outcomes', async () => {
  await assert.rejects(new InboxStore(() => undefined).enqueue(item('one')), { code: 'storage-unavailable' });
  const mock = mockStorage();
  await assert.rejects(storeFor(mock, { backend: 'missing' }).list(), { code: 'storage-backend-unavailable' });
  const multi = { backend: { names: () => ['one', 'two'], get: () => mock.backend } };
  await assert.rejects(new InboxStore(() => multi).list(), { code: 'storage-backend-ambiguous' });
  const explicit = new InboxStore(() => multi, { backend: 'one' });
  assert.deepEqual(await explicit.list(), { items: [] });
  await explicit.close();
  await assert.rejects(new InboxStore(() => ({ backend: { names: () => ['blob'], get: () => ({}) } })).list(), { code: 'storage-backend-unavailable' });
});

test('invalid persisted state fails closed and is never silently reset or overwritten', async () => {
  for (const invalid of [{ version: 2, items: [], receipts: [] }, { version: 1, items: [item('a'), item('a')], receipts: [] }, { items: [] }]) {
    const mock = mockStorage(invalid);
    const store = storeFor(mock);
    await assert.rejects(store.enqueue(item('new')), { code: 'inbox-corrupt' });
    assert.deepEqual(mock.state.disk, invalid);
    assert.equal(mock.state.writes, 0);
    assert.equal(mock.state.closes, 1);
    await store.close();
  }
});

test('load failure is explicit and next operation can retry opening', async () => {
  const mock = mockStorage();
  let shouldFail = true;
  const open = mock.backend.kv.open;
  mock.backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor);
    if (shouldFail) { shouldFail = false; unit.loadAll = async () => { throw new Error('unreadable'); }; }
    return unit;
  };
  const store = storeFor(mock);
  await assert.rejects(store.list(), { code: 'inbox-load-failed' });
  assert.equal((await store.enqueue(item('one'))).ok, true);
  await store.close();
});

test('duplicate report and repeated ack only return ok after a new durability barrier', async () => {
  const mock = mockStorage();
  const store = storeFor(mock);
  await store.enqueue(item('one', 'r1'));
  mock.state.failures.push('before');
  await assert.rejects(store.enqueue(item('new', 'r1', 'one')), { code: 'inbox-write-failed' });
  assert.equal((await store.enqueue(item('new', 'r1', 'one'))).duplicate, true);
  await store.ack(['one']);
  mock.state.failures.push('before');
  await assert.rejects(store.ack(['one']), { code: 'inbox-write-failed' });
  assert.deepEqual(await store.ack(['one']), { ok: true, removed: 0 });
  await store.close();
});

test('failed unit close blocks already queued and later operations instead of opening a second writer', async () => {
  const mock = mockStorage();
  const open = mock.backend.kv.open;
  let shouldFail = true;
  mock.backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor);
    const close = unit.close;
    unit.close = async () => {
      if (shouldFail) { shouldFail = false; throw new Error('close failed'); }
      return close();
    };
    return unit;
  };
  const store = storeFor(mock);
  mock.state.failures.push('before');
  const failedWrite = store.enqueue(item('one'));
  const queuedBeforeFailure = store.enqueue(item('two'));
  await assert.rejects(failedWrite, { code: 'inbox-write-failed' });
  await assert.rejects(queuedBeforeFailure, { code: 'inbox-close-failed' });
  await assert.rejects(store.list(), { code: 'inbox-close-failed' });
  assert.equal(mock.state.opens, 1);
  assert.equal(mock.state.writes, 1);
  await store.close();
  assert.equal(mock.state.closes, 1);
});

test('plain-text file metadata persists; old missing-files hashes stay compatible and session origin is not payload identity', async () => {
  const mock = mockStorage();
  let store = storeFor(mock);
  const original = { ...item('one', 'r1'), sourceSessionId: 'real-session', artifacts: [{ summary: '旧成果', links: ['https://example.com'] }] };
  await store.enqueue(original);
  await store.ack(['one']);
  const legacyHash = createHash('sha256').update(JSON.stringify([
    original.taskId, original.taskTitle, original.source, original.kind, original.text,
    original.artifacts.map((artifact) => [artifact.summary, artifact.links]),
  ])).digest('hex');
  assert.equal(mock.state.disk.receipts[0].fingerprint, legacyHash);
  await store.close(); store = storeFor(mock);
  assert.equal((await store.enqueue({ ...original, id: 'new', sourceSessionId: 'retry-session', artifacts: [{ ...original.artifacts[0], files: [] }] })).duplicate, true);
  await assert.rejects(store.enqueue({ ...original, artifacts: [{ ...original.artifacts[0], files: ['/tmp/new.txt'] }] }), { code: 'request-id-conflict' });
  const fileReport = { ...item('files', 'files'), sourceSessionId: 'origin', artifacts: [{ summary: '', links: [], files: ['/tmp/结果.txt'] }] };
  await store.enqueue(fileReport); await store.close(); store = storeFor(mock);
  assert.deepEqual((await store.list()).items[0].artifacts[0].files, ['/tmp/结果.txt']);
  assert.equal((await store.list()).items[0].sourceSessionId, 'origin');
  assert.equal((await store.enqueue({ ...fileReport, sourceSessionId: 'another-session' })).duplicate, true);
  await store.close();
});

test('close drains admitted write, rejects new work, and releases unit exactly once', async () => {
  const mock = mockStorage();
  const entered = deferred();
  const release = deferred();
  mock.state.beforeWrite = () => { entered.resolve(); return release.promise; };
  const store = storeFor(mock);
  const queued = store.enqueue(item('one'));
  await entered.promise;
  const closing = store.close();
  await assert.rejects(store.enqueue(item('two')), { code: 'inbox-closed' });
  assert.equal(mock.state.closes, 0);
  release.resolve();
  await queued;
  await closing;
  await store.close();
  assert.equal(mock.state.closes, 1);
  assert.deepEqual(mock.state.disk.items.map((entry) => entry.id), ['one']);
});
