'use strict';
// Existing effect-aware VM harness only: no browser emulation or real networking.
const assert = require('node:assert/strict');
const { harness, workspace, task, KEY, NOW, hasClass, text, walk } = require('../helpers/ui-harness.cjs');
const state = () => workspace({ tasks: ['a', 'b'].map(id => ({ ...task(id, '', '任务' + id), status: 'todo', progress: 0, completedAt: null, description: '描述' + id, nextStep: '下一步' + id })) });
const tests = [];
const test = (name, run) => tests.push({ name, run });
const select = (ui, id = 'a') => ui.fire(ui.one(n => hasClass(n, 'wp-row') && text(n).includes('任务' + id)), 'onClick');
const tab = (ui, label) => ui.fire(ui.one(n => hasClass(n, 'wp-detail-tab') && text(n).startsWith(label)), 'onClick');
const exists = (ui, cls) => ui.nodes().some(n => hasClass(n, cls));
const workButton = (ui, label) => walk(ui.byClass('wp-detail-workbar')).find(n => n.type === 'button' && text(n) === label);
const tool = (ui, label) => ui.fire(workButton(ui, label), 'onClick');
const sheet = ui => ui.byClass('wp-detail-sheet');
const closeSheet = ui => ui.click('关闭工作面板');
const dispatch = (ui, name, event) => { for (const callback of ui.events.get(name) || []) callback(event); ui.runtime.flush(); };
async function open(options) { const ui = harness(state(), undefined, options); await ui.settle(); select(ui); return ui; }

test('description is default, four tabs follow title and only one content pane is mounted', async () => {
  const ui = await open(); try {
    const tabs = ui.nodes().filter(n => hasClass(n, 'wp-detail-tab'));
    assert.deepEqual(tabs.map(text), ['描述', '执行', '记录', '成果']);
    assert.equal(tabs[0].props['aria-selected'], 'true');
    const nodes = walk(ui.byClass('wp-detail-body'));
    assert.ok(nodes.indexOf(ui.byClass('wp-detail-title-input')) < nodes.indexOf(ui.byClass('wp-detail-tabs')));
    assert.ok(nodes.indexOf(ui.byClass('wp-detail-tabs')) < nodes.indexOf(ui.byClass('wp-detail-pane')));
    assert.equal(ui.nodes().filter(n => n.props.role === 'tabpanel').length, 1);
    assert.ok(exists(ui, 'wp-detail-desc')); assert.ok(!exists(ui, 'wp-detail-exec'));
    assert.ok(walk(ui.byClass('wp-detail-pane')).includes(ui.byClass('wp-detail-desc')));
    for (const [label, cls] of [['执行', 'wp-detail-exec'], ['记录', 'wp-detail-logs'], ['成果', 'wp-detail-artifacts']]) {
      tab(ui, label); assert.ok(exists(ui, cls)); assert.ok(!exists(ui, 'wp-detail-desc'));
      assert.equal(ui.nodes().filter(n => n.props.role === 'tabpanel').length, 1);
      assert.ok(exists(ui, 'wp-detail-workbar'), 'workbar persists across tabs');
    }
    assert.equal(ui.requests.length, 0, 'opening task and changing tabs never calls AI');
  } finally { ui.close(); }
});

