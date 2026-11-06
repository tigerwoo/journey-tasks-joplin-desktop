import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';
import { LocalIntentStore } from '../../src/adapters/joplin/localIntentStore';

async function setup(mode: 'archive' | 'continuous' = 'archive') {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  for (const id of ['A', 'B']) host.notebooks.set(id, { id, title: id });
  const store = new LocalIntentStore(host, () => 'device');
  await store.savePreferences({ language: 'zh-CN' });
  const notices: string[] = [];
  let sequence = 0;
  const options = { now: () => Date.parse('2026-11-05T08:00:00Z'),
    randomId: () => (++sequence).toString(16).padStart(32, '0'), onNotice: (message: string) => notices.push(message) };
  const app = new TaskApplication(host, options); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'create', input: {
    title: '第一篇真实名称', notebookId: 'A', mode, schedule: { kind: 'allDay', date: '2026-11-01', zone: 'UTC' },
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  assert.equal(made.status, 'saved', made.message);
  const active = async (target = app) => {
    const series = (await target.snapshot()).series[0]!;
    return series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!;
  };
  const complete = async (requestId: string, target = app) => {
    const result = await target.dispatch({ action: 'complete', requestId, noteId: (await active(target)).carrierNoteId });
    assert.equal(result.status, 'saved', result.message); return result;
  };
  return { host, app, options, notices, made, active, complete };
}

for (const mode of ['archive', 'continuous'] as const) test(`${mode}: deletion notice names the note once, has no recovery summary, and startup stays silent`, async () => {
  const { host, app, options, notices, made } = await setup(mode);
  host.notes.get(made.noteId!)!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'deleted', noteIds: [made.noteId!] });
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /第一篇真实名称.*已删除/);
  assert.doesNotMatch(notices[0]!, /这个|尚未同步|重试/);
  await app.dispatch({ action: 'refresh', requestId: 'again' });
  assert.equal(notices.length, 1);
  const missing = await app.snapshot();
  assert.equal(missing.series.length, 0);
  assert.equal(missing.diagnostics.length, 0);
  app.dispose();
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal(notices.length, 1);
  host.notes.get(made.noteId!)!.deleted_time = 0;
  await restarted.dispatch({ action: 'refresh', requestId: 'restored' });
  assert.equal((await restarted.snapshot()).series[0]!.status, 'active');
  assert.equal(host.notes.size, 1);
});

test('pending completion resumes on startup after offline restoration, once across refreshes and restarts', async () => {
  const { host, app, options, notices, made, active, complete } = await setup();
  await complete('first');
  const follower = await active();
  host.notes.get(made.noteId!)!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'missing' });
  const result = await app.dispatch({ action: 'complete', requestId: 'pending', noteId: follower.carrierNoteId });
  assert.equal(result.status, 'saved');
  assert.match(notices.at(-1)!, /完成已保存.*第一篇真实名称.*自动生成下一期/);
  assert.equal(host.notes.size, 2);
  assert.ok(host.notes.get(follower.carrierNoteId)!.todo_completed);
  app.dispose(); host.notes.get(made.noteId!)!.deleted_time = 0;
  const before = notices.length;
  const restored = new TaskApplication(host, options); await restored.initialize();
  assert.equal(notices.length, before, 'startup must reconcile silently');
  assert.equal(host.notes.size, 3);
  const series = (await restored.snapshot()).series[0]!;
  assert.equal(series.consumedCount, 2);
  assert.equal((await restored.snapshot()).diagnostics.length, 0);
  for (let i = 0; i < 3; i++) await restored.dispatch({ action: 'refresh', requestId: `again-${i}` });
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal(host.notes.size, 3);
  assert.equal((await restarted.snapshot()).series[0]!.activeOccurrenceId, series.activeOccurrenceId);
});

