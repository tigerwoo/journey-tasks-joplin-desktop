import test from 'node:test';
import assert from 'node:assert/strict';
import { JoplinGateway } from '../../src/adapters/joplin/gateway';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { LocalIntentStore } from '../../src/adapters/joplin/localIntentStore';
import { MemoryJoplin } from '../support/memory-joplin';

const trashId = 'de1e7ede1e7ede1e7ede1e7ede1e7ede';
const input = (notebookId: string) => ({ title: 'Task', notebookId, schedule: { kind: 'none' as const }, reminder: { enabled: false } });

async function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('live', { id: 'live', title: 'Live', deleted_time: 0 });
  host.notebooks.set('deleted', { id: 'deleted', title: 'Deleted', deleted_time: 100 });
  host.notebooks.set('child', { id: 'child', title: 'Child', parent_id: 'deleted', deleted_time: 0 });
  host.notebooks.set(trashId, { id: trashId, title: 'Trash' });
  host.seedNote({ id: 'live-note', parent_id: 'live' });
  host.seedNote({ id: 'child-note', parent_id: 'child' });
  host.seedNote({ id: 'trashed-note', parent_id: 'live', deleted_time: 100 });
  let now = Date.parse('2026-11-04T00:00:00Z');
  const app = new TaskApplication(host, { now: () => now }); await app.initialize();
  return { host, app, tick: () => { now += 6000; } };
}

test('trash catalog stays available to cleanup while snapshots and stale filters exclude deleted subtrees', async () => {
  const { host, app } = await setup();
  const store = new LocalIntentStore(host, () => 'device');
  await store.savePreferences({ notebookIds: ['deleted'], quickAddNotebookId: 'deleted' });
  const snapshot = await app.snapshot({ view: 'all', notebookIds: ['deleted'] });
  assert.deepEqual(snapshot.folders.map(f => f.id), ['live']);
  assert.deepEqual(snapshot.items.map(item => item.noteId), ['live-note']);
  assert.deepEqual(snapshot.preferences.notebookIds, []);
  assert.equal(snapshot.preferences.quickAddNotebookId, '');
  assert.ok((await new JoplinGateway(host).folders()).some(f => f.id === 'deleted' && f.deleted_time === 100));
  await host.data.userDataSet(2, 'deleted', 'legacy', { value: 1 });
  const preview = await app.dispatch({ action: 'previewCleanup', requestId: 'preview' });
  assert.equal(preview.status, 'saved', preview.message);
  assert.ok(preview.cleanupPlan?.folders.some(folder => folder.id === 'deleted'));
  const cleaned = await app.dispatch({ action: 'executeCleanup', requestId: 'cleanup', token: preview.cleanupPlan!.token, confirmation: 'RESET' });
  assert.equal(cleaned.status, 'saved', cleaned.message);
  assert.equal(host.notebooks.get('deleted')!.deleted_time, 100);
  assert.equal(await host.data.userDataGet(2, 'deleted', 'legacy'), undefined);
});

test('stale create, edit and move destinations are rejected before native writes', async () => {
  const { host, app } = await setup();
  for (const notebookId of ['deleted', 'child', trashId]) {
    for (const command of [
      { action: 'createTask' as const, input: input(notebookId) },
      { action: 'moveTask' as const, noteId: 'live-note', notebookId },
      { action: 'editTask' as const, noteId: 'live-note', patch: { notebookId } },
    ]) {
      const result = await app.dispatch({ ...command, requestId: JSON.stringify(command) });
      assert.equal(result.code, 'NOTEBOOK_MISSING', result.message);
    }
  }
  assert.equal(host.notes.get('live-note')!.parent_id, 'live');
});

