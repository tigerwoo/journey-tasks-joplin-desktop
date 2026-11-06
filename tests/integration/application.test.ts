import { initializeArchiveBody } from '../../src/domain/bodyTemplate';
import { templateNote } from '../support/template-note';
import test from 'node:test';
import { buildArchiveBody } from '../support/body-template';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';
import type { TaskInput } from '../../src/services/applicationTypes';
import { withoutAnchorNotice } from '../support/note-body';

const instant = Date.parse('2026-10-24T02:00:00Z');
function setup(host = new MemoryJoplin(), now = instant) {
  host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: '工作' });
  let sequence = 0;
  const app = new TaskApplication(host, { now: () => now, randomId: () => String(++sequence).padStart(32, '0') });
  return { host, app };
}
const base = (): TaskInput => ({ title: '测试任务', body: '- [x] 已有步骤\n本期记录', notebookId: 'book',
  schedule: { kind: 'allDay', date: '2026-10-24', zone: 'Asia/Shanghai' }, priority: 'high', reminder: { enabled: true },
});
const repeat = (): TaskInput => ({ ...base(), recurrence: { calendar: 'gregorian', frequency: 'daily', basis: 'scheduled', interval: 1, end: { kind: 'never' } }, mode: 'continuous' });

test('application creates persistent native todo, stores plan separately, and recovers after restart', async () => {
  const { host, app } = setup(); await app.initialize();
  const result = await app.dispatch({ action: 'createTask', requestId: 'create-single', input: base() });
  assert.equal(result.status, 'saved', result.message);
  const snapshot = await app.snapshot({ view: 'today', deviceZone: 'Asia/Shanghai' });
  assert.equal(snapshot.items.length, 1); assert.equal(snapshot.tasks[0]?.priority, 'high');
  assert.equal(host.notes.get(result.noteId!)?.todo_due, Date.parse('2026-10-24T01:00:00Z'));
  const reopened = setup(host).app; await reopened.initialize();
  assert.equal((await reopened.snapshot({ deviceZone: 'Asia/Shanghai' })).tasks[0]?.title, '测试任务');
  assert.equal(host.notes.get(result.noteId!)?.body, base().body);
});

test('unresolved daily series previews future dates without materializing, completing A advances once', async () => {
  const { host, app } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create-A', input: repeat() });
  assert.equal(created.status, 'saved', created.message);
  const before = host.notes.size;
  const month = await app.snapshot({ view: 'month', date: '2026-10-24', deviceZone: 'Asia/Shanghai' });
  assert.ok(month.items.some(i => i.kind === 'projected' && i.date === '2026-10-25'));
  assert.equal(host.notes.size, before);
  const original = month.tasks.find(t => t.noteId === created.noteId)!;
  const done = await app.dispatch({ action: 'complete', requestId: 'complete-A', seriesId: created.seriesId, occurrenceId: original.occurrenceId });
  assert.equal(done.status, 'saved', done.message);
  const after = await app.snapshot({ view: 'month', date: '2026-10-24', deviceZone: 'Asia/Shanghai' });
  assert.equal(after.series[0]?.consumedCount, 1);
  assert.equal(after.series[0]?.occurrences.length, 2);
  assert.equal(after.tasks.filter(t => t.seriesId === created.seriesId && !t.historical).length, 1);
  assert.equal(withoutAnchorNotice(host.notes.get(created.noteId!)?.body), base().body);
  assert.equal(host.notes.get(created.noteId!)?.todo_completed, 0);
  await app.dispatch({ action: 'complete', requestId: 'complete-A', seriesId: created.seriesId, occurrenceId: original.occurrenceId });
  assert.equal((await app.snapshot()).series[0]?.consumedCount, 1);
});

