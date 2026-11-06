import { initializeArchiveBody } from '../../src/domain/bodyTemplate';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';
import { templateNote } from '../support/template-note';
import { parseArchiveBody } from '../../src/domain/bodyTemplate';
import type { TaskInput } from '../../src/services/applicationTypes';

const now = Date.parse('2026-10-20T04:00:00Z');
const schedule = (date: string) => ({ kind: 'allDay' as const, date, zone: 'Asia/Shanghai' });
async function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: '原生公司' }); host.notebooks.set('other', { id: 'other', title: '原生家务' });
  let seq = 0; const options = { now: () => now, randomId: () => String(++seq).padStart(32, '0') };
  const app = new TaskApplication(host, options); await app.initialize(); await app.dispatch({ action: 'savePreferences', requestId: 'menu-language', preferences: { language: 'zh-CN' } }); return { host, app, options };
}
function recurring(): TaskInput {
  return { title: '每月十五日', body: templateNote('- [x] untouched template'), notebookId: 'book', schedule: schedule('2026-10-15'), mode: 'archive',
    recurrence: { calendar: 'gregorian', frequency: 'monthly', monthSelector: 'day', monthDay: 15, interval: 1, basis: 'scheduled', end: { kind: 'never' } } };
}
for (const action of ['changeDate'] as const) test(`${action} distinguishes changing the repeating anchor from postponing only this occurrence`, async () => {
  const { app } = await setup();
  const made = await app.dispatch({ action: 'createTask', requestId: action + '-create', input: recurring() });
  assert.equal(made.status, 'saved', made.message);
  const changed = await app.dispatch({ action, requestId: action + '-date', noteId: made.noteId!, schedule: schedule('2026-10-20') });
  assert.equal(changed.status, 'saved', changed.message);
  let series = (await app.snapshot()).series[0]!;
  assert.equal(series.definition!.anchor.date, '2026-10-15');
  const done = await app.dispatch({ action: 'complete', requestId: action + '-complete', noteId: made.noteId! });
  assert.equal(done.status, 'saved', done.message);
  series = (await app.snapshot()).series[0]!;
  assert.equal(series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!.scheduled.date, '2026-11-15');
});

test('abandon on the twentieth completes the native archived task once, annotates only execution, and preserves monthly fifteenth recurrence', async () => {
  const { host, app, options } = await setup();
  const made = await app.dispatch({ action: 'createTask', requestId: 'abandon-create', input: recurring() });
  const sourceBefore = parseArchiveBody(host.notes.get(made.noteId!)!.body)!.templateBody;
  const abandoned = await app.dispatch({ action: 'abandonTask', requestId: 'abandon-action', noteId: made.noteId! });
  assert.equal(abandoned.status, 'saved', abandoned.message);
  assert.equal(host.notes.get(made.noteId!)!.todo_completed, now);
  const firstBody = host.notes.get(made.noteId!)!.body;
  assert.equal(firstBody, initializeArchiveBody(recurring().body!));
  assert.equal(parseArchiveBody(firstBody)!.templateBody, sourceBefore);
  let series = (await app.snapshot()).series[0]!;
  assert.equal(series.definition!.anchor.date, '2026-10-15'); assert.equal(series.definition!.rule.monthDay, 15);
  const next = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!;
  assert.equal(next.scheduled.date, '2026-11-15');
  assert.equal(host.notes.get(next.carrierNoteId)!.body, sourceBefore);
  await app.dispatch({ action: 'abandonTask', requestId: 'abandon-action-new-request', noteId: made.noteId! });
  assert.equal(host.notes.get(made.noteId!)!.body, firstBody);
  assert.equal(host.notes.size, 2);
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  series = (await restarted.snapshot()).series[0]!;
  assert.equal(series.consumedCount, 1); assert.equal(series.activeOccurrenceId, next.occurrenceId);
});