test('description is editor-only and footer keeps project selection left of three quiet work actions on every tab', async () => {
  const ui = await open(); try {
    const desc = ui.byClass('wp-detail-desc');
    assert.deepEqual(desc.children.flat(Infinity).filter(n => n && typeof n === 'object').map(n => n.props.className), ['wp-md-blocks'], 'the description has only its editor, no helper rows');
    for (const removed of ['wp-detail-desc-head', 'wp-md-toolbar', 'wp-md-editor-hint']) assert.ok(!exists(ui, removed), removed + ' is removed');
    for (const label of ['描述', '执行', '记录', '成果']) {
      tab(ui, label);
      const bar = ui.byClass('wp-detail-workbar');
      const children = bar.children.flat(Infinity).filter(n => n && typeof n === 'object');
      assert.equal(children.length, 2, 'footer has exactly the project control and action group');
      const picker = ui.byClass('wp-detail-project-picker');
      const projectSelect = ui.byClass('wp-detail-project-select');
      const icon = ui.byClass('wp-detail-project-icon');
      assert.equal(children[0], picker);
      assert.equal(picker.type, 'div');
      const pickerChildren = picker.children.flat(Infinity).filter(n => n && typeof n === 'object');
      assert.deepEqual(pickerChildren, [icon, projectSelect], 'decorative prefix and native select share the compact wrapper');
      assert.equal(String(icon.props['aria-hidden']), 'true', 'project icon is decorative, not a duplicate accessible label');
      assert.equal(icon.props.tabIndex, undefined, 'decorative prefix adds no keyboard stop');
      assert.equal(projectSelect.type, 'select');
      assert.equal(projectSelect.props['aria-label'], '所属项目');
      assert.equal(projectSelect.props.title, '所属项目：未归属项目');
      assert.equal(projectSelect.props.value, '');
      assert.equal(children[1], ui.byClass('wp-detail-work-actions'));
      assert.equal(children[1].type, 'div');
      const buttons = walk(children[1]).filter(n => n.type === 'button');
      assert.deepEqual(buttons.map(text), ['AI 建议', '工作助手', '交给 AI']);
      assert.ok(buttons.every(n => n.props.className === 'wp-btn wp-btn-text wp-act-btn'));
    }
    assert.equal(ui.requests.length, 0, 'layout and tab navigation never generate AI requests');
  } finally { ui.close(); }
});

test('project picker CSS keeps two-thirds width, decorative click-through prefix, no native arrow and visible keyboard focus', async () => {
  const ui = await open(); try {
    // Inspect the existing rendered stylesheet text only; no layout/browser emulation.
    const css = ui.nodes().filter(n => n.type === 'style').map(text).join('\n');
    const picker = css.match(/\.wp-detail-project-picker\s*\{([^}]+)\}/)?.[1] || '';
    const icon = css.match(/\.wp-detail-project-icon\s*\{([^}]+)\}/)?.[1] || '';
    const select = css.match(/\.wp-detail-project-picker\s*>\s*\.wp-detail-project-select\s*\{([^}]+)\}/)?.[1] || '';
    const focus = css.match(/\.wp-detail-project-select:focus-visible\s*\{([^}]+)\}/)?.[1] || '';
    assert.match(picker, /position:\s*relative\s*;/);
    assert.match(picker, /max-width:\s*calc\(200px\s*\*\s*2\s*\/\s*3\)\s*;/);
    assert.match(icon, /position:\s*absolute\s*;/);
    assert.match(icon, /pointer-events:\s*none\s*;/);
    assert.match(select, /(?:^|;)\s*appearance:\s*none\s*;/);
    assert.match(select, /-webkit-appearance:\s*none\s*;/);
    assert.match(select, /background-image:\s*none\s*;/);
    assert.match(select, /width:\s*100%\s*;/);
    assert.match(select, /min-width:\s*0\s*;/);
    assert.match(select, /padding:\s*4px\s+2px\s+4px\s+22px\s*;/);
    assert.match(select, /text-overflow:\s*ellipsis\s*;/);
    assert.match(focus, /outline:\s*2px\s+solid\s+var\(--wp-primary\)\s*;/);
  } finally { ui.close(); }
});

const projectState = (projectId = 'p') => workspace({
  tasks: [{ ...task('a', projectId, '任务a'), status: 'todo', progress: 0, completedAt: null, description: '原始描述', nextStep: '原始下一步' }],
  projects: [
    { id: 'p', name: '项目一', status: 'active' },
    { id: 'q', name: '项目二', status: 'active' },
    { id: 'archived', name: '历史项目', status: 'archived' },
    { id: 'other-archived', name: '其他历史项目', status: 'archived' },
  ].map(project => ({ description: '', color: '', archivedAt: project.status === 'archived' ? NOW : null, createdAt: NOW, updatedAt: NOW, ...project })),
});
const projectOptions = ui => walk(ui.byClass('wp-detail-project-select')).filter(n => n.type === 'option');

