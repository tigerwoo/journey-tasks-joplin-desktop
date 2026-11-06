import { templateNote } from '../support/template-note';
import test from 'node:test';
import { initializeArchiveBody, parseArchiveBody } from '../../src/domain/bodyTemplate';
import { buildArchiveBody } from '../support/body-template';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import type { TaskInput } from '../../src/services/applicationTypes';
import { MemoryJoplin } from '../support/memory-joplin';

const baseTime = Date.parse('2026-10-24T02:00:00Z');
function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: '用户笔记本' });
  let sequence = 0;
  let clock = baseTime;
  const options = { now: () => clock, randomId: () => String(++sequence).padStart(32, '0') };
  const app = new TaskApplication(host, options);
  return { host, app, options, setTime: (value: number) => { clock = value; } };
}
const input = (recurring = false): TaskInput => ({
  title: '执行任务', body: '- [x] 当前步骤\n用户过程记录', notebookId: 'book',
  schedule: { kind: 'allDay', date: '2026-10-24', zone: 'Asia/Shanghai' },
  ...(recurring ? { body: templateNote('- [x] 当前步骤\n用户过程记录'), recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
    mode: 'archive' } : {}),
});
function namespace(host: MemoryJoplin, id: string): Record<string, { v?: any; d?: number }> {
  return JSON.parse(host.notes.get(id)!.user_data || '{}')[host.namespace] || {};
}

test('single task and repeated series keep all metadata on real task anchors without any auxiliary notes or folders', async () => {
  const { host, app } = setup(); await app.initialize();
  const single = await app.dispatch({ action: 'createTask', requestId: 'single-anchor', input: input() });
  assert.equal(single.status, 'saved', single.message);
  assert.equal(host.notes.size, 1);
  const ownScope = Object.entries(namespace(host, single.noteId!)).find(([key]) => key.startsWith('v3:scope:'));
  assert.ok(ownScope);
  assert.equal(ownScope[1].v.schemaVersion, 3);
  assert.equal(ownScope[1].v.role, 'single');
  assert.equal(ownScope[1].v.rootNoteId, single.noteId);

  const repeat = await app.dispatch({ action: 'createTask', requestId: 'series-anchor', input: input(true) });
  assert.equal(repeat.status, 'saved', repeat.message);
  assert.equal(host.notes.size, 2, 'only the two user tasks may exist');
  const keys = Object.keys(namespace(host, repeat.noteId!));
  assert.ok(keys.some(key => key.startsWith('v3:scope:')));
  assert.ok(!keys.some(key => key.startsWith('v3:template:')), 'no persisted template-body snapshots');
  assert.ok(parseArchiveBody(host.notes.get(repeat.noteId!)!.body));
  assert.ok(keys.some(key => key.startsWith('v3:op:')));
  assert.deepEqual([...host.notebooks.keys()], ['book']);
  assert.equal(host.calls.filter(call => call.method === 'post' && call.path[0] === 'folders').length, 0);
  assert.ok([...host.notes.values()].every(note => note.is_todo === 1));
  for (const note of host.notes.values()) assert.ok(!note.user_data.includes('当前步骤'), 'business userData cannot store execution/template body');
  for (const value of host.settingsValues.values()) assert.ok(!JSON.stringify(value).includes('当前步骤'), 'successful request recovery cannot retain form body');
});