test('single native task abandon is idempotent and move/date/defer work before plugin adoption', async () => {
  const { host, app } = await setup();
  host.seedNote({ id: 'native', parent_id: 'book', title: '原生TODO', body: '- [x] original native log' });
  await app.dispatch({ action: 'refresh', requestId: 'native-discover' });
  const moved = await app.dispatch({ action: 'moveTask', requestId: 'native-move', noteId: 'native', notebookId: 'other' });
  assert.equal(moved.status, 'saved', moved.message); assert.equal(host.notes.get('native')!.parent_id, 'other');
  assert.ok(host.calls.some(call => call.method === 'put' && call.path.join('/') === 'notes/native' && call.body.parent_id === 'other'));
  const dated = await app.dispatch({ action: 'changeDate', requestId: 'native-date', noteId: 'native', schedule: schedule('2026-10-20') });
  assert.equal(dated.status, 'saved', dated.message);
  assert.equal((await app.snapshot()).tasks.find(row => row.noteId === 'native')!.schedule.kind, 'allDay');
  const abandoned = await app.dispatch({ action: 'abandonTask', requestId: 'native-abandon', noteId: 'native' });
  assert.equal(abandoned.status, 'saved', abandoned.message);
  const body = host.notes.get('native')!.body;
  assert.ok(body.startsWith('- [x] original native log')); assert.equal(body, '- [x] original native log'); assert.equal(host.notes.get('native')!.todo_completed, now);
  await app.dispatch({ action: 'abandonTask', requestId: 'native-abandon-again', noteId: 'native' });
  assert.equal(host.notes.get('native')!.body, body);
  assert.equal(host.notes.size, 1);
});

test('native delete trashes only the selected carrier and never deletes siblings or recreates current after restart', async () => {
  const { host, app, options } = await setup();
  const made = await app.dispatch({ action: 'createTask', requestId: 'delete-create', input: recurring() });
  await app.dispatch({ action: 'complete', requestId: 'delete-first-done', noteId: made.noteId! });
  const series = (await app.snapshot()).series[0]!;
  const current = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!;
  const previousBody = host.notes.get(made.noteId!)!.body;
  const calls = host.calls.length;
  const deleted = await app.dispatch({ action: 'deleteNativeTask', requestId: 'delete-current', noteId: current.carrierNoteId });
  assert.equal(deleted.status, 'saved', deleted.message);
  const deletes = host.calls.slice(calls).filter(call => call.method === 'delete' && call.path[0] === 'notes');
  assert.equal(deletes.length, 1); assert.equal(deletes[0]!.path[1], current.carrierNoteId); assert.ok(!deletes[0]!.query?.permanent);
  assert.equal(host.notes.get(made.noteId!)!.body, previousBody);
  const restarted = new TaskApplication(host, options); await restarted.initialize(); await restarted.dispatch({ action: 'refresh', requestId: 'delete-refresh' });
  assert.ok(host.notes.get(current.carrierNoteId)!.deleted_time); assert.equal(host.notes.size, 2);
  assert.ok(!(await restarted.snapshot()).tasks.some(task => task.noteId === current.carrierNoteId));
  assert.equal((await restarted.snapshot()).series[0]!.status, 'waiting');
});

test('snapshot exposes existing native notebook and paginated tag names without creating categories', async () => {
  const { host, app } = await setup(); host.seedNote({ id: 'native-tags', parent_id: 'other', title: 'native tagged task' });
  for (let i = 0; i < 4; i++) host.tags.set(`tag${i}`, { id: `tag${i}`, title: `标签${i}` });
  host.noteTagIds.set('native-tags', new Set(['tag0', 'tag2', 'tag3']));
  await app.dispatch({ action: 'refresh', requestId: 'native-tags-refresh' });
  const snapshot = await app.snapshot({ view: 'inbox' });
  assert.deepEqual(snapshot.tasks.find(row => row.noteId === 'native-tags')!.tagIds, ['tag0', 'tag2', 'tag3']);
  assert.equal(snapshot.tags.length, 4); assert.ok(snapshot.folders.some(row => row.id === 'other' && row.title === '原生家务'));
  assert.equal(host.notes.size, 1); assert.equal(host.notebooks.size, 2);
});