test('an existing valid successor remains valid after a single-note move and restoration', async () => {
  const { host, app, made, active, complete } = await setup();
  await complete('first'); await complete('second');
  const successor = await active();
  await app.dispatch({ action: 'moveTask', requestId: 'move', noteId: successor.carrierNoteId, notebookId: 'B' });
  host.notes.get(made.noteId!)!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'delete' });
  host.notes.get(made.noteId!)!.deleted_time = 0;
  await app.dispatch({ action: 'refresh', requestId: 'restore' });
  assert.equal(host.notes.size, 3);
  assert.equal((await active()).carrierNoteId, successor.carrierNoteId);
  assert.equal(host.notes.get(successor.carrierNoteId)!.parent_id, 'B');
});

for (const permanent of [false, true]) test(`stopped archive series survives first-note deletion and restart (permanent=${permanent})`, async () => {
  const { host, app, options, notices, made, complete } = await setup();
  await complete('first');
  const stopped = await app.dispatch({ action: 'deleteTask', requestId: 'stop', scope: 'stop', noteId: made.noteId!, seriesId: made.seriesId });
  assert.equal(stopped.status, 'saved', stopped.message);
  assert.equal((await app.snapshot()).series[0]!.status, 'ended');
  if (permanent) host.notes.delete(made.noteId!); else host.notes.get(made.noteId!)!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'delete-first' });
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal(notices.length, 0);
  assert.equal((await restarted.snapshot()).diagnostics.length, 0);
  assert.equal((await restarted.snapshot()).series.length, 0);
  assert.equal(host.notes.size, permanent ? 1 : 2);
});

test('a stopped first note in Trash supplies the authority for old series without lifecycle receipts', async () => {
  const { host, app, options, notices, made, active, complete } = await setup();
  await complete('first'); const follower = await active();
  await app.dispatch({ action: 'deleteTask', requestId: 'stop', scope: 'stop', noteId: made.noteId!, seriesId: made.seriesId });
  const data = JSON.parse(host.notes.get(follower.carrierNoteId)!.user_data);
  for (const key of Object.keys(data[DEFAULT_PLUGIN_ID])) if (key.startsWith('v3:ended:')) delete data[DEFAULT_PLUGIN_ID][key];
  host.notes.get(follower.carrierNoteId)!.user_data = JSON.stringify(data);
  host.notes.get(made.noteId!)!.deleted_time = 123;
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal((await restarted.snapshot()).diagnostics.length, 0);
  assert.equal(notices.length, 0);
  host.notes.delete(made.noteId!);
  const purged = new TaskApplication(host, options); await purged.initialize();
  assert.equal((await purged.snapshot()).diagnostics.length, 0);
  assert.equal(host.notes.size, 1);
});

test('repairing the series notebook automatically resumes generation without a retry command', async () => {
  const { host, app, made, active, complete } = await setup();
  await complete('first'); const current = await active();
  for (const noteId of [made.noteId!, current.carrierNoteId])
    await app.dispatch({ action: 'moveTask', requestId: `move-${noteId}`, noteId, notebookId: 'B' });
  await host.data.delete(['folders', 'A']);
  await app.dispatch({ action: 'refresh', requestId: 'folder-deleted' });
  const result = await app.dispatch({ action: 'complete', requestId: 'second', noteId: current.carrierNoteId });
  assert.equal(result.code, 'SERIES_NOTEBOOK_MISSING');
  assert.equal(host.notes.size, 2);
  const series = (await app.snapshot()).series[0]!;
  const fixed = await app.dispatch({ action: 'reviseSeries', requestId: 'fix-notebook', seriesId: made.seriesId!,
    revisionId: series.definition!.revisionId, definition: { ...series.definition!, sourceNotebookId: 'B' }, moveSeries: true });
  assert.equal(fixed.status, 'saved', fixed.message);
  assert.equal(host.notes.size, 3);
  assert.equal(host.notes.get((await active()).carrierNoteId)!.parent_id, 'B');
});

