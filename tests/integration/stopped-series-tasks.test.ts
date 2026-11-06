import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import type { DatedSchedule } from '../../src/shared/models';
import { MemoryJoplin } from '../support/memory-joplin';

const schedule = (kind: 'allDay' | 'timed', date: string): DatedSchedule => kind === 'allDay'
  ? { kind, date, zone: 'UTC' }
  : { kind, date, time: '14:30', zone: 'UTC', instant: Date.parse(`${date}T14:30:00Z`) };

async function setup(kind: 'allDay' | 'timed' = 'allDay', reminder = false, periods = 1, reuse = false) {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  for (const id of ['A', 'B']) host.notebooks.set(id, { id, title: id });
  let sequence = 0;
  const options = { now: () => Date.parse('2026-11-10T18:00:00Z'),
    randomId: () => (++sequence).toString(16).padStart(32, '0') };
  const app = new TaskApplication(host, options); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'create', input: {
    title: 'Keep my schedule', notebookId: 'A', mode: 'archive', priority: 'high',
    schedule: schedule(kind, '2026-11-04'), reminder: { enabled: reminder, allDayTime: '09:00' },
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  assert.equal(made.status, 'saved', made.message);
  let currentId = made.noteId!;
  for (let i = 0; i < periods; i++) {
    assert.equal((await app.dispatch({ action: 'complete', requestId: `complete-${i}`, noteId: currentId })).status, 'saved');
    const series = (await app.snapshot()).series[0]!;
    currentId = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!.carrierNoteId;
    if (reuse && i === 0) assert.equal((await app.dispatch({ action: 'switchMode', requestId: 'reuse', seriesId: made.seriesId!,
      revisionId: series.definition!.revisionId, mode: 'continuous' })).status, 'saved');
  }
  assert.equal((await app.dispatch({ action: 'changeDate', requestId: 'defer', noteId: currentId,
    schedule: schedule(kind, '2026-11-08') })).status, 'saved');
  assert.equal((await app.dispatch({ action: 'setFields', requestId: 'pin', noteId: currentId, pinned: true })).status, 'saved');
  const stopped = await app.dispatch({ action: 'deleteTask', requestId: 'stop', noteId: currentId, seriesId: made.seriesId, scope: 'stop' });
  assert.equal(stopped.status, 'saved', stopped.message);
  return { host, app, options, rootId: made.noteId!, currentId, seriesId: made.seriesId! };
}

for (const kind of ['allDay', 'timed'] as const) for (const reminder of [false, true]) for (const permanent of [false, true]) {
  test(`${kind}, reminder=${reminder}, permanent=${permanent}: stopped tasks keep the latest date after first-note deletion and restart`, async () => {
    const { host, app, options, rootId, currentId } = await setup(kind, reminder);
    const before = (await app.snapshot({ view: 'all' })).tasks.find(task => task.noteId === currentId)!;
    const native = structuredClone(host.notes.get(currentId)!);
    if (permanent) host.notes.delete(rootId); else host.notes.get(rootId)!.deleted_time = 123;
    await app.dispatch({ action: 'refresh', requestId: 'delete-first' });
    const restarted = new TaskApplication(host, options); await restarted.initialize();
    for (const target of [app, restarted]) {
      const snapshot = await target.snapshot({ view: 'day', date: '2026-11-08', deviceZone: 'UTC' });
      const task = snapshot.tasks.find(task => task.noteId === currentId)!;
      assert.deepEqual(task.schedule, before.schedule, 'must retain the deferred date, not initial carrier metadata');
      assert.equal(task.priority, before.priority);
      assert.equal(task.pinned, before.pinned);
      assert.equal(task.completedAt, 0);
      assert.equal(snapshot.items.filter(item => item.noteId === currentId).length, 1);
      assert.ok(!(await target.snapshot({ view: 'inbox' })).items.some(item => item.noteId === currentId));
      assert.equal(snapshot.diagnostics.length, 0);
    }
    for (const key of ['body', 'todo_due', 'todo_completed', 'parent_id']) assert.deepEqual(host.notes.get(currentId)![key], native[key], key);
    assert.equal(host.notes.size, permanent ? 1 : 2);
  });
}

test('stopped task edits and completion survive restoring and permanently deleting the first note', async () => {
  const { host, app, options, rootId, currentId, seriesId } = await setup('timed');
  const first = structuredClone(host.notes.get(rootId)!);
  host.notes.get(rootId)!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'delete-first' });
  assert.equal((await app.dispatch({ action: 'changeDate', requestId: 'independent-date', noteId: currentId,
    schedule: schedule('allDay', '2026-11-09') })).status, 'saved');
  assert.equal((await app.dispatch({ action: 'setFields', requestId: 'independent-priority', noteId: currentId, priority: 'low' })).status, 'saved');
  assert.equal((await app.dispatch({ action: 'moveTask', requestId: 'move', noteId: currentId, notebookId: 'B' })).status, 'saved');
  assert.equal((await app.dispatch({ action: 'complete', requestId: 'independent-complete', noteId: currentId })).status, 'saved');
  assert.equal(host.notes.size, 2, 'completion of a stopped task cannot create a successor');
  host.notes.set(rootId, first);
  await app.dispatch({ action: 'refresh', requestId: 'restore-first' });
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  const snapshot = await restarted.snapshot({ view: 'day', date: '2026-11-09', deviceZone: 'UTC', showCompleted: true });
  const tasks = snapshot.tasks.filter(task => task.noteId === currentId);
  assert.equal(tasks.length, 1, 'restoration must not show both series and independent copies');
  assert.deepEqual(tasks[0]!.schedule, schedule('allDay', '2026-11-09'));
  assert.equal(tasks[0]!.priority, 'low');
  assert.equal(tasks[0]!.notebookId, 'B');
  assert.ok(tasks[0]!.completedAt);
  assert.equal(snapshot.series.find(series => series.seriesId === seriesId)!.status, 'ended');
  assert.equal(snapshot.items.filter(item => item.noteId === currentId).length, 1);
  host.notes.delete(rootId);
  await restarted.dispatch({ action: 'refresh', requestId: 'purged-first' });
  assert.equal((await restarted.snapshot()).tasks.find(task => task.noteId === currentId)!.schedule.kind, 'allDay');
  assert.equal(host.notes.size, 1);
  const again = new TaskApplication(host, options); await again.initialize();
  assert.deepEqual((await again.snapshot()).tasks.find(task => task.noteId === currentId)!.schedule, schedule('allDay', '2026-11-09'));
});