test('an abandon annotation committed before a lost PUT response is reused rather than appended twice', async () => {
  const { host, app } = await setup();
  host.seedNote({ id: 'abandon-timeout', parent_id: 'book', title: 'native', body: 'user log' });
  await app.dispatch({ action: 'refresh', requestId: 'abandon-timeout-discover' });
  host.failNext('put', 'notes/abandon-timeout', true);
  const first = await app.dispatch({ action: 'abandonTask', requestId: 'abandon-timeout-first', noteId: 'abandon-timeout' });
  assert.equal(first.status, 'saved', first.message);
  const annotated = host.notes.get('abandon-timeout')!.body;
  assert.equal(annotated, 'user log');
  const retry = await app.dispatch({ action: 'abandonTask', requestId: 'abandon-timeout-second', noteId: 'abandon-timeout' });
  assert.equal(retry.status, 'saved', retry.message);
  assert.equal(host.notes.get('abandon-timeout')!.body, annotated);
  assert.equal(host.notes.get('abandon-timeout')!.todo_completed, now);
});

test('snapshot completed visibility follows local preference and explicit query overrides across restart', async () => {
  const { host, app, options } = await setup();
  const made = await app.dispatch({ action: 'createTask', requestId: 'completed-filter-create', input: { title: 'completed task', notebookId: 'book', schedule: schedule('2026-10-20') } });
  await app.dispatch({ action: 'complete', requestId: 'completed-filter-done', noteId: made.noteId! });
  assert.equal((await app.snapshot({ view: 'today', deviceZone: 'Asia/Shanghai' })).items.length, 0);
  assert.equal((await app.snapshot({ view: 'today', deviceZone: 'Asia/Shanghai', showCompleted: true })).items.length, 1);
  await app.dispatch({ action: 'savePreferences', requestId: 'completed-filter-preference', preferences: { showCompleted: true, lastView: 'day' } });
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal((await restarted.snapshot({ view: 'day', deviceZone: 'Asia/Shanghai', date: '2026-10-20' })).items.length, 1);
  assert.equal((await restarted.snapshot({ view: 'day', deviceZone: 'Asia/Shanghai', date: '2026-10-20', showCompleted: false })).items.length, 0);
  assert.equal(host.notes.size, 1);
});