test('whole-notebook deletion gives one named native notice and restoration keeps the same current task', async () => {
  const { host, app, notices, made } = await setup();
  await host.data.delete(['folders', 'A']);
  await app.dispatch({ action: 'refresh', requestId: 'whole-notebook' });
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /第一篇真实名称/);
  host.notebooks.get('A')!.deleted_time = 0; host.notes.get(made.noteId!)!.deleted_time = 0;
  await app.dispatch({ action: 'refresh', requestId: 'restore-notebook' });
  assert.equal(host.notes.size, 1);
  assert.equal((await app.snapshot()).series[0]!.status, 'active');
});

test('an interrupted created successor is bound once after restart even if it was moved', async () => {
  const { host, app, options, made } = await setup();
  const set = host.data.userDataSet;
  host.data.userDataSet = async (type, id, key, value) => {
    if (id !== made.noteId && key.startsWith('v3:carrier:')) throw new Error('Interrupted binding');
    return set(type, id, key, value);
  };
  await app.dispatch({ action: 'complete', requestId: 'interrupted', noteId: made.noteId! });
  assert.equal(host.notes.size, 2);
  const created = [...host.notes.values()].find(note => note.id !== made.noteId)!;
  await host.data.put(['notes', created.id], {}, { parent_id: 'B' });
  host.data.userDataSet = set;
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal(host.notes.size, 2);
  assert.equal(host.notes.get(created.id)!.parent_id, 'B');
  const series = (await restarted.snapshot()).series[0]!;
  assert.equal(series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!.carrierNoteId, created.id);
  assert.ok(series.status === 'active');
  await restarted.dispatch({ action: 'refresh', requestId: 'repeated' });
  assert.equal(host.notes.size, 2);
});

test('a synced unfinished Advance can resume without another device’s local creation intent', async () => {
  const { host, app, options, made } = await setup();
  const post = host.data.post;
  host.data.post = async (path, query, body) => {
    if (path[0] === 'notes' && body?.id !== made.noteId) throw new Error('Interrupted creation');
    return post(path, query, body);
  };
  await app.dispatch({ action: 'complete', requestId: 'interrupted', noteId: made.noteId! });
  assert.equal(host.notes.size, 1);
  host.data.post = post;
  await app.local.clearOutbox(); // Model another device: journal is synced, local intents are not.
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal(host.notes.size, 2);
  const series = (await restarted.snapshot()).series[0]!;
  assert.equal(series.status, 'active');
  assert.equal(series.consumedCount, 1);
  await restarted.dispatch({ action: 'refresh', requestId: 'again' });
  assert.equal(host.notes.size, 2);
});

test('encrypted first notes pause recovery; restoring readability consumes the completion once', async () => {
  const { host, app, options, made, active, complete } = await setup();
  await complete('first'); const follower = await active();
  host.notes.get(made.noteId!)!.encryption_applied = 1;
  await app.dispatch({ action: 'refresh', requestId: 'encrypted' });
  await app.dispatch({ action: 'complete', requestId: 'complete-encrypted', noteId: follower.carrierNoteId });
  assert.equal(host.notes.size, 2);
  const encryptedRestart = new TaskApplication(host, options); await encryptedRestart.initialize();
  assert.equal(host.notes.size, 2);
  host.notes.get(made.noteId!)!.encryption_applied = 0;
  await encryptedRestart.dispatch({ action: 'refresh', requestId: 'decrypted' });
  assert.equal(host.notes.size, 3);
});

test('automatic pending recovery respects the repeat count limit', async () => {
  const { host, app, made, active, complete } = await setup();
  await complete('first');
  const series = (await app.snapshot()).series[0]!;
  await app.dispatch({ action: 'reviseSeries', requestId: 'limit', seriesId: made.seriesId!, revisionId: series.definition!.revisionId,
    definition: { ...series.definition!, rule: { ...series.definition!.rule, end: { kind: 'count', count: 2 } } } });
  const current = await active();
  host.notes.get(made.noteId!)!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'deleted' });
  await app.dispatch({ action: 'complete', requestId: 'last', noteId: current.carrierNoteId });
  host.notes.get(made.noteId!)!.deleted_time = 0;
  await app.dispatch({ action: 'refresh', requestId: 'restore' });
  assert.equal(host.notes.size, 2);
  assert.equal((await app.snapshot()).series[0]!.status, 'ended');
});