test('B mode skips current and creates one successor from latest template, old content is retained', async () => {
  const { host, app } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create-B', input: { ...repeat(), mode: 'archive', body: templateNote(base().body!) } });
  assert.equal(created.status, 'saved', created.message);
  const snapshot = await app.snapshot(); const series = snapshot.series[0]!;
  await host.data.put(['notes', created.noteId!], {}, { title: '新版模板', body: buildArchiveBody(base().body!, '- [ ] 新步骤') });
  const skipped = await app.dispatch({ action: 'skip', requestId: 'skip-B', seriesId: created.seriesId, occurrenceId: series.activeOccurrenceId });
  assert.equal(skipped.status, 'saved', skipped.message);
  const after = await app.snapshot({ deviceZone: 'Asia/Shanghai' });
  const future = after.series[0]!.occurrences.find(o => o.occurrenceId === after.series[0]!.activeOccurrenceId)!;
  assert.notEqual(future.carrierNoteId, created.noteId);
  assert.equal(host.notes.get(future.carrierNoteId)?.title, '新版模板');
  assert.equal(host.notes.get(future.carrierNoteId)?.body, '- [ ] 新步骤');
  assert.equal(withoutAnchorNotice(host.notes.get(created.noteId!)?.body), base().body + '\n');
  assert.equal(host.notes.get(created.noteId!)?.is_todo, 1);
  assert.equal(after.series[0]?.consumedCount, 1);
});

test('reopen and recomplete consumed archived history never remove or regenerate successor', async () => {
  const { host, app } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'B-history', input: { ...repeat(), mode: 'archive', body: templateNote(base().body!) } });
  const before = await app.snapshot(); const first = before.series[0]!.activeOccurrenceId!;
  assert.equal((await app.dispatch({ action: 'complete', requestId: 'history-done', seriesId: created.seriesId, occurrenceId: first })).status, 'saved');
  const after = await app.snapshot(); const next = after.series[0]!.activeOccurrenceId; const count = host.notes.size;
  assert.equal((await app.dispatch({ action: 'reopen', requestId: 'history-undo', seriesId: created.seriesId, occurrenceId: first })).status, 'saved');
  assert.equal((await app.dispatch({ action: 'complete', requestId: 'history-redo', seriesId: created.seriesId, occurrenceId: first })).status, 'saved');
  const end = await app.snapshot();
  assert.equal(end.series[0]?.activeOccurrenceId, next); assert.equal(end.series[0]?.consumedCount, 1); assert.equal(host.notes.size, count);
});

test('single field preference edits do not clear another field across a restart', async () => {
  const { host, app } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'fields', input: base() });
  await app.dispatch({ action: 'setFields', requestId: 'pin', noteId: made.noteId!, pinned: true });
  const restarted = setup(host).app; await restarted.initialize();
  const task = (await restarted.snapshot()).tasks.find(t => t.noteId === made.noteId)!;
  assert.equal(task.priority, 'high'); assert.equal(task.pinned, true);
});

test('application finite repeat previews keep remaining future occurrences after one period is consumed', async () => {
  const { app } = setup(); await app.initialize();
  const input = repeat(); input.recurrence!.end = { kind: 'count', count: 3 };
  const made = await app.dispatch({ action: 'createTask', requestId: 'finite', input });
  const first = (await app.snapshot()).series[0]!.activeOccurrenceId;
  await app.dispatch({ action: 'complete', requestId: 'finite-done', seriesId: made.seriesId, occurrenceId: first });
  const month = await app.snapshot({ view: 'month', date: '2026-10-24', deviceZone: 'Asia/Shanghai' });
  assert.ok(month.items.some(i => i.kind === 'actual' && i.date === '2026-10-25'));
  assert.ok(month.items.some(i => i.kind === 'projected' && i.date === '2026-10-26'));
  assert.ok(!month.items.some(i => i.date > '2026-10-26'));
});

test('existing native todo can become a repeating series with one template execution copy', async () => {
  const { host, app } = setup();
  host.seedNote({ id: 'original', parent_id: 'book', title: '原生任务', body: '- [x] 当前执行记录', todo_due: Date.parse('2026-10-24T10:00:00Z') });
  await app.initialize();
  await host.data.put(['notes', 'original'], {}, { body: templateNote('- [x] 当前执行记录') });
  const result = await app.dispatch({ action: 'editTask', requestId: 'convert-native', noteId: 'original', patch: { recurrence: repeat().recurrence, mode: 'archive' } });
  assert.equal(result.status, 'saved', result.message);
  const snapshot = await app.snapshot({ view: 'month', date: '2026-10-24' });
  assert.equal(snapshot.series.length, 1);
  assert.equal(snapshot.tasks.filter(t => t.noteId === 'original').length, 1);
  assert.equal(host.notes.get('original')?.body, '- [x] 当前执行记录\n' + templateNote('- [x] 当前执行记录'));
  assert.ok(snapshot.items.some(i => i.kind === 'projected'));
});