test('permanent date changes preserve the daily workday filter and Friday completion advances to Monday', async () => {
  const { app } = await setup();
  const weekdays = [1, 2, 3, 4, 5];
  const made = await app.dispatch({ action: 'createTask', requestId: 'workday-create', input: {
    ...recurring(), schedule: schedule('2026-10-20'), recurrence: { calendar: 'gregorian', frequency: 'daily', weekdays,
      interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  assert.equal(made.status, 'saved', made.message);
  const changed = await app.dispatch({ action: 'changeDate', requestId: 'workday-friday', noteId: made.noteId!, schedule: schedule('2026-10-16') });
  assert.equal(changed.status, 'saved', changed.message);
  assert.deepEqual((await app.snapshot()).series[0]!.definition!.rule.weekdays, weekdays);
  const completed = await app.dispatch({ action: 'complete', requestId: 'workday-friday-complete', noteId: made.noteId! });
  assert.equal(completed.status, 'saved', completed.message);
  const series = (await app.snapshot()).series[0]!;
  assert.equal(series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!.scheduled.date, '2026-10-21');
  assert.deepEqual(series.definition!.rule.weekdays, weekdays);
});

test('abandon refuses a conflicting series before writing an abandonment annotation or native completion', async () => {
  const { stableHash } = await import('../../src/domain/identity');
  const { host, app } = await setup();
  const made = await app.dispatch({ action: 'createTask', requestId: 'abandon-conflict-create', input: recurring() });
  const definition = (await app.snapshot()).series[0]!.definition!;
  for (const [id, interval] of [['conflict-A', 2], ['conflict-B', 3]] as const) {
    const payload = { definition: { ...definition, revisionId: id, parentRevisionIds: [definition.revisionId], rule: { ...definition.rule, interval } } };
    const op = { schemaVersion: 1, opId: id, deviceId: id, deviceSeq: 1, seriesId: made.seriesId!, parents: [definition.revisionId], recordedAt: now,
      kind: 'ReviseSeries', payload, payloadHash: stableHash(payload) };
    await host.data.userDataSet(1, made.noteId!, `v3:op:${encodeURIComponent(made.seriesId!)}:${id}`, op);
  }
  await app.dispatch({ action: 'refresh', requestId: 'abandon-conflict-observe' });
  assert.equal((await app.snapshot()).series[0]!.status, 'pausedConflict');
  const original = host.notes.get(made.noteId!)!.body;
  const calls = host.calls.length;
  const rejected = await app.dispatch({ action: 'abandonTask', requestId: 'abandon-conflict-refuse', noteId: made.noteId! });
  assert.notEqual(rejected.status, 'saved');
  assert.equal(host.notes.get(made.noteId!)!.body, original);
  assert.equal(host.notes.get(made.noteId!)!.todo_completed, 0);
  assert.ok(!host.calls.slice(calls).some(call => call.method === 'put' && call.path.join('/') === `notes/${made.noteId}`));
});

test('native editing during abandon read/append interval is preserved and NOTE_CHANGED prevents completion', async () => {
  const { host, app } = await setup();
  const made = await app.dispatch({ action: 'createTask', requestId: 'abandon-race-create', input: recurring() });
  const get = host.data.get; let reads = 0;
  const edited = 'new user execution log\n' + templateNote('- [x] native template remains');
  host.data.get = async (path, query) => {
    if (path[0] === 'notes' && path[1] === made.noteId && path.length === 2 && ++reads === 2) host.notes.get(made.noteId!)!.body = edited;
    return get(path, query);
  };
  const rejected = await app.dispatch({ action: 'abandonTask', requestId: 'abandon-race-refuse', noteId: made.noteId! });
  assert.equal(rejected.status, 'saved', rejected.message);
  assert.equal(host.notes.get(made.noteId!)!.body, edited);
  assert.equal(host.notes.get(made.noteId!)!.todo_completed, now);
  assert.ok(!host.notes.get(made.noteId!)!.body.includes('journey-tasks:abandon:'));
  assert.equal(host.notes.size, 2);
});

test('legacy overdue preferences cannot hide overdue tasks after restart', async () => {
  const { host, app, options } = await setup();
  const past = await app.dispatch({ action: 'createTask', requestId: 'past', input: { title: 'past', notebookId: 'book', schedule: schedule('2025-01-01') } });
  await app.dispatch({ action: 'savePreferences', requestId: 'old-settings', preferences: { overdueToday: false, overdueTomorrow: false, overdueSeven: false } });
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  for (const view of ['today', 'tomorrow', 'sevenDays', 'all'] as const) {
    const snapshot = await restarted.snapshot({ view, date: '2027-01-01', deviceZone: 'Asia/Shanghai' });
    assert.ok(snapshot.items.some(row => row.noteId === past.noteId && row.overdue), view);
  }
  const inbox = await restarted.snapshot({ view: 'inbox' });
  assert.ok(!inbox.items.some(row => row.noteId === past.noteId));
});

for (const mode of ['continuous', 'archive'] as const) test(`${mode} history deletion preserves execution and recurrence across restart`, async () => {
  const { host, app, options } = await setup();
  const made = await app.dispatch({ action: 'createTask', requestId: 'history-create', input: {
    ...recurring(), mode, schedule: schedule('2026-10-17'),
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  assert.equal(made.status, 'saved', made.message);
  for (let i = 0; i < 2; i++) {
    const snapshot = await app.snapshot();
    const result = await app.dispatch({ action: 'complete', requestId: `history-done-${i}`, seriesId: made.seriesId, occurrenceId: snapshot.series[0]!.activeOccurrenceId });
    assert.equal(result.status, 'saved', result.message);
  }
  const before = await app.snapshot({ showCompleted: true });
  const history = before.series[0]!.occurrences.find(row => row.predecessorId && row.consumed)!;
  const currentId = before.series[0]!.activeOccurrenceId;
  const current = before.series[0]!.occurrences.find(row => row.occurrenceId === currentId)!;
  const body = host.notes.get(current.carrierNoteId)!.body;
  const deleted = await app.dispatch({ action: 'deleteNativeTask', requestId: 'history-delete', noteId: history.carrierNoteId, occurrenceId: history.occurrenceId });
  assert.equal(deleted.status, 'saved', deleted.message);
  assert.equal(!!host.notes.get(history.carrierNoteId)!.deleted_time, mode === 'archive');
  assert.equal(host.notes.get(current.carrierNoteId)!.body, body);
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  const after = await restarted.snapshot({ showCompleted: true });
  assert.equal(after.series[0]!.status, 'active');
  assert.equal(after.series[0]!.activeOccurrenceId, currentId);
  assert.equal(after.series[0]!.consumedCount, 2);
  assert.equal(after.series[0]!.occurrences.find(row => row.occurrenceId === history.occurrenceId)!.resolution, 'completed');
  assert.ok(!after.tasks.some(row => row.occurrenceId === history.occurrenceId));
  assert.ok(!after.items.some(row => row.occurrenceId === history.occurrenceId));
  const done = await restarted.dispatch({ action: 'complete', requestId: 'history-next', seriesId: made.seriesId, occurrenceId: currentId });
  assert.equal(done.status, 'saved', done.message);
  assert.equal((await restarted.snapshot()).series[0]!.consumedCount, 3);
});

test('deleting archived first history pauses for anchor recovery without recording a series stop', async () => {
  const { host, app, options } = await setup();
  const made = await app.dispatch({ action: 'createTask', requestId: 'anchor-create', input: { ...recurring(), schedule: schedule('2026-10-17'), recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } } } });
  const first = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({ action: 'complete', requestId: 'anchor-complete', seriesId: made.seriesId, occurrenceId: first });
  const backup = structuredClone(host.notes.get(made.noteId!)!);
  const current = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  const deleted = await app.dispatch({ action: 'deleteNativeTask', requestId: 'anchor-delete', noteId: made.noteId!, occurrenceId: first });
  assert.equal(deleted.status, 'saved', deleted.message);
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal((await restarted.snapshot()).series.length, 0);
  const done = await restarted.dispatch({ action: 'complete', requestId: 'anchor-next', seriesId: made.seriesId, occurrenceId: current });
  assert.equal(done.status, 'saved', done.message);
  assert.equal(done.code, 'ANCHOR_MISSING_PENDING');
  host.notes.set(backup.id, backup);
  await restarted.dispatch({ action: 'refresh', requestId: 'anchor-restored' });
  const retry = await restarted.dispatch({ action: 'retrySeries', requestId: 'anchor-retry', seriesId: made.seriesId! });
  assert.equal(retry.status, 'saved', retry.message);
  const after = await restarted.snapshot();
  assert.equal(after.series[0]!.status, 'active');
  assert.equal(after.series[0]!.consumedCount, 2);
});


test('delete rejects an occurrence belonging to a different note before changing the series', async () => {
  const { app, host } = await setup();
  const made = await app.dispatch({ action: 'createTask', requestId: 'mismatch-create', input: recurring() });
  const first = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({ action: 'complete', requestId: 'mismatch-done', seriesId: made.seriesId, occurrenceId: first });
  const current = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  const deleted = await app.dispatch({ action: 'deleteNativeTask', requestId: 'mismatch-delete', noteId: made.noteId!, occurrenceId: current });
  assert.equal(deleted.status, 'error');
  assert.equal(deleted.code, 'OCCURRENCE_MISSING');
  assert.ok(host.notes.has(made.noteId!));
  assert.equal((await app.snapshot()).series[0]!.status, 'active');
});