test('project switching flushes title, Markdown and execution drafts, persists assignment and unassignment across remounts', async () => {
  const initial = projectState(); const ui = harness(initial); await ui.settle(); select(ui);
  const storage = ui.storage;
  try {
    assert.deepEqual(projectOptions(ui).map(n => n.props.value), ['', 'p', 'q']);
    assert.equal(text(projectOptions(ui)[0]), '未归属项目');
    ui.change('wp-detail-title-input', '项目切换前标题草稿');
    ui.fire(ui.byClass('wp-md-block'), 'onClick');
    ui.fire(ui.byClass('wp-md-block-input'), 'onChange', { target: { value: '## 切换前 Markdown 草稿', selectionStart: 20, selectionEnd: 20 } });
    tab(ui, '执行');
    ui.fire(ui.one(n => n.type === 'textarea' && n.props.value === '原始下一步'), 'onChange', { target: { value: '切换前执行草稿' } });
    tool(ui, '工作助手'); assert.ok(exists(ui, 'wp-detail-sheet'));
    ui.change('wp-detail-project-select', 'q');
    assert.ok(!exists(ui, 'wp-detail-sheet'), 'project change closes the context-sensitive work sheet');
    assert.equal(ui.byClass('wp-detail-project-select').props.value, 'q');
    const expected = { title: '项目切换前标题草稿', description: '## 切换前 Markdown 草稿', nextStep: '切换前执行草稿', projectId: 'q' };
    const saved = ui.storage.json(KEY.tasks).find(t => t.id === 'a');
    for (const [key, value] of Object.entries(expected)) assert.equal(saved[key], value, key + ' is flushed before any debounce advance');
    ui.timers.advance(600); await ui.settle();
    for (const [key, value] of Object.entries(expected)) assert.equal(ui.server.workspace.tasks.find(t => t.id === 'a')[key], value, key + ' reaches canonical Host workspace after its sync debounce');
    assert.equal(ui.storage.json(KEY.tasks)[0].projectId, 'q', 'an old debounce cannot revert assignment');
    assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
  const reopened = harness(initial, storage); await reopened.settle();
  reopened.fire(reopened.one(n => hasClass(n, 'wp-row') && text(n).includes('项目切换前标题草稿')), 'onClick');
  try {
    assert.equal(reopened.byClass('wp-detail-project-select').props.value, 'q', 'assignment survives remount');
    reopened.change('wp-detail-project-select', ''); reopened.timers.advance(600); await reopened.settle();
    assert.equal(storage.json(KEY.tasks)[0].projectId, '');
    assert.equal(reopened.server.workspace.tasks[0].projectId, '', 'unassignment persists to the Host');
    assert.equal(storage.json(KEY.tasks)[0].description, '## 切换前 Markdown 草稿');
    assert.equal(reopened.requests.length, 0);
  } finally { reopened.close(); }
  const unassigned = harness(initial, storage); await unassigned.settle();
  unassigned.fire(unassigned.one(n => hasClass(n, 'wp-row') && text(n).includes('项目切换前标题草稿')), 'onClick');
  try { assert.equal(unassigned.byClass('wp-detail-project-select').props.value, '', 'unassignment survives remount'); }
  finally { unassigned.close(); }
});

for (const current of ['archived', 'missing-project']) test('project footer retains only its current unavailable fallback: ' + current, async () => {
  const ui = harness(projectState(current)); await ui.settle(); select(ui);
  try {
    const options = projectOptions(ui);
    assert.equal(ui.byClass('wp-detail-project-select').props.value, current);
    assert.deepEqual(options.map(n => n.props.value).sort(), ['', 'p', 'q', current].sort(), 'unrelated archived projects are never offered');
    const fallback = options.find(n => n.props.value === current);
    assert.equal(fallback.props.disabled, true);
    assert.ok(text(fallback).includes(current === 'archived' ? '已归档' : '项目不可用'));
    for (const invalid of ['other-archived', 'unknown-project']) {
      ui.change('wp-detail-project-select', invalid);
      assert.equal(ui.byClass('wp-detail-project-select').props.value, current, 'even a stale/forged change cannot assign an unavailable project');
      assert.equal(ui.storage.json(KEY.tasks)[0].projectId, current);
    }
    ui.change('wp-detail-project-select', 'p'); await ui.settle();
    assert.equal(ui.storage.json(KEY.tasks)[0].projectId, 'p');
    assert.deepEqual(projectOptions(ui).map(n => n.props.value), ['', 'p', 'q'], 'fallback disappears after moving to an active project');
    ui.change('wp-detail-project-select', ''); ui.timers.advance(600); await ui.settle();
    assert.equal(ui.server.workspace.tasks[0].projectId, '');
    assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
});

test('description, title, execution and composer drafts survive tab switches; task switch resets tab and sheet', async () => {
  const ui = await open(); try {
    ui.change('wp-detail-title-input', '任务a新标题');
    ui.fire(ui.byClass('wp-md-block'), 'onClick');
    ui.fire(ui.byClass('wp-md-block-input'), 'onChange', { target: { value: '未等待保存的描述', selectionStart: 8, selectionEnd: 8 } });
    tab(ui, '执行');
    const next = ui.one(n => n.type === 'textarea' && n.props.value === '下一步a');
    ui.fire(next, 'onChange', { target: { value: '执行草稿' } });
    tab(ui, '记录'); ui.click('记录进展'); ui.change('wp-composer-panel-input', '未提交记录');
    tab(ui, '成果'); ui.click('关联成果');
    const summary = ui.one(n => n.type === 'textarea' && hasClass(n, 'wp-composer-panel-input') && n.props.placeholder === '结果摘要（可选）');
    ui.fire(summary, 'onChange', { target: { value: '未提交成果' } });
    tab(ui, '描述'); assert.equal(ui.byClass('wp-detail-title-input').props.value, '任务a新标题');
    assert.ok(ui.text().includes('未等待保存的描述') || ui.nodes().some(n => n.props.value === '未等待保存的描述'));
    tab(ui, '执行'); assert.ok(ui.nodes().some(n => n.props.value === '执行草稿'));
    tab(ui, '记录'); if (!exists(ui, 'wp-composer-panel-input')) ui.click('记录进展');
    assert.equal(ui.byClass('wp-composer-panel-input').props.value, '未提交记录');
    tab(ui, '成果'); if (!exists(ui, 'wp-composer-panel-input')) ui.click('关联成果');
    assert.ok(ui.nodes().some(n => n.props.value === '未提交成果'));
    tool(ui, '工作助手'); sheet(ui); select(ui, 'b');
    assert.equal(ui.one(n => hasClass(n, 'wp-detail-tab') && text(n) === '描述').props['aria-selected'], 'true');
    assert.ok(!exists(ui, 'wp-detail-sheet')); assert.ok(ui.text().includes('描述b'));
    ui.timers.advance(600); await ui.settle();
    const saved = ui.storage.json(KEY.tasks).find(t => t.id === 'a');
    assert.equal(saved.title, '任务a新标题'); assert.equal(saved.description, '未等待保存的描述'); assert.equal(saved.nextStep, '执行草稿');
    assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
});

test('mutually exclusive sheets retain advice loading/results and do not repeat model calls', async () => {
  const ui = await open(); try {
    tool(ui, '工作助手'); assert.equal(ui.requests.length, 0); sheet(ui);
    tool(ui, 'AI 建议'); await ui.settle(); const request = ui.nextRequest('task');
    assert.ok(exists(ui, 'wp-ai-loading')); assert.equal(ui.nodes().filter(n => hasClass(n, 'wp-detail-sheet')).length, 1);
    assert.ok(!ui.text().includes('工作助手 · 按需整理'));
    closeSheet(ui); assert.ok(!exists(ui, 'wp-detail-sheet'));
    tool(ui, 'AI 建议'); assert.equal(ui.requests.length, 1); assert.ok(exists(ui, 'wp-ai-loading'));
    tool(ui, '工作助手'); assert.ok(!exists(ui, 'wp-ai-panel')); assert.equal(ui.requests.length, 1);
    await ui.respond(request, { reply: '保留的分析结果', suggestion: { nextStep: '仅建议，不自动应用' } });
    tool(ui, 'AI 建议'); assert.ok(ui.text().includes('保留的分析结果')); assert.equal(ui.requests.length, 1);
    assert.equal(ui.storage.json(KEY.tasks).find(t => t.id === 'a').nextStep, '下一步a');
    closeSheet(ui); tool(ui, 'AI 建议'); assert.ok(ui.text().includes('保留的分析结果')); assert.equal(ui.requests.length, 1);
    ui.click('重新分析'); await ui.settle(); assert.equal(ui.requests.length, 2, 'only explicit refresh adds a request');
  } finally { ui.close(); }
});

test('close, Escape and outside interaction close sheet without generating AI; workbar toggle remains usable', async () => {
  const ui = await open(); try {
    let restored = 0;
    const opener = { focus() { restored++; } };
    const openAssistant = () => ui.fire(workButton(ui, '工作助手'), 'onClick', { currentTarget: opener });
    openAssistant(); assert.equal(sheet(ui).props.role, 'dialog');
    let focused = 0;
    sheet(ui).props.ref.current.focus = () => { focused++; };
    closeSheet(ui); assert.ok(!exists(ui, 'wp-detail-sheet')); assert.equal(restored, 1);
    openAssistant(); assert.equal(focused, 1, 'opening focuses the upward sheet');
    const inside = {}, barTarget = {};
    sheet(ui).props.ref.current.contains = target => target === inside;
    ui.byClass('wp-detail-workbar').props.ref.current.contains = target => target === barTarget;
    dispatch(ui, 'mousedown', { target: inside }); assert.ok(exists(ui, 'wp-detail-sheet'));
    dispatch(ui, 'mousedown', { target: barTarget }); assert.ok(exists(ui, 'wp-detail-sheet'));
    dispatch(ui, 'keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.ok(!exists(ui, 'wp-detail-sheet')); assert.equal(restored, 2, 'Escape restores opener focus');
    openAssistant();
    dispatch(ui, 'mousedown', { target: {}, preventDefault() {}, stopPropagation() {} });
    assert.ok(!exists(ui, 'wp-detail-sheet')); assert.equal(restored, 2, 'outside click must not steal focus');
    openAssistant();
    dispatch(ui, 'focusin', { target: inside }); assert.ok(exists(ui, 'wp-detail-sheet'));
    dispatch(ui, 'focusin', { target: barTarget }); assert.ok(exists(ui, 'wp-detail-sheet'));
    dispatch(ui, 'focusin', { target: {} });
    assert.ok(!exists(ui, 'wp-detail-sheet')); assert.equal(restored, 2, 'keyboard focus on background must not be stolen back');
    openAssistant(); tab(ui, '执行'); assert.ok(!exists(ui, 'wp-detail-sheet'), 'tab change closes sheet');
    assert.equal(restored, 2, 'tab change must not restore old tool focus');
    tool(ui, '工作助手'); tool(ui, '工作助手'); assert.ok(!exists(ui, 'wp-detail-sheet'));
    assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
});

for (const field of ['title-draft', 'execution']) test('cached advice cannot overwrite newer ' + field + ' context and only explicit refresh regenerates', async () => {
  const ui = await open(); try {
    tool(ui, 'AI 建议'); await ui.settle();
    const reply = { reply: '旧上下文分析', suggestion: { nextStep: '旧建议下一步', blockedReason: '旧建议阻塞' } };
    await ui.respond(ui.nextRequest('task'), reply);
    const originalAdoptHandler = ui.button('采纳为下一步').props.onClick;
    if (field === 'title-draft') ui.change('wp-detail-title-input', '用户正在输入的新标题');
    else {
      tab(ui, '执行');
      const next = ui.one(n => n.type === 'textarea' && n.props.value === '下一步a');
      ui.fire(next, 'onChange', { target: { value: '人工更新下一步' } });
      tool(ui, 'AI 建议');
    }
    assert.ok(ui.button('采纳为下一步').props.disabled, 'stale cached result disables adoption');
    assert.ok(ui.button('采纳为阻塞原因').props.disabled);
    // An already captured click must recheck latest context too, not only rely on disabled rendering.
    originalAdoptHandler(); ui.runtime.flush();
    const expected = field === 'execution' ? '人工更新下一步' : '下一步a';
    assert.equal(ui.storage.json(KEY.tasks).find(t => t.id === 'a').nextStep, expected);
    assert.equal(ui.requests.length, 1, 'editing and reopening do not regenerate implicitly');
    ui.click('重新分析'); await ui.settle(); await ui.respond(ui.nextRequest('task'), reply);
    assert.ok(!ui.button('采纳为下一步').props.disabled, 'fresh explicit analysis re-enables adoption');
    ui.click('采纳为下一步');
    assert.equal(ui.storage.json(KEY.tasks).find(t => t.id === 'a').nextStep, '旧建议下一步');
    assert.ok(!ui.button('采纳为阻塞原因').props.disabled, 'own valid adoption does not invalidate remaining advice');
  } finally { ui.close(); }
});

test('changing task invalidates in-flight assistant output instead of leaking it into another task', async () => {
  const ui = await open(); try {
    tool(ui, '工作助手'); ui.click('生成工作建议'); await ui.settle(); const request = ui.nextRequest('task');
    select(ui, 'b'); assert.ok(!exists(ui, 'wp-detail-sheet'));
    await ui.respond(request, { reply: '只属于任务a的旧结果', options: [], receiptSummary: [] });
    tool(ui, '工作助手'); assert.ok(!ui.text().includes('只属于任务a的旧结果'));
    assert.equal(ui.requests.length, 1, 'opening another task does not implicitly regenerate');
  } finally { ui.close(); }
});

test('handoff is unsent and retained across sheet tools/close without repeated context preparation', async () => {
  let preparations = 0; const starts = [];
  const ui = await open({ contextHook: () => { preparations++; return { ok: true, taskId: 'a', prompt: '初始执行指令' }; }, services: { uiWorkspace: { startSession: (...args) => starts.push(args) } } });
  try {
    tool(ui, '交给 AI'); await ui.settle(); assert.equal(preparations, 1);
    ui.change('wp-delegation-prompt', '人工编辑未发送指令');
    assert.ok(!ui.nodes().some(n => n.type === 'button' && text(n) === '重新准备指令'), 'existing editable prompt cannot be implicitly replaced by refresh');
    tool(ui, '工作助手'); assert.ok(!exists(ui, 'wp-delegation-prompt'));
    tool(ui, '交给 AI'); await ui.settle(); assert.equal(ui.byClass('wp-delegation-prompt').props.value, '人工编辑未发送指令');
    closeSheet(ui); tool(ui, '交给 AI'); await ui.settle();
    assert.equal(ui.byClass('wp-delegation-prompt').props.value, '人工编辑未发送指令');
    assert.equal(preparations, 1); assert.equal(starts.length, 0); assert.equal(ui.requests.length, 0);
    assert.equal(ui.storage.json(KEY.tasks)[0].status, 'todo');
    ui.click('打开执行草稿'); assert.equal(starts.length, 1); assert.equal(starts[0][1].whenDraftExists, 'append');
  } finally { ui.close(); }
});

test('failed initial handoff preparation can be retried explicitly without implicit calls on reopen', async () => {
  let attempts = 0;
  const ui = await open({ contextHook: () => ++attempts === 1 ? { ok: false, error: 'fixture-prepare-failed' } : { ok: true, taskId: 'a', prompt: '重试准备成功' } });
  try {
    tool(ui, '交给 AI'); await ui.settle(); assert.equal(attempts, 1);
    assert.ok(!exists(ui, 'wp-delegation-prompt'));
    closeSheet(ui); tool(ui, '交给 AI'); await ui.settle();
    assert.equal(attempts, 1, 'reopening an error must not repeat context calls');
    await ui.click('重新准备指令'); await ui.settle();
    assert.equal(attempts, 2); assert.equal(ui.byClass('wp-delegation-prompt').props.value, '重试准备成功');
    assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`DETAIL LAYOUT: ${tests.length - failures} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
})();