test('native template remains independent of execution text and preserves checkbox states verbatim', async () => {
  const { host, app, setTime } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'template-anchor', input: input(true) });
  const templateBody = '- [x] 模板已有完成项\n- [ ] 模板待办\n只供新周期';
  const editedBody = '- [x] 执行中用户勾选\n与模板不同的过程记录';
  const nativeBody = buildArchiveBody(editedBody, templateBody);
  await host.data.put(['notes', made.noteId!], {}, { title: '原生模板标题', body: nativeBody });
  assert.equal(host.notes.size, 1);
  assert.ok(!host.notes.get(made.noteId!)!.user_data.includes('只供新周期'));
  await app.dispatch({ action: 'refresh', requestId: 'observe-execution-edit' });
  const snapshot = await app.snapshot();
  const skipped = await app.dispatch({ action: 'skip', requestId: 'generate-from-template', seriesId: made.seriesId,
    occurrenceId: snapshot.series[0]!.activeOccurrenceId });
  assert.equal(skipped.status, 'saved', skipped.message);
  const after = await app.snapshot();
  const current = after.series[0]!.occurrences.find(row => row.occurrenceId === after.series[0]!.activeOccurrenceId)!;
  assert.notEqual(current.carrierNoteId, made.noteId);
  assert.equal(host.notes.get(current.carrierNoteId)!.body, templateBody);
  assert.equal(host.notes.get(current.carrierNoteId)!.title, '原生模板标题');
  assert.equal(host.notes.get(made.noteId!)!.body, nativeBody);
  assert.equal(host.notes.get(made.noteId!)!.title, '原生模板标题');
  assert.equal(host.notes.get(made.noteId!)!.is_todo, 1, 'an abandoned first task remains a completed todo anchor');
  assert.equal(after.series[0]!.status, 'active');
  assert.equal(host.notes.size, 2);
  assert.deepEqual([...host.notebooks.keys()], ['book']);
  const oldFollower = structuredClone(host.notes.get(current.carrierNoteId)!);
  const laterTemplate = '- [ ] changed only for future generation';
  await host.data.put(['notes', made.noteId!], {}, { body: buildArchiveBody(editedBody, laterTemplate) });
  setTime(Date.parse('2026-10-25T04:00:00Z'));
  const advanced = await app.dispatch({ action: 'complete', requestId: 'fresh-template-after-native-edit', noteId: current.carrierNoteId });
  assert.equal(advanced.status, 'saved', advanced.message);
  const final = (await app.snapshot()).series[0]!;
  const next = final.occurrences.find(row => row.occurrenceId === final.activeOccurrenceId)!;
  assert.equal(host.notes.get(next.carrierNoteId)!.body, laterTemplate);
  assert.equal(host.notes.get(current.carrierNoteId)!.body, oldFollower.body, 'existing history body must remain unchanged');
  assert.equal(host.notes.get(current.carrierNoteId)!.title, oldFollower.title);
});

test('templates reject attachments and image/data content, but permit a regular link to an existing note', async () => {
  const { host, app } = setup(); await app.initialize();
  const resourceId = '0123456789abcdef0123456789abcdef';
  const noteId = 'abcdef0123456789abcdef0123456789';
  host.resources.set(resourceId, { id: resourceId, title: '用户附件' });
  host.seedNote({ id: noteId, is_todo: 0, parent_id: 'book', title: '资料笔记', body: '资料正文可以有自己的附件' });
  for (const [index, body] of [
    `[附件](:/${resourceId})`, `![图片](:/${resourceId})`, '![外部图片](https://example.com/image.png)',
    '<img src="data:image/png;base64,AAAA">', '![嵌入](data:image/png;base64,AAAA)',
  ].entries()) {
    const count = host.notes.size;
    const rejected = await app.dispatch({ action: 'createTask', requestId: `reject-resource-${index}`,
      input: { ...input(true), body: templateNote(body) } });
    assert.equal(rejected.status, 'error', `${body}: ${rejected.message}`);
    assert.equal(host.notes.size, count, 'validation must fail before creating a user task');
  }
  const allowed = await app.dispatch({ action: 'createTask', requestId: 'plain-note-link',
    input: { ...input(true), body: templateNote(`[查看资料](:/${noteId})`) } });
  assert.equal(allowed.status, 'saved', allowed.message);
  const snapshot = await app.snapshot();
  await app.dispatch({ action: 'complete', requestId: 'link-next', seriesId: allowed.seriesId,
    occurrenceId: snapshot.series[0]!.activeOccurrenceId });
  const after = await app.snapshot();
  const next = after.series[0]!.occurrences.find(row => row.occurrenceId === after.series[0]!.activeOccurrenceId)!;
  assert.equal(host.notes.get(next.carrierNoteId)!.body, `[查看资料](:/${noteId})`);
  assert.ok(host.resources.has(resourceId), 'rejecting template attachments must never delete user resources');
});

