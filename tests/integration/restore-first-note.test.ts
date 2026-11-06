import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { startPlugin } from '../../src/bootstrap';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { LocalIntentStore } from '../../src/adapters/joplin/localIntentStore';
import type { RestoreFirstTarget } from '../../src/services/applicationTypes';
import { MemoryJoplin } from '../support/memory-joplin';

async function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('A', { id: 'A', title: 'A' });
  const notices: { message: string; restore?: RestoreFirstTarget }[] = [];
  const options = { now: () => Date.parse('2026-11-10T00:00:00Z'), onNotice: (message: string, restore?: RestoreFirstTarget) => notices.push({ message, restore }) };
  const app = new TaskApplication(host, options); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'first', input: {
    title: '原始第一篇', notebookId: 'A', mode: 'archive', schedule: { kind: 'allDay', date: '2026-11-01', zone: 'UTC' },
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  assert.equal(made.status, 'saved', made.message);
  const target = { noteId: made.noteId!, seriesId: made.seriesId! };
  await app.dispatch({ action: 'complete', requestId: 'first-complete', noteId: target.noteId });
  const series = (await app.snapshot()).series[0]!;
  const currentId = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!.carrierNoteId;
  host.notes.get(target.noteId)!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'deleted' });
  return { host, app, notices, target, currentId };
}

test('restoring an existing first note changes only deletion state and reuses the existing successor', async () => {
  const { host, app, notices, target, currentId } = await setup();
  assert.deepEqual(notices.at(-1)!.restore, target);
  const before = structuredClone(host.notes.get(target.noteId)!);
  const offset = host.calls.length;
  const restored = await app.dispatch({ action: 'restoreFirstNote', requestId: 'restore', ...target });
  assert.equal(restored.status, 'saved', restored.message);
  assert.equal(host.notes.get(target.noteId)!.deleted_time, 0);
  for (const key of ['id', 'body', 'title', 'user_data', 'parent_id', 'created_time']) assert.deepEqual(host.notes.get(target.noteId)![key], before[key], key);
  const writes = host.calls.slice(offset).filter(call => call.method === 'put' && call.path[0] === 'notes');
  assert.deepEqual(writes.map(call => ({ path: call.path, body: call.body })), [{ path: ['notes', target.noteId], body: { deleted_time: 0 } }]);
  assert.equal(host.notes.size, 2);
  assert.ok((await app.snapshot()).tasks.some(task => task.noteId === currentId));
  const count = host.calls.filter(call => call.method === 'put').length;
  const again = await app.dispatch({ action: 'restoreFirstNote', requestId: 'already-restored', ...target });
  assert.equal(again.status, 'saved', again.message);
  assert.equal(host.calls.filter(call => call.method === 'put').length, count);
  assert.equal(host.notes.size, 2);
});

test('restoring a first note imports saved completion and generates the next occurrence once', async () => {
  const { host, app, notices, target, currentId } = await setup();
  await app.dispatch({ action: 'complete', requestId: 'pending-complete', noteId: currentId });
  assert.deepEqual(notices.at(-1)!.restore, target);
  const restored = await app.dispatch({ action: 'restoreFirstNote', requestId: 'restore', ...target });
  assert.equal(restored.status, 'saved', restored.message);
  assert.equal(host.notes.size, 3);
  assert.equal((await app.snapshot()).series[0]!.consumedCount, 2);
  await app.dispatch({ action: 'restoreFirstNote', requestId: 'again', ...target });
  await app.dispatch({ action: 'refresh', requestId: 'refresh' });
  assert.equal(host.notes.size, 3);
});