test('already stopped series are backfilled from their first note in Trash using their latest schedule', async () => {
  const { host, app, options, rootId, currentId } = await setup();
  // Version 816203c wrote only a status receipt; no schedule was stored there.
  const data = JSON.parse(host.notes.get(currentId)!.user_data);
  for (const key of Object.keys(data[DEFAULT_PLUGIN_ID])) if (key.startsWith('v3:ended:')) {
    delete data[DEFAULT_PLUGIN_ID][key].v.tasks;
    delete data[DEFAULT_PLUGIN_ID][key].v.ownerTaskId;
  }
  host.notes.get(currentId)!.user_data = JSON.stringify(data);
  host.notes.get(rootId)!.deleted_time = 123;
  app.dispose();
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.deepEqual((await restarted.snapshot()).tasks.find(task => task.noteId === currentId)!.schedule, schedule('allDay', '2026-11-08'));
  host.notes.delete(rootId);
  const purged = new TaskApplication(host, options); await purged.initialize();
  assert.deepEqual((await purged.snapshot()).tasks.find(task => task.noteId === currentId)!.schedule, schedule('allDay', '2026-11-08'));
});

test('completed generated history notes keep their dates and completion after the first note is deleted', async () => {
  const { host, app, options, rootId, currentId } = await setup('allDay', false, 2);
  const history = [...host.notes.keys()].find(id => id !== rootId && id !== currentId)!;
  const completedAt = host.notes.get(history)!.todo_completed;
  host.notes.delete(rootId);
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  const snapshot = await restarted.snapshot({ view: 'day', date: '2026-11-05', deviceZone: 'UTC', showCompleted: true });
  assert.equal(snapshot.items.filter(item => item.noteId === history).length, 1);
  assert.equal(snapshot.tasks.find(task => task.noteId === history)!.completedAt, completedAt);
  assert.equal(snapshot.tasks.find(task => task.noteId === history)!.schedule.kind, 'allDay');
  assert.ok(!(await restarted.snapshot({ view: 'inbox', showCompleted: true })).items.some(item => item.noteId === history));
});

test('legacy completed history can be backfilled when the stopped current task has also been deleted', async () => {
  const { host, options, rootId, currentId } = await setup('allDay', false, 2);
  const history = [...host.notes.keys()].find(id => id !== rootId && id !== currentId)!;
  const data = JSON.parse(host.notes.get(history)!.user_data);
  for (const key of Object.keys(data[DEFAULT_PLUGIN_ID])) if (key.startsWith('v3:ended:')) {
    delete data[DEFAULT_PLUGIN_ID][key].v.tasks;
    delete data[DEFAULT_PLUGIN_ID][key].v.ownerTaskId;
  }
  host.notes.get(history)!.user_data = JSON.stringify(data);
  host.notes.delete(currentId); host.notes.get(rootId)!.deleted_time = 123;
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  const snapshot = await restarted.snapshot({ view: 'day', date: '2026-11-05', deviceZone: 'UTC', showCompleted: true });
  assert.equal(snapshot.items.filter(item => item.noteId === history).length, 1);
  assert.ok(snapshot.tasks.find(task => task.noteId === history)!.completedAt);
});


test('shared-carrier history keeps its dates without letting an old cycle reopen the independent stopped task', async () => {
  const { host, app, rootId, currentId } = await setup('allDay', false, 2, true);
  host.notes.delete(rootId);
  await app.dispatch({ action: 'refresh', requestId: 'delete-first' });
  const snapshot = await app.snapshot({ view: 'all', showCompleted: true });
  const history = snapshot.tasks.find(task => task.noteId === currentId && task.historical)!;
  assert.ok(history);
  assert.deepEqual(history.schedule, schedule('allDay', '2026-11-05'));
  const done = await app.dispatch({ action: 'complete', requestId: 'independent', noteId: currentId });
  assert.equal(done.status, 'saved', done.message);
  const completedAt = host.notes.get(currentId)!.todo_completed;
  const reopened = await app.dispatch({ action: 'reopen', requestId: 'old-cycle', noteId: currentId, occurrenceId: history.occurrenceId });
  assert.equal(reopened.code, 'HISTORICAL_TASK');
  assert.equal(host.notes.get(currentId)!.todo_completed, completedAt);
  assert.equal(host.notes.size, 1);
});