test('missing first task saves follower completion and resumes automatically once without recreating the anchor', async () => {
  const { host, app, options, setTime } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'missing-root-series', input: input(true) });
  const rootId = made.noteId!;
  const first = (await app.snapshot()).series[0]!.activeOccurrenceId;
  await app.dispatch({ action: 'complete', requestId: 'first-complete', seriesId: made.seriesId, occurrenceId: first });
  const before = await app.snapshot();
  const follower = before.series[0]!.occurrences.find(row => row.occurrenceId === before.series[0]!.activeOccurrenceId)!;
  const savedRoot = structuredClone(host.notes.get(rootId)!);
  host.notes.delete(rootId);
  await app.dispatch({ action: 'refresh', requestId: 'observe-anchor-404' });
  const callsAfterMissing = host.calls.length;
  const completedAt = Date.parse('2026-10-25T03:00:00Z'); setTime(completedAt);
  const result = await app.dispatch({ action: 'complete', requestId: 'complete-with-missing-root', noteId: follower.carrierNoteId,
    seriesId: made.seriesId, occurrenceId: follower.occurrenceId });
  assert.equal(result.status, 'saved', result.message);
  assert.equal(result.code, 'ANCHOR_MISSING_PENDING');
  assert.equal(host.notes.get(follower.carrierNoteId)!.todo_completed, completedAt);
  assert.equal(host.notes.get(follower.carrierNoteId)!.todo_due, 0);
  assert.equal(host.notes.size, 1);
  assert.equal(host.notes.has(rootId), false);
  assert.equal(Object.keys(namespace(host, follower.carrierNoteId)).filter(key => key.startsWith('v3:pending:')).length, 1);
  setTime(completedAt + 600000);
  await app.dispatch({ action: 'complete', requestId: 'repeat-missing-root-complete', noteId: follower.carrierNoteId,
    seriesId: made.seriesId, occurrenceId: follower.occurrenceId });
  assert.equal(host.notes.get(follower.carrierNoteId)!.todo_completed, completedAt);
  assert.equal(Object.keys(namespace(host, follower.carrierNoteId)).filter(key => key.startsWith('v3:pending:')).length, 1);
  assert.ok(!host.calls.slice(callsAfterMissing).some(call => call.method === 'post' && call.path[0] === 'notes' && call.body?.id === rootId));
  const pendingRestart = new TaskApplication(host, options); await pendingRestart.initialize();
  assert.equal(host.notes.get(follower.carrierNoteId)!.todo_completed, completedAt);
  assert.equal(host.notes.size, 1);

  host.notes.set(rootId, savedRoot);
  await pendingRestart.dispatch({ action: 'refresh', requestId: 'root-restored-not-yet-retried' });
  assert.equal(host.notes.size, 3, 'restoration and refresh automatically consume the pending completion once');
  const retry = await pendingRestart.dispatch({ action: 'retrySeries', requestId: 'retry-pending', seriesId: made.seriesId!, noteId: follower.carrierNoteId });
  assert.equal(retry.status, 'saved', retry.message);
  assert.equal(host.notes.size, 3);
  const restored = await pendingRestart.snapshot();
  assert.equal(restored.series[0]!.consumedCount, 2);
  const currentId = restored.series[0]!.activeOccurrenceId;
  await pendingRestart.dispatch({ action: 'retrySeries', requestId: 'retry-pending-again', seriesId: made.seriesId!, noteId: follower.carrierNoteId });
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  await restarted.dispatch({ action: 'retrySeries', requestId: 'retry-after-restart', seriesId: made.seriesId!, noteId: follower.carrierNoteId });
  const final = await restarted.snapshot();
  assert.equal(final.series[0]!.consumedCount, 2);
  assert.equal(final.series[0]!.activeOccurrenceId, currentId);
  assert.equal(host.notes.size, 3);
  assert.equal(host.notes.get(follower.carrierNoteId)!.todo_completed, completedAt);
});