for (const kind of ['purged', 'stopped', 'other-series', 'deleted-notebook', 'deleted-ancestor', 'ignored-write'] as const) {
  test(`a stale restore action cannot restore an unavailable or unrelated first note: ${kind}`, async () => {
    const { host, app, target } = await setup();
    const requestTarget = { ...target };
    if (kind === 'purged') host.notes.delete(target.noteId);
    if (kind === 'stopped') {
      host.notes.get(target.noteId)!.deleted_time = 0;
      await app.dispatch({ action: 'refresh', requestId: 'restore-before-stop' });
      await app.dispatch({ action: 'deleteTask', requestId: 'stop', noteId: target.noteId, seriesId: target.seriesId, scope: 'stop' });
      host.notes.get(target.noteId)!.deleted_time = 123;
    }
    if (kind === 'other-series') requestTarget.seriesId = 'unrelated';
    if (kind === 'deleted-notebook') host.notebooks.get('A')!.deleted_time = 123;
    if (kind === 'deleted-ancestor') {
      host.notebooks.set('parent', { id: 'parent', title: 'Parent', deleted_time: 123 });
      host.notebooks.get('A')!.parent_id = 'parent';
    }
    if (kind === 'ignored-write') {
      const put = host.data.put;
      host.data.put = async (path, query, body) => body?.deleted_time === 0 ? structuredClone(host.notes.get(path[1]!)!) : put(path, query, body);
    }
    const before = host.calls.length;
    const result = await app.dispatch({ action: 'restoreFirstNote', requestId: 'restore-invalid', ...requestTarget });
    assert.equal(result.status, 'error');
    const codes = { purged: 'RESTORE_FIRST_MISSING', stopped: 'RESTORE_FIRST_ENDED', 'other-series': 'RESTORE_FIRST_INVALID',
      'deleted-notebook': 'RESTORE_FIRST_NOTEBOOK', 'deleted-ancestor': 'RESTORE_FIRST_NOTEBOOK', 'ignored-write': 'RESTORE_FIRST_FAILED' };
    assert.equal(result.code, codes[kind], result.message);
    if (kind !== 'purged') assert.equal(host.notes.get(target.noteId)!.deleted_time, 123);
    assert.ok(!host.calls.slice(before).some(call => call.method === 'post' || call.path[0] === 'folders' && call.method !== 'get'));
    assert.ok(!(await app.snapshot()).diagnostics.some(d => d.code === result.code), 'native error is not duplicated as a lasting panel warning');
  });
}

test('ordinary note editing cannot clear deleted_time', async () => {
  const { host, app, target } = await setup();
  await assert.rejects(() => app.gateway.patchNote(target.noteId, { deleted_time: 0 } as any), { code: 'UNSAFE_PATCH' });
  assert.equal(host.notes.get(target.noteId)!.deleted_time, 123);
});

