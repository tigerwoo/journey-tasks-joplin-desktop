import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';

async function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('A', { id: 'A', title: 'A' });
  const notices: string[] = [];
  const app = new TaskApplication(host, { onNotice: message => { notices.push(message); } });
  await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'create', input: {
    title: 'First', notebookId: 'A', mode: 'archive', schedule: { kind: 'allDay', date: '2026-11-01', zone: 'UTC' },
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  assert.equal(made.status, 'saved', made.message);
  assert.equal((await app.dispatch({ action: 'complete', requestId: 'complete', noteId: made.noteId! })).status, 'saved');
  return { host, app, notices, made };
}

test('fake note deletion retains trash metadata until explicit permanent deletion', async () => {
  const host = new MemoryJoplin();
  const before = host.seedNote({ id: 'note', body: 'body', user_data: '{"x":1}' });
  await host.data.delete(['notes', 'note']);
  assert.ok(host.notes.get('note')!.deleted_time);
  assert.equal(host.notes.get('note')!.body, before.body);
  assert.equal(host.notes.get('note')!.user_data, before.user_data);
  await host.data.delete(['notes', 'note'], { permanent: 1 });
  assert.equal(host.notes.has('note'), false);
});

test('confirmed plugin deletion of historical first note is silent, restored external deletion alerts again', async () => {
  const { host, app, notices, made } = await setup();
  const deleted = await app.dispatch({ action: 'deleteNativeTask', requestId: 'delete', noteId: made.noteId! });
  assert.equal(deleted.status, 'saved', deleted.message);
  assert.ok(host.notes.get(made.noteId!)!.deleted_time);
  await app.dispatch({ action: 'refresh', requestId: 'repeat' });
  assert.deepEqual(notices, []);
  host.notes.get(made.noteId!)!.deleted_time = 0;
  await app.dispatch({ action: 'refresh', requestId: 'restored' });
  await host.data.delete(['notes', made.noteId!]);
  await app.dispatch({ action: 'refresh', requestId: 'external-delete' });
  assert.equal(notices.length, 1);
  await app.dispatch({ action: 'refresh', requestId: 'external-repeat' });
  assert.equal(notices.length, 1);
});

test('failed plugin deletion cannot suppress a subsequent external deletion', async () => {
  const { host, app, notices, made } = await setup();
  host.failNext('delete', `notes/${made.noteId}`);
  assert.equal((await app.dispatch({ action: 'deleteNativeTask', requestId: 'failed', noteId: made.noteId! })).status, 'error');
  await host.data.delete(['notes', made.noteId!]);
  await app.dispatch({ action: 'refresh', requestId: 'external' });
  assert.equal(notices.length, 1);
});

test('unchanged ended journals reuse receipts without per-member reads or rename writes', async () => {
  const { host, app, made } = await setup();
  assert.equal((await app.dispatch({ action: 'deleteTask', requestId: 'stop', noteId: made.noteId!, seriesId: made.seriesId!, scope: 'stop' })).status, 'saved');
  const series = (await app.snapshot()).series[0]!;
  const current = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!.carrierNoteId;
  host.notes.get(current)!.title = 'Renamed';
  const offset = host.calls.length;
  await app.dispatch({ action: 'refresh', requestId: 'rename' });
  const calls = host.calls.slice(offset);
  assert.equal(calls.filter(call => call.method === 'userDataSet' && call.path[1]?.startsWith('v3:ended:')).length, 0);
  assert.equal(calls.filter(call => call.method === 'get' && call.path[0] === 'notes' && call.path[1] === current).length, 0);
  host.notes.get(made.noteId!)!.deleted_time = 123;
  await app.dispatch({ action: 'refresh', requestId: 'trash' });
  assert.equal((await app.snapshot()).tasks.find(task => task.noteId === current)!.title, 'Renamed');
});

test('lost deletion response still suppresses the already confirmed deletion notice', async () => {
  const { host, app, notices, made } = await setup();
  host.failNext('delete', `notes/${made.noteId}`, true);
  assert.equal((await app.dispatch({ action: 'deleteNativeTask', requestId: 'lost-response', noteId: made.noteId! })).status, 'error');
  assert.ok(host.notes.get(made.noteId!)!.deleted_time);
  await app.dispatch({ action: 'refresh', requestId: 'after-lost-response' });
  assert.deepEqual(notices, []);
});

test('notice language follows the current preference after initialization', async () => {
  const { app } = await setup();
  await app.dispatch({ action: 'savePreferences', requestId: 'language', preferences: { language: 'fr' } });
  assert.equal(await app.interfaceLocale(), 'fr');
});