test('normally consumed B history is not reclassified as a new pending completion when its first task disappears', async () => {
  const { host, app, setTime } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'consumed-history-root', input: input(true) });
  let series = (await app.snapshot()).series[0]!;
  await app.dispatch({ action: 'complete', requestId: 'consume-first', seriesId: made.seriesId, occurrenceId: series.activeOccurrenceId });
  series = (await app.snapshot()).series[0]!;
  const second = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!;
  setTime(Date.parse('2026-10-25T04:00:00Z'));
  await app.dispatch({ action: 'complete', requestId: 'consume-second', seriesId: made.seriesId, occurrenceId: second.occurrenceId });
  series = (await app.snapshot()).series[0]!;
  const third = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!;
  assert.ok(Object.keys(namespace(host, second.carrierNoteId)).some(key => key.startsWith('v3:consumed:')));
  host.notes.delete(made.noteId!);
  await app.dispatch({ action: 'refresh', requestId: 'missing-root-with-completed-history' });
  assert.equal(Object.keys(namespace(host, second.carrierNoteId)).filter(key => key.startsWith('v3:pending:')).length, 0);
  assert.equal(host.notes.get(third.carrierNoteId)!.todo_completed, 0);
  assert.ok(!(await app.snapshot()).diagnostics.some(row => row.code === 'ANCHOR_MISSING_PENDING'));
});

test('archive to continuous keeps the first anchor and does not recreate either deleted note', async () => {
  const { host, app, options, setTime } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'fixed-root', input: input(true) });
  await app.dispatch({ action: 'complete', requestId: 'fixed-first', seriesId: made.seriesId });
  let series = (await app.snapshot()).series[0]!;
  const carrier = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!.carrierNoteId;
  await app.dispatch({ action: 'switchMode', requestId: 'fixed-mode', seriesId: made.seriesId!, revisionId: series.definition!.revisionId, mode: 'continuous' });
  setTime(Date.parse('2026-10-25T04:00:00Z'));
  assert.equal((await app.dispatch({ action: 'complete', requestId: 'fixed-second', seriesId: made.seriesId })).status, 'saved');
  assert.equal((await app.snapshot()).series[0]!.anchorNoteId, made.noteId);
  host.notes.delete(made.noteId!);
  setTime(Date.parse('2026-10-26T04:00:00Z'));
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  const saved = await restarted.dispatch({ action: 'complete', requestId: 'first-missing', noteId: carrier });
  assert.equal(saved.code, 'ANCHOR_MISSING_PENDING');
  assert.equal(host.notes.size, 1);
  assert.ok(!host.notes.has(made.noteId!));
  host.notes.delete(carrier);
  const calls = host.calls.length;
  await restarted.dispatch({ action: 'refresh', requestId: 'both-deleted' });
  assert.equal(host.notes.size, 0);
  assert.ok(!host.calls.slice(calls).some(call => call.method === 'post' && call.path[0] === 'notes'));
});

test('an archive with all markers removed allows edits without copying execution as template', async () => {
  const { host, app } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'lost-all-markers', input: input(true) });
  const series = (await app.snapshot()).series[0]!;
  const plainExecution = '- [x] execution-only log that must never become a template';
  await host.data.put(['notes', made.noteId!], {}, { body: plainExecution });
  const before = host.notes.size;
  const revised = await app.dispatch({ action: 'reviseSeries', requestId: 'edit-archive-rule-without-source', seriesId: made.seriesId!,
    revisionId: series.definition!.revisionId, definition: { ...series.definition!, rule: { ...series.definition!.rule, interval: 2 } } });
  assert.equal(revised.status, 'saved', revised.message);
  assert.equal(host.notes.get(made.noteId!)!.body, plainExecution);
  assert.equal(host.notes.size, before);
  const switched = await app.dispatch({ action: 'switchMode', requestId: 'same-archive-without-source', seriesId: made.seriesId!,
    revisionId: (await app.snapshot()).series[0]!.definition!.revisionId, mode: 'archive' });
  assert.equal(switched.status, 'saved', switched.message);
  assert.equal(host.notes.get(made.noteId!)!.body, plainExecution);
});