test('restart finishes a locally proven archive create interrupted after durable advancement', async () => {
  const { host, app } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'recovery-root', input: { ...repeat(), mode: 'archive', body: templateNote(base().body!) } });
  const first = (await app.snapshot()).series[0]!.activeOccurrenceId;
  host.failNext('post', 'notes');
  const failed = await app.dispatch({ action: 'complete', requestId: 'recovery-done', seriesId: made.seriesId, occurrenceId: first });
  assert.equal(failed.status, 'saved');
  assert.equal(host.notes.get(made.noteId!)!.todo_completed, instant);
  assert.ok(failed.code, 'advancement failure must remain visible while completion is preserved');
  const restarted = setup(host).app; await restarted.initialize();
  const snapshot = await restarted.snapshot();
  assert.equal(snapshot.series[0]?.consumedCount, 1);
  assert.equal(snapshot.series[0]?.status, 'active');
  const next = snapshot.series[0]!.occurrences.find(o => o.occurrenceId === snapshot.series[0]!.activeOccurrenceId)!;
  assert.ok(host.notes.has(next.carrierNoteId));
  assert.ok(Object.values(JSON.parse(host.notes.get(next.carrierNoteId)!.user_data)[host.namespace])
    .some((entry: any) => !entry.d && entry.v?.role === 'carrier' && entry.v.creationHash));
  assert.equal(snapshot.diagnostics.length, 0);
});

test('missing template attachment blocks creation before leaving a new todo behind', async () => {
  const { host, app } = setup(); await app.initialize();
  const before = host.notes.size;
  const result = await app.dispatch({ action: 'createTask', requestId: 'missing-attachment', input: { ...repeat(), mode: 'archive', body: templateNote('![image](:/0123456789abcdef0123456789abcdef)') } });
  assert.equal(result.status, 'error');
  assert.equal(host.notes.size, before);
});

test('changing a progressed series template or reminder never rolls the active date back to the original anchor', async () => {
  const { host, app } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'no-rollback', input: { ...repeat(), mode: 'archive', body: templateNote(base().body!) } });
  let snapshot = await app.snapshot();
  await app.dispatch({ action: 'complete', requestId: 'roll-done', seriesId: made.seriesId, occurrenceId: snapshot.series[0]!.activeOccurrenceId });
  snapshot = await app.snapshot();
  await host.data.put(['notes', made.noteId!], {}, { title: '新模板', body: buildArchiveBody(base().body!, '新内容') });
  await app.dispatch({ action: 'editTask', requestId: 'roll-reminder', noteId: made.noteId!, patch: { reminder: { enabled: false } } });
  snapshot = await app.snapshot();
  const active = snapshot.series[0]!.occurrences.find(o => o.occurrenceId === snapshot.series[0]!.activeOccurrenceId)!;
  assert.equal(active.scheduled.date, '2026-10-25');
  assert.equal(snapshot.series[0]!.definition!.anchor.date, '2026-10-24');
});

test('disabling a reminder after snooze actually cancels it for singles and repeating tasks', async () => {
  for (const input of [base(), repeat()]) {
    const { host, app } = setup(); await app.initialize();
    const made = await app.dispatch({ action: 'createTask', requestId: 'snooze-off', input });
    await app.dispatch({ action: 'snooze', requestId: 'snooze-then', noteId: made.noteId!, until: instant + 600000 });
    assert.equal(host.notes.get(made.noteId!)?.todo_due, instant + 600000);
    const result = await app.dispatch({ action: 'editTask', requestId: 'reminder-off', noteId: made.noteId!, patch: { reminder: { enabled: false } } });
    assert.equal(result.status, 'saved', result.message);
    assert.equal(host.notes.get(made.noteId!)?.todo_due, 0);
  }
});

test('restoring a deleted native single reattaches only after a genuine later native edit', async () => {
  const { host, app } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'delete-restore', input: base() });
  const saved = structuredClone(host.notes.get(made.noteId!)!);
  assert.equal((await app.dispatch({ action: 'deleteTask', requestId: 'delete-it', noteId: made.noteId! })).status, 'saved');
  assert.equal((await app.snapshot()).tasks.length, 0);
  host.notes.set(saved.id, { ...saved, updated_time: saved.updated_time + 10000 });
  await app.dispatch({ action: 'refresh', requestId: 'after-native-restore' });
  assert.ok((await app.snapshot()).tasks.some(t => t.noteId === saved.id));
  assert.equal(host.notes.get(saved.id)?.body, saved.body);
});