for (const choice of ['cancel', 'restore-first', 'purged-before-click', 'disposed-before-click'] as const) test(`native restore dialog handles ${choice} without blocking the task queue`, async () => {
  const host = new MemoryJoplin() as any; host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('A', { id: 'A', title: 'A' });
  const store = new LocalIntentStore(host, () => 'device'); await store.savePreferences({ language: choice === 'purged-before-click' ? 'fr' : 'zh-CN' });
  let resolveOpen: ((value: { id: string }) => void) | undefined;
  const opened: string[] = [], html: string[] = [], buttons: { id: string; title: string }[][] = [];
  const fallback: string[] = [];
  host.views = {
    panels: { create: async (id: string) => id, setHtml: async () => {}, addScript: async () => {}, onMessage: async () => {}, postMessage() {}, show: async () => {} },
    dialogs: { create: async (id: string) => id, setHtml: async (_id: string, value: string) => { html.push(value); },
      setButtons: async (_id: string, value: { id: string; title: string }[]) => { buttons.push(value); },
      open: async (id: string) => { opened.push(id); return new Promise<{ id: string }>(resolve => { resolveOpen = resolve; }); },
      showMessageBox: async (value: string) => { fallback.push(value); return 0; } },
  };
  host.commands = { register: async () => {}, execute: async () => {} };
  const runtime = await startPlugin(host);
  try {
    const made = await runtime.app.dispatch({ action: 'createTask', requestId: 'create', input: {
      title: '<img src=x onerror=alert(1)>', notebookId: 'A', mode: 'continuous', schedule: { kind: 'allDay', date: '2026-01-01', zone: 'UTC' },
      recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
    } });
    host.notes.get(made.noteId!)!.deleted_time = 123;
    await runtime.app.dispatch({ action: 'refresh', requestId: 'delete', noteIds: [made.noteId!] });
    // This completes even while the native dialog is waiting for user input.
    await runtime.app.dispatch({ action: 'savePreferences', requestId: 'while-dialog', preferences: { showCompleted: true } });
    for (let i = 0; i < 20 && !resolveOpen; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(opened.length, 1);
    assert.deepEqual(buttons[0], choice === 'purged-before-click'
      ? [{ id: 'restore-first', title: 'Restaurer' }, { id: 'cancel', title: 'Pas maintenant' }]
      : [{ id: 'restore-first', title: '恢复' }, { id: 'cancel', title: '暂不恢复' }]);
    assert.match(html[0]!, /&lt;img/);
    assert.doesNotMatch(html[0]!, /<img/);
    if (choice === 'purged-before-click') host.notes.delete(made.noteId!);
    if (choice === 'disposed-before-click') runtime.dispose();
    resolveOpen!({ id: choice === 'cancel' ? 'cancel' : 'restore-first' });
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
    if (choice !== 'disposed-before-click') await runtime.app.dispatch({ action: 'refresh', requestId: 'after-choice' });
    if (choice === 'purged-before-click') {
      assert.equal(host.notes.has(made.noteId!), false);
      assert.equal(fallback.length, 1);
      assert.match(fallback[0]!, /définitivement/);
    } else {
      assert.equal(host.notes.get(made.noteId!)!.deleted_time, choice === 'restore-first' ? 0 : 123);
      assert.equal(host.notes.size, 1);
      assert.equal(fallback.length, 0);
    }
  } finally { runtime.dispose(); }
});


test('a permanently deleted first note has no restore action', async () => {
  const { host, app, notices, target } = await setup();
  await app.dispatch({ action: 'restoreFirstNote', requestId: 'restore', ...target });
  const count = notices.length;
  host.notes.delete(target.noteId);
  await app.dispatch({ action: 'refresh', requestId: 'purged' });
  assert.equal(notices.length, count + 1);
  assert.equal(notices.at(-1)!.restore, undefined);
});

test('copied series metadata cannot authorize restoring a different note', async () => {
  const { host, app, target } = await setup();
  host.seedNote({ ...structuredClone(host.notes.get(target.noteId)!), id: 'other-note' });
  const result = await app.dispatch({ action: 'restoreFirstNote', requestId: 'restore-copy', noteId: 'other-note', seriesId: target.seriesId });
  assert.equal(result.code, 'RESTORE_FIRST_INVALID');
  assert.equal(host.notes.get('other-note')!.deleted_time, 123);
  assert.equal(host.notes.get(target.noteId)!.deleted_time, 123);
});

test('a notebook deleted during restoration cannot produce a false successful restore result', async () => {
  const { host, app, target } = await setup();
  const put = host.data.put;
  host.data.put = async (path, query, body) => {
    const result = await put(path, query, body);
    if (body?.deleted_time === 0) host.notebooks.get('A')!.deleted_time = 123;
    return result;
  };
  const result = await app.dispatch({ action: 'restoreFirstNote', requestId: 'raced-folder', ...target });
  assert.equal(result.code, 'RESTORE_FIRST_NOTEBOOK');
  assert.equal(host.notebooks.get('A')!.deleted_time, 123, 'never restore a whole notebook as a side effect');
  assert.equal(host.notes.size, 2);
});

test('restoration refreshes an outdated notebook catalog before continuing the series', async () => {
  const { host, app, target, currentId } = await setup();
  host.notebooks.get('A')!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'notebook-trashed' });
  assert.ok(!(await app.snapshot()).folders.some(folder => folder.id === 'A'));
  // The notebook is restored elsewhere before the user chooses the still-open restore action.
  host.notebooks.get('A')!.deleted_time = 0;
  const result = await app.dispatch({ action: 'restoreFirstNote', requestId: 'restore-after-folder', ...target });
  assert.equal(result.status, 'saved', result.message);
  const snapshot = await app.snapshot();
  assert.ok(snapshot.folders.some(folder => folder.id === 'A'));
  assert.ok(snapshot.tasks.some(task => task.noteId === currentId));
  assert.equal(host.notes.size, 2);
});