test('pending import acknowledgement lost after archive advancement retries without another successor', async () => {
  const { host, app, setTime } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'pending-ack-root', input: input(true) });
  let series = (await app.snapshot()).series[0]!;
  await app.dispatch({ action: 'complete', requestId: 'pending-ack-first', seriesId: made.seriesId, occurrenceId: series.activeOccurrenceId });
  series = (await app.snapshot()).series[0]!;
  const current = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!;
  const root = structuredClone(host.notes.get(made.noteId!)!);
  host.notes.delete(made.noteId!);
  await app.dispatch({ action: 'refresh', requestId: 'pending-ack-missing' });
  setTime(Date.parse('2026-10-25T04:00:00Z'));
  const saved = await app.dispatch({ action: 'complete', requestId: 'pending-ack-complete', noteId: current.carrierNoteId });
  assert.equal(saved.code, 'ANCHOR_MISSING_PENDING');
  const pending = Object.entries(namespace(host, current.carrierNoteId)).find(([key]) => key.startsWith('v3:pending:'))![1].v;
  host.notes.set(made.noteId!, root);
  host.failNext('userDataSet', `${current.carrierNoteId}/v3:pending-imported:${pending.pendingId}`);
  await app.dispatch({ action: 'refresh', requestId: 'pending-ack-failure' });
  assert.ok((await app.snapshot()).diagnostics.some(item => item.seriesId === made.seriesId));
  const retry = await app.dispatch({ action: 'refresh', requestId: 'pending-ack-retry' });
  assert.equal(retry.status, 'saved', retry.message);
  const count = host.notes.size;
  assert.equal((await app.snapshot()).series[0]!.consumedCount, 2);
  await app.dispatch({ action: 'retrySeries', requestId: 'pending-ack-retry-again', seriesId: made.seriesId!, noteId: current.carrierNoteId });
  assert.equal(host.notes.size, count);
  assert.equal((await app.snapshot()).series[0]!.consumedCount, 2);
});

test('damaged archive source preserves native completion, then explicit repair and retry advances exactly once', async () => {
  const { host, app } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'damaged-source-root', input: input(true) });
  let series = (await app.snapshot()).series[0]!;
  const first = series.activeOccurrenceId;
  const damaged = '- [x] execution survives damaged template markers\n<!-- template:start -->';
  await host.data.put(['notes', made.noteId!], {}, { body: damaged });
  const completed = await app.dispatch({ action: 'complete', requestId: 'damaged-source-complete', seriesId: made.seriesId, occurrenceId: first });
  assert.equal(completed.status, 'saved', completed.message);
  assert.equal(completed.code, 'TEMPLATE_FORMAT');
  assert.equal(host.notes.get(made.noteId!)!.todo_completed, baseTime);
  assert.equal(host.notes.get(made.noteId!)!.body, damaged);
  assert.equal(host.notes.size, 1);
  await host.data.put(['notes', made.noteId!], {}, { body: buildArchiveBody(damaged.replace('\n<!-- template:start -->', ''), '- [x] repaired template') });
  const repaired = await app.dispatch({ action: 'retrySeries', requestId: 'damaged-source-retry', seriesId: made.seriesId! });
  assert.equal(repaired.status, 'saved', repaired.message);
  series = (await app.snapshot()).series[0]!;
  const current = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!;
  assert.equal(host.notes.get(current.carrierNoteId)!.body, '- [x] repaired template');
  assert.equal(series.consumedCount, 1);
  assert.equal(host.notes.size, 2);
  await app.dispatch({ action: 'retrySeries', requestId: 'damaged-source-retry-again', seriesId: made.seriesId! });
  assert.equal(host.notes.size, 2);
});

test('B-to-A preserves malformed first execution text and can continue without a template source', async () => {
  const { host, app, setTime } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'first-carrier-A', input: input(true) });
  const series = (await app.snapshot()).series[0]!;
  const switched = await app.dispatch({ action: 'switchMode', requestId: 'first-carrier-switch', seriesId: made.seriesId!, revisionId: series.definition!.revisionId, mode: 'continuous' });
  assert.equal(switched.status, 'saved', switched.message);
  const broken = buildArchiveBody('execution must survive', 'template must survive malformed cleanup').replace('template:end', 'template:broken');
  await host.data.put(['notes', made.noteId!], {}, { body: broken });
  const completed = await app.dispatch({ action: 'complete', requestId: 'malformed-switch-complete', noteId: made.noteId! });
  assert.equal(completed.status, 'saved', completed.message);
  assert.equal(host.notes.get(made.noteId!)!.body, broken);
  assert.equal(host.notes.size, 1);
  const after = (await app.snapshot()).series[0]!;
  assert.equal(after.consumedCount, 1);
  assert.equal(after.occurrences.find(row => row.occurrenceId === after.activeOccurrenceId)!.carrierNoteId, made.noteId);
  setTime(Date.parse('2026-10-25T04:00:00Z'));
  const again = await app.dispatch({ action: 'complete', requestId: 'malformed-A-next', noteId: made.noteId! });
  assert.equal(again.status, 'saved', again.message);
  assert.equal((await app.snapshot()).series[0]!.consumedCount, 2);
  assert.equal(host.notes.get(made.noteId!)!.body, broken);
});