test('one damaged task anchor does not hide healthy tasks and cannot be silently readopted', async () => {
  const { host, app } = setup(); await app.initialize();
  const bad = await app.dispatch({ action: 'createTask', requestId: 'bad-control', input: base() });
  const healthy = await app.dispatch({ action: 'createTask', requestId: 'healthy-control', input: { ...base(), title: '健康任务' } });
  const anchor = host.notes.get(bad.noteId!)!;
  const envelope = JSON.parse(anchor.user_data);
  const scope = Object.keys(envelope[host.namespace]).find(key => key.startsWith('v3:scope:') && envelope[host.namespace][key].v.rootNoteId === bad.noteId)!;
  assert.ok(scope, 'the task itself must carry its scope metadata');
  envelope[host.namespace][scope].v.schemaVersion = 999; anchor.user_data = JSON.stringify(envelope);
  await app.dispatch({ action: 'refresh', requestId: 'read-damage' });
  const snapshot = await app.snapshot();
  assert.ok(snapshot.tasks.some(t => t.noteId === healthy.noteId));
  const edit = await app.dispatch({ action: 'editTask', requestId: 'edit-damaged', noteId: bad.noteId!, patch: { title: '禁止覆盖' } });
  assert.equal(edit.status, 'error'); assert.equal(host.notes.get(bad.noteId!)?.title, base().title);
});

test('a failed complete metadata read blocks stale-context writes until a successful refresh', async () => {
  const { host, app } = setup(); await app.initialize();
  host.failNext('get', 'notes');
  assert.equal((await app.dispatch({ action: 'refresh', requestId: 'failed-refresh' })).status, 'error');
  const before = host.notes.size;
  const blocked = await app.dispatch({ action: 'createTask', requestId: 'blocked-write', input: base() });
  assert.equal(blocked.code, 'DATA_READ_ONLY'); assert.equal(host.notes.size, before);
  await app.dispatch({ action: 'refresh', requestId: 'retry-full-read' });
  assert.equal((await app.dispatch({ action: 'createTask', requestId: 'now-writable', input: base() })).status, 'saved');
});

test('missing first carrier permits saving current completion but never generates an unanchored successor', async () => {
  const { host, app } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'carrier-guard', input: { ...repeat(), mode: 'archive', body: templateNote(base().body!) } });
  const first = (await app.snapshot()).series[0]!.activeOccurrenceId;
  await app.dispatch({ action: 'complete', requestId: 'guard-advance', seriesId: made.seriesId, occurrenceId: first });
  const beforeMissing = await app.snapshot();
  const next = beforeMissing.series[0]!.activeOccurrenceId;
  const carrier = beforeMissing.series[0]!.occurrences.find(item => item.occurrenceId === next)!.carrierNoteId;
  await app.dispatch({ action: 'changeDate', requestId: 'carrier-due', noteId: carrier, schedule: base().schedule });
  host.notes.delete(made.noteId!);
  await app.dispatch({ action: 'refresh', requestId: 'missing-history' });
  const snapshot = await app.snapshot();
  assert.equal(snapshot.series.length, 0, 'missing first note has no fabricated recovery summary');
  const count = host.notes.size;
  const later = setup(host, Date.parse('2026-10-25T04:00:00Z')).app; await later.initialize();
  const blocked = await later.dispatch({ action: 'complete', requestId: 'no-zombie', seriesId: made.seriesId, occurrenceId: next });
  assert.equal(blocked.status, 'saved');
  assert.equal(blocked.code, 'ANCHOR_MISSING_PENDING');
  assert.ok(host.notes.get(carrier)!.todo_completed > 0);
  assert.equal(host.notes.get(carrier)!.todo_due, 0);
  assert.equal(host.notes.size, count);
  assert.equal(host.notes.has(made.noteId!), false);
  assert.ok(!(await later.snapshot()).diagnostics.some(item => item.code === 'ANCHOR_MISSING_PENDING'));
});