test('empty notebook deletion and restoration refresh without note edits', async () => {
  const { host, app, tick } = await setup();
  host.notebooks.set('empty', { id: 'empty', title: 'Empty', deleted_time: 0 });
  await app.dispatch({ action: 'refresh', requestId: 'initial' });
  const before = (await app.snapshot()).snapshotVersion;
  host.notebooks.get('empty')!.deleted_time = 100; tick();
  await app.dispatch({ action: 'refresh', checkChanges: true, requestId: 'delete' });
  assert.ok(!(await app.snapshot()).folders.some(f => f.id === 'empty'));
  assert.ok((await app.snapshot()).snapshotVersion > before);
  host.notebooks.get('empty')!.deleted_time = 0; tick();
  await app.dispatch({ action: 'refresh', checkChanges: true, requestId: 'restore' });
  assert.ok((await app.snapshot()).folders.some(f => f.id === 'empty'));
});

test('tree and paginated fallback request identical deletion and ordering metadata', async () => {
  for (const paginated of [false, true]) {
    const queries: any[] = [];
    const rows = [{ id: 'deleted', title: 'Deleted', deleted_time: 100, user_updated_time: 20 }];
    const gateway = new JoplinGateway({ data: { get: async (_path: string[], query: any) => {
      queries.push(query);
      if (query.as_tree && paginated) return { items: rows, has_more: true };
      return query.as_tree ? rows : { items: rows, has_more: false };
    } } } as any);
    assert.deepEqual(await gateway.folders(), paginated ? rows : rows.map(row => ({ ...row, parent_id: '' })));
    for (const query of queries) {
      assert.equal(query.include_deleted, 1);
      assert.ok(query.fields.includes('deleted_time'));
      assert.ok(query.fields.includes('user_updated_time'));
      assert.deepEqual(query.fields, queries[0].fields);
    }
  }
});


test('whole notebook soft deletion propagates to descendants and notes, restoration makes them visible again', async () => {
  const { host, app, tick } = await setup();
  host.notebooks.get('deleted')!.deleted_time = 0;
  await app.dispatch({ action: 'refresh', requestId: 'before-delete' });
  assert.ok((await app.snapshot()).tasks.some(task => task.noteId === 'child-note'));
  await host.data.delete(['folders', 'deleted']); tick();
  assert.ok(host.notebooks.get('child')!.deleted_time);
  assert.ok(host.notes.get('child-note')!.deleted_time);
  await app.dispatch({ action: 'refresh', checkChanges: true, requestId: 'whole-delete' });
  assert.ok(!(await app.snapshot()).tasks.some(task => task.noteId === 'child-note'));
  for (const id of ['deleted', 'child']) host.notebooks.get(id)!.deleted_time = 0;
  host.notes.get('child-note')!.deleted_time = 0; tick();
  await app.dispatch({ action: 'refresh', checkChanges: true, requestId: 'whole-restore' });
  assert.ok((await app.snapshot()).tasks.some(task => task.noteId === 'child-note'));
});