test('continuous uses plain execution text, then real A-to-B initializes one same-note template source', async () => {
  const { host, app } = setup(); await app.initialize();
  const original = '- [x] existing continuous log\n- [ ] later step\n';
  const made = await app.dispatch({ action: 'createTask', requestId: 'plain-A-root', input: { ...input(true), mode: 'continuous', body: original } });
  assert.equal(made.status, 'saved', made.message);
  assert.equal(host.notes.get(made.noteId!)!.body, original);
  assert.equal(parseArchiveBody(host.notes.get(made.noteId!)!.body), null);
  let series = (await app.snapshot()).series[0]!;
  await host.data.put(['notes', made.noteId!], {}, { body: templateNote(original) });
  const switched = await app.dispatch({ action: 'switchMode', requestId: 'real-A-to-B', seriesId: made.seriesId!, revisionId: series.definition!.revisionId, mode: 'archive' });
  assert.equal(switched.status, 'saved', switched.message);
  const source = parseArchiveBody(host.notes.get(made.noteId!)!.body)!;
  assert.equal(source.prefix, original); assert.equal(source.templateBody, original);
  assert.equal(host.notes.size, 1);
  series = (await app.snapshot()).series[0]!;
  const completed = await app.dispatch({ action: 'complete', requestId: 'first-B-after-A', seriesId: made.seriesId, occurrenceId: series.activeOccurrenceId });
  assert.equal(completed.status, 'saved', completed.message);
  series = (await app.snapshot()).series[0]!;
  const next = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!;
  assert.notEqual(next.carrierNoteId, made.noteId);
  assert.equal(host.notes.get(next.carrierNoteId)!.body, original);
  assert.equal(parseArchiveBody(host.notes.get(next.carrierNoteId)!.body), null);
  assert.equal(host.notes.size, 2);
});

for (const stage of ['scope', 'operation'] as const) test(`a created root interrupted before ${stage} persistence resumes independently and scrubs input`, async () => {
  const { host, app, options } = setup(); await app.initialize();
  const set = host.data.userDataSet;
  let failed = false;
  host.data.userDataSet = async (type, id, key, value) => {
    if (!failed && key.startsWith(stage === 'scope' ? 'v3:scope:' : 'v3:op:')) { failed = true; throw new Error('root initialization interrupted'); }
    return set(type, id, key, value);
  };
  const original = '- [x] unique recovered root body\n原创建内容不可丢';
  const result = await app.dispatch({ action: 'createTask', requestId: `interrupted-root-${stage}`, input: { ...input(true), body: templateNote(original) } });
  assert.equal(result.status, 'error');
  assert.equal(failed, true); assert.equal(host.notes.size, 1);
  const id = [...host.notes.keys()][0]!;
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal(host.notes.size, 1);
  assert.equal(host.notes.has(id), true);
  assert.equal((await restarted.snapshot()).series.length, 1);
  const parsed = parseArchiveBody(host.notes.get(id)!.body)!;
  assert.equal(parsed.prefix, original + '\n'); assert.equal(parsed.templateBody, original);
  for (const value of host.settingsValues.values()) assert.ok(!JSON.stringify(value).includes('unique recovered root body'));
});

test('deleting an already POSTed but unfinished root prevents automatic recreation on recovery', async () => {
  const { host, app, options } = setup(); await app.initialize();
  const set = host.data.userDataSet;
  let failed = false;
  host.data.userDataSet = async (type, id, key, value) => {
    if (!failed && key.startsWith('v3:scope:')) { failed = true; throw new Error('root initialization interrupted'); }
    return set(type, id, key, value);
  };
  await app.dispatch({ action: 'createTask', requestId: 'deleted-unfinished-root', input: input(true) });
  assert.equal(host.notes.size, 1);
  const id = [...host.notes.keys()][0]!;
  host.notes.delete(id);
  const callsBefore = host.calls.length;
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  await restarted.dispatch({ action: 'refresh', requestId: 'refresh-deleted-unfinished' });
  assert.equal(host.notes.size, 0);
  assert.ok(!host.calls.slice(callsBefore).some(call => call.method === 'post' && call.path[0] === 'notes'));
});