test('restoring a series that was stopped before its first note disappeared does not import stale pending evidence', async () => {
  const { host, app, options, made, active, complete } = await setup();
  await complete('first'); const current = await active();
  const other = new TaskApplication(host, options); await other.initialize();
  host.notes.get(made.noteId!)!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'deleted' });
  await app.dispatch({ action: 'complete', requestId: 'pending', noteId: current.carrierNoteId });
  // Another device stops the still-readable first note before it is restored here.
  host.notes.get(made.noteId!)!.deleted_time = 0;
  await other.dispatch({ action: 'deleteTask', requestId: 'stop', noteId: made.noteId!, seriesId: made.seriesId, scope: 'stop' });
  const count = host.notes.size;
  host.notes.get(made.noteId!)!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'observe-stopped' });
  host.notes.get(made.noteId!)!.deleted_time = 0;
  await app.dispatch({ action: 'refresh', requestId: 'restore-stopped' });
  assert.equal(host.notes.size, count);
  assert.equal((await app.snapshot()).series[0]!.status, 'ended');
});

test('a remote stop receipt prevents deletion alerts on an observer with stale active state', async () => {
  const { host, app, options, notices, made, complete } = await setup();
  await complete('first');
  const observer = new TaskApplication(host, options); await observer.initialize();
  await app.dispatch({ action: 'deleteTask', requestId: 'remote-stop', noteId: made.noteId!, seriesId: made.seriesId, scope: 'stop' });
  host.notes.delete(made.noteId!);
  await observer.dispatch({ action: 'refresh', requestId: 'remote-deletion' });
  assert.equal(notices.length, 0);
  assert.equal((await observer.snapshot()).diagnostics.length, 0);
});

test('changing a deleted destination also resumes an unfinished unbound creation', async () => {
  const { host, app, made, active } = await setup();
  const post = host.data.post;
  host.data.post = async (path, query, body) => {
    if (path[0] === 'notes' && body?.id !== made.noteId) throw new Error('Interrupted creation');
    return post(path, query, body);
  };
  await app.dispatch({ action: 'complete', requestId: 'interrupted', noteId: made.noteId! });
  assert.equal(host.notes.size, 1);
  await host.data.put(['notes', made.noteId!], {}, { parent_id: 'B' });
  await host.data.delete(['folders', 'A']);
  await app.dispatch({ action: 'refresh', requestId: 'bad-destination' });
  host.data.post = post;
  const series = (await app.snapshot()).series[0]!;
  const result = await app.dispatch({ action: 'reviseSeries', requestId: 'repair', seriesId: made.seriesId!,
    revisionId: series.definition!.revisionId, definition: { ...series.definition!, sourceNotebookId: 'B' }, moveSeries: true });
  assert.equal(result.status, 'saved', result.message);
  assert.equal(host.notes.size, 2);
  assert.equal(host.notes.get((await active()).carrierNoteId)!.parent_id, 'B');
});

test('a missing first-note title is not invented from the differently named current task', async () => {
  const { host, app, notices, made, active, complete } = await setup();
  await complete('first'); const current = await active();
  await host.data.put(['notes', current.carrierNoteId], {}, { title: '当期不同名称' });
  host.notes.delete(made.noteId!);
  await app.dispatch({ action: 'refresh', requestId: 'gone' });
  await app.dispatch({ action: 'complete', requestId: 'finish', noteId: current.carrierNoteId });
  assert.match(notices.at(-1)!, /任务「当期不同名称」所属系列的第一篇任务笔记已永久删除/);
  assert.doesNotMatch(notices.at(-1)!, /第一篇任务笔记「当期不同名称」/);
});