test('deleted ancestor hides recurring tasks and forecasts during partial sync without writing their notes', async () => {
  const { host, app, tick } = await setup();
  host.notebooks.get('deleted')!.deleted_time = 0;
  await app.dispatch({ action: 'refresh', requestId: 'before-recurring' });
  const created = await app.dispatch({ action: 'createTask', requestId: 'recurring', input: {
    ...input('child'), schedule: { kind: 'allDay', date: '2026-11-04', zone: 'UTC' }, mode: 'archive',
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  assert.equal(created.status, 'saved', created.message);
  const query = { view: 'week' as const, date: '2026-11-04', deviceZone: 'UTC' };
  assert.ok((await app.snapshot(query)).items.some(item => item.kind === 'projected'));
  host.notebooks.get('deleted')!.deleted_time = 100; tick();
  const callCount = host.calls.length;
  await app.dispatch({ action: 'refresh', checkChanges: true, requestId: 'partial-sync' });
  const snapshot = await app.snapshot(query);
  assert.ok(!snapshot.tasks.some(task => task.seriesId === created.seriesId));
  assert.ok(!snapshot.items.some(item => item.seriesId === created.seriesId));
  assert.ok(!host.calls.slice(callCount).some(call => ['put', 'post', 'delete', 'userDataSet', 'userDataDelete'].includes(call.method) && call.path.includes(created.noteId!)));
  host.notebooks.get('deleted')!.deleted_time = 0; tick();
  await app.dispatch({ action: 'refresh', checkChanges: true, requestId: 'partial-restore' });
  assert.ok((await app.snapshot(query)).items.some(item => item.seriesId === created.seriesId));
});

test('cosmetic folder changes update snapshots without scanning notes and mixed changes stay incremental', async () => {
  const { host, app, tick } = await setup();
  host.notebooks.set('other', { id: 'other', title: 'Other' });
  await app.dispatch({ action: 'refresh', requestId: 'add-other' });
  for (const change of ['rename', 'reorder', 'reparent', 'note-edit']) {
    const before = (await app.snapshot()).snapshotVersion;
    host.notebooks.get('live')!.title = change;
    if (change === 'reorder') {
      const folder = host.notebooks.get('live')!;
      host.notebooks.delete('live'); host.notebooks.set('live', folder);
    }
    if (change === 'reparent') host.notebooks.get('live')!.parent_id = 'other';
    if (change === 'note-edit') await host.data.put(['notes', 'live-note'], {}, { title: 'Updated task' });
    tick(); const offset = host.calls.length;
    await app.dispatch({ action: 'refresh', checkChanges: true, requestId: change });
    const calls = host.calls.slice(offset);
    assert.ok(!calls.some(call => call.path[0] === 'notes' && call.path.length === 1 && call.query?.fields?.includes('title')), change);
    assert.ok(!calls.some(call => call.path[0] === 'tags' && call.path.length === 1), change);
    if (change !== 'note-edit') assert.ok(!calls.some(call => call.path[0] === 'notes' && call.path.length > 1), change);
    const snapshot = await app.snapshot();
    assert.ok(snapshot.snapshotVersion > before, change);
    assert.equal(snapshot.folders.find(folder => folder.id === 'live')!.title, change);
    if (change === 'note-edit') assert.equal(snapshot.tasks.find(task => task.noteId === 'live-note')!.title, 'Updated task');
  }
  assert.deepEqual((await app.snapshot({ view: 'all', notebookIds: ['other'] })).items.map(item => item.noteId), ['live-note']);
});

test('focus ignores preexisting trash after full scans but detects deletion and restoration', async () => {
  const { host, app, tick } = await setup();
  // The full catalog excludes Trash; the lightweight version catalog includes it.
  const gateway = new JoplinGateway(host);
  assert.ok(!(await gateway.allNotes()).some(note => note.id === 'trashed-note'));
  assert.ok((await gateway.noteVersions()).some(note => note.id === 'trashed-note'));
  for (let round = 0; round < 2; round++) {
    await app.dispatch({ action: 'refresh', requestId: `full-${round}` });
    tick(); const offset = host.calls.length;
    await app.dispatch({ action: 'refresh', checkChanges: true, requestId: `focus-${round}` });
    assert.ok(!host.calls.slice(offset).some(call => call.path[0] === 'notes' && call.path.length > 1));
  }
  await host.data.delete(['notes', 'live-note']);
  tick();
  await app.dispatch({ action: 'refresh', checkChanges: true, requestId: 'detect-delete' });
  assert.ok(!(await app.snapshot()).tasks.some(task => task.noteId === 'live-note'));
  await app.dispatch({ action: 'refresh', requestId: 'full-while-deleted' });
  await host.data.put(['notes', 'live-note'], {}, { deleted_time: 0 });
  await host.data.put(['notes', 'trashed-note'], {}, { deleted_time: 0 });
  tick();
  await app.dispatch({ action: 'refresh', checkChanges: true, requestId: 'detect-restored' });
  const tasks = (await app.snapshot()).tasks;
  assert.ok(tasks.some(task => task.noteId === 'live-note'));
  assert.ok(tasks.some(task => task.noteId === 'trashed-note'));
});