test('late compatible rule fields on retired archive root remain read-only until retry merges them into the current context', async () => {
  const { operation } = await import('../fixtures/operations');
  const { host, app, setTime } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'late-app-root', input: input(true) });
  let series = (await app.snapshot()).series[0]!;
  await app.dispatch({ action: 'complete', requestId: 'late-app-first', seriesId: made.seriesId, occurrenceId: series.activeOccurrenceId });
  series = (await app.snapshot()).series[0]!;
  const carrier = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!.carrierNoteId;
  await app.dispatch({ action: 'switchMode', requestId: 'late-app-switch', seriesId: made.seriesId!, revisionId: series.definition!.revisionId, mode: 'continuous' });
  setTime(Date.parse('2026-10-25T04:00:00Z'));
  await app.dispatch({ action: 'complete', requestId: 'late-app-reanchor', noteId: carrier });
  await app.journal.reanchor(made.seriesId!, carrier, 'legacy-transfer-for-test');
  await app.dispatch({ action: 'refresh', requestId: 'consolidate-first' });
  await app.dispatch({ action: 'setFields', requestId: 'new-first-write', noteId: carrier, pinned: true });
  const rootData = namespace(host, made.noteId!);
  const create = Object.values(rootData).find(row => row.v?.kind === 'CreateSeries')!.v;
  const late = { ...operation('late-priority-app', 'SetTaskFields', { priority: 'high' }, [create.opId]), seriesId: made.seriesId! };
  await host.data.userDataSet(1, carrier, 'v3:op:' + encodeURIComponent(made.seriesId!) + ':' + late.opId, late);
  const beforeBodies = new Map([...host.notes].map(([id, note]) => [id, note.body]));
  await app.dispatch({ action: 'refresh', requestId: 'late-app-observe' });
  const paused = await app.snapshot();
  assert.ok(paused.diagnostics.some(row => row.code === 'CONTROL_READ_ONLY' && row.seriesId === made.seriesId));
  assert.ok(!Object.values(namespace(host, made.noteId!)).some(row => row.v?.opId === late.opId), 'refresh must not merge late operations into the fixed first anchor');
  const result = await app.dispatch({ action: 'retrySeries', requestId: 'late-app-retry', seriesId: made.seriesId! });
  assert.equal(result.status, 'saved', result.message);
  const after = await app.snapshot();
  assert.ok(after.tasks.some(row => row.noteId === carrier && row.priority === 'high'));
  assert.ok(!after.diagnostics.some(row => row.code === 'CONTROL_READ_ONLY' && row.seriesId === made.seriesId));
  for (const [id, body] of beforeBodies) assert.equal(host.notes.get(id)!.body, body);
});

test('archive enablement accepts no template and leaves plain execution unchanged', async () => {
  const { host, app } = setup(); await app.initialize();
  const plain = '- [x] existing execution without template markers';
  const created = await app.dispatch({ action: 'createTask', requestId: 'missing-pair-create', input: { ...input(true), body: plain } });
  assert.equal(created.status, 'saved', created.message);
  assert.equal(host.notes.get(created.noteId!)!.body, plain);
  assert.equal(host.notes.size, 1);
  host.seedNote({ id: 'plain-native', title: 'native title', parent_id: 'book', body: plain });
  await app.dispatch({ action: 'refresh', requestId: 'missing-pair-native' });
  const edited = await app.dispatch({ action: 'editTask', requestId: 'missing-pair-enable', noteId: 'plain-native', patch: {
    recurrence: input(true).recurrence, mode: 'archive', schedule: input().schedule,
  } });
  assert.equal(edited.status, 'saved', edited.message);
  assert.equal(host.notes.get('plain-native')!.body, plain);
  assert.equal(host.notes.size, 2);
});