test('explicit current schedule edit clears an observed postponement but not a later new postponement', async () => {
  const { app } = setup(); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'defer-edit', input: repeat() });
  let series = (await app.snapshot()).series[0]!;
  await app.dispatch({ action: 'changeDate', requestId: 'old-defer', noteId: made.noteId!, schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' } });
  series = (await app.snapshot()).series[0]!;
  const anchor = { kind: 'allDay' as const, date: '2026-10-26', zone: 'Asia/Shanghai' };
  const revised = await app.dispatch({ action: 'reviseSeries', requestId: 'explicit-date', seriesId: made.seriesId!, revisionId: series.definition!.revisionId, definition: { ...series.definition!, anchor }, currentSchedule: anchor });
  assert.equal(revised.status, 'saved', revised.message);
  series = (await app.snapshot()).series[0]!;
  let current = series.occurrences.find(o => o.occurrenceId === series.activeOccurrenceId)!;
  assert.equal(current.scheduled.date, '2026-10-26'); assert.deepEqual(current.deferred, anchor);
  await app.dispatch({ action: 'changeDate', requestId: 'later-defer', noteId: made.noteId!, schedule: { ...anchor, date: '2026-10-27' } });
  series = (await app.snapshot()).series[0]!; current = series.occurrences.find(o => o.occurrenceId === series.activeOccurrenceId)!;
  assert.equal(current.deferred?.date, '2026-10-27');
});

test('native undated and dated todos created after startup are discovered without mutating or adopting them', async () => {
  const { host, app } = setup(); await app.initialize();
  host.seedNote({ id: 'native-undated', parent_id: 'book', title: '原生无日期任务', body: '- [x] 原文' });
  host.seedNote({ id: 'native-dated', parent_id: 'book', title: '原生今日任务', todo_due: instant });
  const before = structuredClone([...host.notes.values()]);
  assert.equal((await app.dispatch({ action: 'refresh', requestId: 'native-discovery' })).status, 'saved');
  const snapshot = await app.snapshot({ view: 'today', deviceZone: 'Asia/Shanghai' });
  assert.equal(snapshot.tasks.find(t => t.noteId === 'native-undated')?.schedule.kind, 'none');
  assert.ok(snapshot.items.some(i => i.noteId === 'native-dated'));
  assert.ok(!snapshot.items.some(i => i.noteId === 'native-undated'));
  assert.deepEqual([...host.notes.values()], before, 'reading native tasks must not write control notes or alter reminders');
  await host.data.put(['notes', 'native-undated'], {}, { title: '原生改名', todo_due: instant });
  await app.dispatch({ action: 'refresh', requestId: 'native-change' });
  assert.equal((await app.snapshot({ deviceZone: 'Asia/Shanghai' })).items.find(i => i.noteId === 'native-undated')?.title, '原生改名');
  await host.data.put(['notes', 'native-undated'], {}, { todo_completed: instant });
  await app.dispatch({ action: 'refresh', requestId: 'native-done' });
  assert.ok(!(await app.snapshot({ deviceZone: 'Asia/Shanghai' })).items.some(i => i.noteId === 'native-undated'));
  await host.data.put(['notes', 'native-undated'], {}, { todo_completed: 0, todo_due: 0 });
  await app.dispatch({ action: 'refresh', requestId: 'native-reopen' });
  assert.equal((await app.snapshot()).tasks.find(t => t.noteId === 'native-undated')?.completedAt, 0);
});

test('native undated task can be arranged or completed without copying or changing its body', async () => {
  const { host, app } = setup();
  host.seedNote({ id: 'native-arrange', parent_id: 'book', title: '安排原生任务', body: '用户正文' });
  host.seedNote({ id: 'native-complete', parent_id: 'book', title: '直接完成', body: '- [x] 保留步骤' });
  await app.initialize();
  const arranged = await app.dispatch({ action: 'editTask', requestId: 'arrange-native', noteId: 'native-arrange', patch: { schedule: base().schedule } });
  assert.equal(arranged.status, 'saved', arranged.message);
  assert.ok((await app.snapshot({ deviceZone: 'Asia/Shanghai' })).items.some(i => i.noteId === 'native-arrange'));
  const done = await app.dispatch({ action: 'complete', requestId: 'complete-native', noteId: 'native-complete' });
  assert.equal(done.status, 'saved', done.message);
  assert.equal(host.notes.get('native-complete')?.todo_completed, instant);
  assert.equal(host.notes.get('native-complete')?.body, '- [x] 保留步骤');
  assert.equal(host.notes.get('native-arrange')?.body, '用户正文');
  assert.equal([...host.notes.values()].filter(n => n.is_todo).length, 2);
});

