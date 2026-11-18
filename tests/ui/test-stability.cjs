'use strict';
// Stateful, isolated VM regression suite. Never reads browser/profile storage.
// Run: node work-panel/tests/ui/test-stability.cjs [optional test-name substring]
const assert = require('node:assert/strict');
const { PREFIX, KEY, PRE, NOW, PERIOD, editKey, plain, deferred, MemoryStorage, FakeTimers, walk, text, hasClass, createRuntime, task, report, workspace, fixture, seedStorage, harness } = require('../helpers/ui-harness.cjs');
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