test('native archive enablement after scope-write failure and a new request copies the template only once', async () => {
  const { host, app } = setup(); await app.initialize();
  const source = templateNote('- [x] one native template', 'existing execution\n', '\nuser suffix');
  host.seedNote({ id: 'enable-once', parent_id: 'book', title: 'native title', body: source });
  await app.dispatch({ action: 'refresh', requestId: 'enable-once-discover' });
  const set = host.data.userDataSet; let failed = false;
  host.data.userDataSet = async (type, id, key, value) => {
    if (!failed && key.startsWith('v3:scope:') && (value as any)?.role === 'series') { failed = true; throw new Error('series scope interrupted'); }
    return set(type, id, key, value);
  };
  const patch = { recurrence: input(true).recurrence, mode: 'archive' as const, schedule: input().schedule };
  const first = await app.dispatch({ action: 'editTask', requestId: 'enable-once-first', noteId: 'enable-once', patch });
  assert.equal(first.status, 'error'); assert.equal(failed, true);
  const initialized = host.notes.get('enable-once')!.body;
  assert.equal(initialized, initializeArchiveBody(source));
  const retry = await app.dispatch({ action: 'editTask', requestId: 'enable-once-second', noteId: 'enable-once', patch });
  assert.equal(retry.status, 'saved', retry.message);
  assert.equal(host.notes.get('enable-once')!.body, initialized);
  assert.equal(host.notes.size, 1);
});

test('A-to-B revision logging failure retries with a new request without copying native template twice', async () => {
  const { host, app } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'switch-once-root', input: { ...input(true), mode: 'continuous', body: 'plain A execution' } });
  await host.data.put(['notes', made.noteId!], {}, { body: templateNote('- [x] native A-to-B template', 'existing A execution\n') });
  const series = (await app.snapshot()).series[0]!;
  const set = host.data.userDataSet; let failed = false;
  host.data.userDataSet = async (type, id, key, value) => {
    if (!failed && key.startsWith('v3:op:') && (value as any)?.kind === 'ReviseSeries') { failed = true; throw new Error('revision interrupted'); }
    return set(type, id, key, value);
  };
  const command = { action: 'switchMode' as const, seriesId: made.seriesId!, revisionId: series.definition!.revisionId, mode: 'archive' as const };
  const first = await app.dispatch({ ...command, requestId: 'switch-once-first' });
  assert.equal(first.status, 'error'); assert.equal(failed, true);
  const initialized = host.notes.get(made.noteId!)!.body;
  const retry = await app.dispatch({ ...command, requestId: 'switch-once-second' });
  assert.equal(retry.status, 'saved', retry.message);
  assert.equal(host.notes.get(made.noteId!)!.body, initialized);
  assert.equal(initialized, templateNote('- [x] native A-to-B template', 'existing A execution\n- [x] native A-to-B template\n'));
});

test('native configure with a saved scope but failed CreateSeries retries under a new request as one active series', async () => {
  const { host, app } = setup(); await app.initialize();
  host.seedNote({ id: 'configure-op-once', parent_id: 'book', title: 'native title', body: templateNote('- [x] preserved template', 'execution log\n') });
  await app.dispatch({ action: 'refresh', requestId: 'configure-op-discover' });
  const set = host.data.userDataSet; let failed = false;
  host.data.userDataSet = async (type, id, key, value) => {
    if (!failed && key.startsWith('v3:op:') && (value as any)?.kind === 'CreateSeries') { failed = true; throw new Error('initial series operation interrupted'); }
    return set(type, id, key, value);
  };
  const patch = { recurrence: input(true).recurrence, mode: 'archive' as const, schedule: input().schedule };
  const first = await app.dispatch({ action: 'editTask', requestId: 'configure-op-first', noteId: 'configure-op-once', patch });
  assert.equal(first.status, 'error'); assert.equal(failed, true);
  const initialized = host.notes.get('configure-op-once')!.body;
  const retry = await app.dispatch({ action: 'editTask', requestId: 'configure-op-second', noteId: 'configure-op-once', patch });
  assert.equal(retry.status, 'saved', retry.message);
  const snapshot = await app.snapshot();
  assert.equal(snapshot.series.length, 1);
  assert.equal(snapshot.series[0]!.status, 'active');
  assert.equal(host.notes.get('configure-op-once')!.body, initialized);
  assert.equal(host.notes.size, 1);
  assert.ok(!snapshot.diagnostics.some(row => row.code === 'CONTROL_READ_ONLY'));
});