for (const mode of ['single', 'continuous', 'archive'] as const) {
  test(`${mode} pins only the generated current task and clears pins persistently on completion`, async () => {
    const { host, app } = setup(); await app.initialize();
    const input = mode === 'single' ? base() : { ...repeat(), mode, ...(mode === 'archive' ? { body: templateNote(base().body!) } : {}) };
    const created = await app.dispatch({ action: 'createTask', requestId: `pin-create-${mode}`, input });
    assert.equal(created.status, 'saved', created.message);
    const pinned = await app.dispatch({ action: 'setFields', requestId: `pin-${mode}`, noteId: created.noteId!, pinned: true });
    assert.equal(pinned.status, 'saved', pinned.message);
    const before = await app.snapshot({ view: 'month', date: '2026-10-24', deviceZone: 'Asia/Shanghai' });
    assert.equal(before.tasks.find(task => task.noteId === created.noteId)?.pinned, true);
    assert.ok(before.items.filter(item => item.kind === 'projected').every(item => !item.pinned));
    const current = before.tasks.find(task => task.noteId === created.noteId)!;
    const done = await app.dispatch({ action: 'complete', requestId: `pin-done-${mode}`, noteId: created.noteId!, seriesId: current.seriesId, occurrenceId: current.occurrenceId });
    assert.equal(done.status, 'saved', done.message);
    const restarted = setup(host).app; await restarted.initialize();
    const after = await restarted.snapshot({ view: 'all', showCompleted: true });
    assert.ok(after.tasks.length > 0);
    assert.ok(after.tasks.every(task => !task.pinned));
    if (mode === 'single') {
      await restarted.dispatch({ action: 'reopen', requestId: 'pin-reopen', noteId: created.noteId! });
      assert.equal((await restarted.snapshot()).tasks.find(task => task.noteId === created.noteId)?.pinned, false);
    } else {
      const successor = after.tasks.find(task => task.occurrenceId === after.series[0]?.activeOccurrenceId)!;
      assert.ok(successor);
      const result = await restarted.dispatch({ action: 'setFields', requestId: `pin-next-${mode}`, noteId: successor.noteId, pinned: true });
      assert.equal(result.status, 'saved', result.message);
      assert.equal((await restarted.snapshot()).tasks.find(task => task.occurrenceId === successor.occurrenceId)?.pinned, true);
    }
  });
}

test('series reminder revision replaces snooze, persists and applies to the next occurrence', async () => {
  const { host, app } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'reminder-series', input: repeat() });
  assert.equal(created.status, 'saved', created.message);
  const snoozed = await app.dispatch({ action: 'snooze', requestId: 'reminder-snooze', noteId: created.noteId!, until: instant + 3600_000 });
  assert.equal(snoozed.status, 'saved', snoozed.message);
  let snapshot = await app.snapshot({ view: 'all', deviceZone: 'Asia/Shanghai' });
  assert.equal(snapshot.items[0]!.reminderAt, instant + 3600_000);
  const series = snapshot.series[0]!;
  const revised = await app.dispatch({ action: 'reviseSeries', requestId: 'reminder-revise', seriesId: series.seriesId, revisionId: series.definition!.revisionId,
    definition: { ...series.definition!, reminder: { enabled: true, allDayTime: '11:30' } } });
  assert.equal(revised.status, 'saved', revised.message);
  assert.equal(host.notes.get(created.noteId!)!.todo_due, Date.parse('2026-10-24T03:30:00Z'));
  const restarted = setup(host).app; await restarted.initialize();
  snapshot = await restarted.snapshot({ view: 'all', deviceZone: 'Asia/Shanghai' });
  assert.equal(snapshot.items[0]!.reminderAt, Date.parse('2026-10-24T03:30:00Z'));
  const completed = await restarted.dispatch({ action: 'complete', requestId: 'reminder-next', noteId: created.noteId! });
  assert.equal(completed.status, 'saved', completed.message);
  assert.equal(host.notes.get(created.noteId!)!.todo_due, Date.parse('2026-10-25T03:30:00Z'));
  const next = (await restarted.snapshot()).series[0]!;
  const disabled = await restarted.dispatch({ action: 'reviseSeries', requestId: 'reminder-disable', seriesId: next.seriesId, revisionId: next.definition!.revisionId,
    definition: { ...next.definition!, reminder: { enabled: false } } });
  assert.equal(disabled.status, 'saved', disabled.message);
  assert.equal(host.notes.get(created.noteId!)!.todo_due, 0);
  assert.equal((await restarted.snapshot({ view: 'all' })).items[0]!.reminderAt, 0);
});
