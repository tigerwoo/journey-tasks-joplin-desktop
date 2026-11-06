import { initializeArchiveBody } from '../../src/domain/bodyTemplate';
import test from 'node:test';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';
import type { TaskInput } from '../../src/services/applicationTypes';

function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID; host.notebooks.set('book', { id: 'book', title: '工作' });
  let now = Date.parse('2026-10-28T04:00:00Z'), seq = 0;
  const notices: string[] = [];
  const makeApp = () => new TaskApplication(host, { now: () => now, randomId: () => String(++seq).padStart(32, '0'), onNotice: message => notices.push(message) });
  const app = makeApp();
  const input = (mode: 'archive' | 'continuous' = 'archive'): TaskInput => ({ title: '任务', notebookId: 'book', body: '原文\n<!-- template:start -->\n清单\n<!-- template:end -->',
    schedule: { kind: 'allDay', date: '2026-10-28', zone: 'Asia/Shanghai' }, reminder: { enabled: true }, mode,
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } } });
  return { host, app, input, makeApp, notices, day: (day: number) => { now = Date.parse(`2026-10-${day}T04:00:00Z`); } };
}
for (const mode of ['archive', 'continuous'] as const) test(`${mode}: latest undo preserves successor, redo reuses content across restart`, async () => {
  const { host, app, input, makeApp, notices } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: input(mode) });
  const original = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  assert.equal((await app.dispatch({ action: 'complete', requestId: 'done', seriesId: created.seriesId, occurrenceId: original })).status, 'saved');
  const next = (await app.snapshot()).series[0]!.occurrences.find(o => o.occurrenceId !== original)!;
  const count = host.notes.size;
  await host.data.put(['notes', next.carrierNoteId], {}, { body: '用户在下一期修改的内容' });
  const undo = await app.dispatch({ action: 'reopen', requestId: 'undo', seriesId: created.seriesId, occurrenceId: original }); assert.equal(undo.status, 'saved', undo.message);
  const snapshot = await app.snapshot({ view: 'month', date: '2026-10-28' });
  assert.equal(snapshot.series[0]!.activeOccurrenceId, next.occurrenceId);
  assert.equal(snapshot.series[0]!.consumedCount, 1);
  assert.ok(snapshot.items.some(i => i.kind === 'actual' && i.date === '2026-10-29'));
  assert.equal(snapshot.tasks.filter(t => !t.completedAt && !t.historical).length, 1);
  assert.ok(host.notes.get(next.carrierNoteId)!.todo_due);
  assert.equal(host.notes.get(next.carrierNoteId)!.body, '用户在下一期修改的内容');
  const restarted = makeApp(); await restarted.initialize();
  const redo = await restarted.dispatch({ action: 'complete', requestId: 'redo', seriesId: created.seriesId, occurrenceId: original });
  assert.equal(redo.status, 'saved', redo.message);
  assert.equal((await restarted.snapshot()).series[0]!.activeOccurrenceId, next.occurrenceId);
  assert.equal(host.notes.size, count);
  assert.equal(host.notes.get(next.carrierNoteId)!.body, '用户在下一期修改的内容');
  assert.equal(host.notes.get(next.carrierNoteId)!.todo_completed, 0);
  assert.equal((await restarted.snapshot()).series[0]!.occurrences.find(o => o.occurrenceId === original)!.resolution, 'completed');
  assert.deepEqual(notices, []);
});
for (const overdue of [false, true]) test(`issue 65: continuous redo has no false notice (${overdue ? 'overdue' : 'today'})`, async () => {
  const { host, app, input, day, notices } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: input('continuous') });
  // Exercise the same undo/redo path when the original cycle is overdue.
  if (overdue) day(30);
  const original = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({ action: 'complete', requestId: 'done', seriesId: created.seriesId });
  const successor = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await app.dispatch({ action: 'reopen', requestId: `undo-${attempt}`, seriesId: created.seriesId, occurrenceId: original })).status, 'saved');
    assert.equal((await app.dispatch({ action: 'complete', requestId: `redo-${attempt}`, seriesId: created.seriesId, occurrenceId: original })).status, 'saved');
    const snapshot = await app.snapshot();
    assert.equal(snapshot.series[0]!.activeOccurrenceId, successor);
    assert.equal(snapshot.series[0]!.occurrences.find(o => o.occurrenceId === original)!.resolution, 'completed');
    assert.equal(host.notes.get(created.noteId!)!.todo_completed, 0);
    assert.deepEqual(notices, []);
  }
  // A native completion timestamp before the successor date must still be rejected.
  await host.data.put(['notes', created.noteId!], {}, { todo_completed: Date.parse('2026-10-28T05:00:00Z') });
  await app.dispatch({ action: 'refresh', requestId: 'native-future' });
  assert.equal(host.notes.get(created.noteId!)!.todo_completed, 0);
  assert.equal(notices.length, 1);
});
for (const mode of ['archive', 'continuous'] as const) test(`${mode}: future complete/abandon rejected; native future check corrected without touching content`, async () => {
  const { host, app, input, notices } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: input(mode) });
  await app.dispatch({ action: 'complete', requestId: 'done', seriesId: created.seriesId });
  const snap = await app.snapshot(), cycle = snap.series[0]!.occurrences.find(o => o.occurrenceId === snap.series[0]!.activeOccurrenceId)!;
  const body = host.notes.get(cycle.carrierNoteId)!.body, count = host.notes.size;
  assert.equal((await app.dispatch({ action: 'complete', requestId: 'future', seriesId: created.seriesId })).code, 'FUTURE_TASK');
  assert.equal((await app.dispatch({ action: 'abandonTask', requestId: 'abandon', noteId: cycle.carrierNoteId })).code, 'FUTURE_TASK');
  await host.data.put(['notes', cycle.carrierNoteId], {}, { todo_completed: Date.parse('2026-10-28T05:00:00Z') });
  await app.dispatch({ action: 'refresh', requestId: 'native-refresh' });
  assert.equal(host.notes.get(cycle.carrierNoteId)!.todo_completed, 0);
  assert.equal(host.notes.get(cycle.carrierNoteId)!.body, body);
  assert.equal(host.notes.size, count); assert.equal(notices.length, 1);
  const corrected = await app.snapshot();
  assert.ok(!corrected.diagnostics.some(d => d.code === 'FUTURE_TASK_RESET'));
  assert.ok(!corrected.warnings.includes(notices[0]!));
  await app.dispatch({ action: 'refresh', requestId: 'refresh-again' }); assert.equal(notices.length, 1);
});
test('older history undo and redo do not rewind current; native latest undo also preserves it', async () => {
  const { host, app, input, day } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: input() });
  const a = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({ action: 'complete', requestId: 'done-a', seriesId: created.seriesId }); day(29);
  const b = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({ action: 'complete', requestId: 'done-b', seriesId: created.seriesId });
  const c = (await app.snapshot()).series[0]!.activeOccurrenceId;
  await app.dispatch({ action: 'reopen', requestId: 'undo-a', seriesId: created.seriesId, occurrenceId: a });
  assert.equal((await app.snapshot()).series[0]!.activeOccurrenceId, c);
  await app.dispatch({ action: 'complete', requestId: 'redo-a', seriesId: created.seriesId, occurrenceId: a });
  assert.equal((await app.snapshot()).series[0]!.activeOccurrenceId, c);
  const note = (await app.snapshot()).series[0]!.occurrences.find(o => o.occurrenceId === b)!.carrierNoteId;
  await host.data.put(['notes', note], {}, { todo_completed: 0 });
  await app.dispatch({ action: 'refresh', requestId: 'native-undo' });
  assert.equal((await app.snapshot()).series[0]!.activeOccurrenceId, c);
});
test('changing current date preserves rule; abandonment and configuration preserve body', async () => {
  const { host, app, input } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: input() });
  assert.equal(host.notes.get(created.noteId!)!.body, initializeArchiveBody(input().body!));
  const before = (await app.snapshot()).series[0]!.definition!;
  await app.dispatch({ action: 'changeDate', requestId: 'date', noteId: created.noteId!, schedule: { kind: 'allDay', date: '2026-10-27', zone: 'Asia/Shanghai' } });
  assert.deepEqual((await app.snapshot()).series[0]!.definition, before);
  const abandoned = await app.dispatch({ action: 'abandonTask', requestId: 'abandon', noteId: created.noteId! });
  assert.equal(abandoned.status, 'saved', abandoned.message);
  assert.equal(host.notes.get(created.noteId!)!.body, initializeArchiveBody(input().body!));
  assert.equal(host.notes.get(created.noteId!)!.is_todo, 1);
  assert.ok(host.notes.get(created.noteId!)!.todo_completed);
});
test('native early completion discovered after its planned day is still rejected using completion date', async () => {
  const { host, app, input, day, notices } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: input() });
  await app.dispatch({ action: 'complete', requestId: 'done', seriesId: created.seriesId });
  const series = (await app.snapshot()).series[0]!, b = series.occurrences.find(o => o.occurrenceId === series.activeOccurrenceId)!;
  await host.data.put(['notes', b.carrierNoteId], {}, { todo_completed: Date.parse('2026-10-28T06:00:00Z') });
  day(30);
  await app.dispatch({ action: 'refresh', requestId: 'delayed-sync' });
  assert.equal(host.notes.get(b.carrierNoteId)!.todo_completed, 0); assert.equal(host.notes.size, 2); assert.equal(notices.length, 1);
});
test('ordinary future task cannot complete until its date is explicitly changed', async () => {
  const { app, input } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: { ...input(), recurrence: undefined, schedule: { kind: 'allDay', date: '2026-10-29', zone: 'Asia/Shanghai' } } });
  assert.equal((await app.dispatch({ action: 'complete', requestId: 'early', noteId: created.noteId! })).code, 'FUTURE_TASK');
  await app.dispatch({ action: 'changeDate', requestId: 'date', noteId: created.noteId!, schedule: input().schedule });
  assert.equal((await app.dispatch({ action: 'complete', requestId: 'done', noteId: created.noteId! })).status, 'saved');
});
test('explicit current date preserves the period while new rules update future previews', async () => {
  const { host, app, input } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: input() });
  await app.dispatch({ action: 'complete', requestId: 'done', seriesId: created.seriesId });
  const series = (await app.snapshot()).series[0]!, current = series.occurrences.find(o => o.occurrenceId === series.activeOccurrenceId)!;
  const body = host.notes.get(current.carrierNoteId)!.body;
  const revised = await app.dispatch({ action: 'reviseSeries', requestId: 'revise', seriesId: created.seriesId!, revisionId: series.definition!.revisionId,
    currentSchedule: current.scheduled, definition: { ...series.definition!, anchor: current.scheduled, rule: { ...series.definition!.rule, frequency: 'weekly', weekdays: [1] } } });
  assert.equal(revised.status, 'saved', revised.message);
  const after = await app.snapshot({ view: 'month', date: '2026-11-02' });
  assert.equal(after.series[0]!.occurrences.find(o => o.occurrenceId === current.occurrenceId)!.scheduled.date, '2026-11-02');
  assert.equal(after.series[0]!.occurrences.find(o => o.occurrenceId === current.occurrenceId)!.deferred?.date, '2026-10-29');
  assert.equal(after.series[0]!.occurrences[0]!.scheduled.date, '2026-10-28');
  assert.ok(!after.items.some(i => i.kind === 'projected' && i.date === '2026-11-02'));
  assert.ok(after.items.some(i => i.kind === 'projected' && i.date === '2026-11-09'));
  assert.equal(host.notes.get(current.carrierNoteId)!.body, body);
});
test('lost acknowledgement of reopening preserves successor across restart', async () => {
  const { host, app, input, makeApp } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: input() });
  const a = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({ action: 'complete', requestId: 'done', seriesId: created.seriesId });
  const set = host.data.userDataSet; let failed = false;
  host.data.userDataSet = async (type, id, key, value) => { await set(type, id, key, value); if (!failed && (value as any)?.kind === 'ActOccurrence' && (value as any)?.payload?.action === 'reopen') { failed = true; throw new Error('lost rewind acknowledgement'); } };
  await app.dispatch({ action: 'reopen', requestId: 'undo', seriesId: created.seriesId, occurrenceId: a });
  const restarted = makeApp(); await restarted.initialize();
  const after = await restarted.snapshot();
  assert.notEqual(after.series[0]!.activeOccurrenceId, a);
  assert.equal(after.series[0]!.consumedCount, 1);
  assert.equal(after.series[0]!.occurrences.find(o => o.occurrenceId === a)!.resolution, 'open');
  assert.equal(host.notes.size, 2);
});
test('successive history undos preserve current period and notes', async () => {
  const { host, app, input, day } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: input() });
  const a = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({ action: 'complete', requestId: 'a', seriesId: created.seriesId }); day(29);
  const b = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({ action: 'complete', requestId: 'b', seriesId: created.seriesId });
  assert.equal((await app.dispatch({ action: 'reopen', requestId: 'undo-b', seriesId: created.seriesId, occurrenceId: b })).status, 'saved');
  const undo = await app.dispatch({ action: 'reopen', requestId: 'undo-a', seriesId: created.seriesId, occurrenceId: a });
  assert.equal(undo.status, 'saved', undo.message);
  const snapshot = await app.snapshot();
  assert.equal(snapshot.series[0]!.status, 'active'); assert.notEqual(snapshot.series[0]!.activeOccurrenceId, a);
  assert.notEqual(snapshot.series[0]!.activeOccurrenceId, b);
  assert.equal(snapshot.series[0]!.consumedCount, 2); assert.equal(host.notes.size, 3);
});
test('continuous historical result edits never write the shared current carrier', async () => {
  const { host, app, input, day } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: input('continuous') });
  const a = (await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({ action: 'complete', requestId: 'a', seriesId: created.seriesId }); day(29);
  await app.dispatch({ action: 'complete', requestId: 'b', seriesId: created.seriesId });
  const c = (await app.snapshot()).series[0]!.activeOccurrenceId;
  const fields = { ...host.notes.get(created.noteId!)! };
  const undo = await app.dispatch({ action: 'reopen', requestId: 'history-undo', seriesId: created.seriesId, occurrenceId: a });
  assert.equal(undo.status, 'saved', undo.message);
  const done = await app.dispatch({ action: 'complete', requestId: 'history-redo', seriesId: created.seriesId, occurrenceId: a });
  assert.equal(done.status, 'saved', done.message);
  assert.equal((await app.snapshot()).series[0]!.activeOccurrenceId, c);
  assert.equal((await app.snapshot()).series[0]!.consumedCount, 2);
  const note = host.notes.get(created.noteId!)!;
  assert.equal(note.todo_completed, fields.todo_completed); assert.equal(note.todo_due, fields.todo_due); assert.equal(note.body, fields.body);
});

test('native future-task notice follows saved language immediately without restarting', async () => {
  const { host, app, notices } = setup();
  await app.initialize();
  try {
    const made = await app.dispatch({ action: 'createTask', requestId: 'notice-task', input: {
      title: 'Future', notebookId: 'book', schedule: { kind: 'allDay', date: '2026-11-01', zone: 'Asia/Shanghai' },
    } });
    for (const language of ['en', 'zh-CN'] as const) {
      await app.dispatch({ action: 'savePreferences', requestId: `language-${language}`, preferences: { language } });
      await host.data.put(['notes', made.noteId!], {}, { todo_completed: Date.parse('2026-10-28T05:00:00Z') });
      await app.dispatch({ action: 'refresh', requestId: `notice-${language}` });
      assert.equal(host.notes.get(made.noteId!)!.todo_completed, 0);
      assert.match(notices.at(-1)!, language === 'en' ? /not due yet/ : /尚未到执行日期/);
      if (language === 'en') assert.doesNotMatch(notices.at(-1)!, /[\u3400-\u9fff]/);
    }
    assert.equal(notices.length, 2);
  } finally { app.dispose(); }
});
