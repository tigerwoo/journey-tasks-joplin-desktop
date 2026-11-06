import test from 'node:test';
import assert from 'node:assert/strict';
import { groupListItems } from '../../src/panel/viewModel';
import type { PreviewItem } from '../../src/shared/models';
import { TaskApplication } from '../../src/services/taskApplication';
import { PanelController } from '../../src/panel/controller';
import { LocalIntentStore } from '../../src/adapters/joplin/localIntentStore';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { LOCAL_SETTINGS_PREFIX } from '../../src/shared/pluginIdentity';
import { MemoryJoplin } from '../support/memory-joplin';

function row(id: string, title: string, createdAt?: number, date = ''): PreviewItem {
  return { id, title, createdAt, date, kind: 'actual', priority: 'none', pinned: false, overdue: false, completed: false,
    schedule: date ? { kind: 'allDay', date, zone: 'UTC' } : { kind: 'none' } };
}
const ids = (rows: PreviewItem[]) => rows.map(item => item.id);
test('issue68 six sort modes use natural names, creation timestamps, fixed fallbacks and missing dates last', () => {
  const rows = [row('a', 'Task 10', 100, '2026-10-30'), row('b', 'Task 2', 300, '2026-10-31'), row('c', 'Task 1', 200)];
  const order = (sort: Parameters<typeof groupListItems>[2]) => ids(groupListItems(rows, 'notebook', sort)[0]!.items);
  assert.deepEqual(order('nameAsc'), ['c', 'b', 'a']);
  assert.deepEqual(order('nameDesc'), ['a', 'b', 'c']);
  assert.deepEqual(order('createdAsc'), ['a', 'c', 'b']);
  assert.deepEqual(order('createdDesc'), ['b', 'c', 'a']);
  assert.deepEqual(order('scheduledAsc'), ['a', 'b', 'c']);
  assert.deepEqual(order('scheduledDesc'), ['b', 'a', 'c']);
  const undated = [row('old', 'Same', 10), row('missing', 'Same'), row('new', 'Same', 20), row('done', 'Same', 30)];
  undated[3]!.completed = true;
  for (const sort of ['scheduledAsc', 'scheduledDesc', 'nameAsc', 'nameDesc'] as const)
    assert.deepEqual(ids(groupListItems(undated, 'time', sort)[0]!.items), ['done', 'new', 'old', 'missing']);
  assert.deepEqual(ids(groupListItems(undated, 'time', 'createdAsc')[0]!.items), ['old', 'new', 'done', 'missing']);
});

test('issue68 group categories never reverse and all-day tasks precede timed tasks in either direction', () => {
  const pinned = { ...row('pin', 'Pin', 10), pinned: true };
  const overdue = { ...row('late', 'Late', 20, '2026-10-01'), overdue: true };
  const allDay = row('allDay', 'All day', 30, '2026-10-31');
  const timed: PreviewItem = { ...row('timed', 'Timed', 40, '2026-10-31'), schedule: { kind: 'timed', date: '2026-10-31', time: '12:00', zone: 'UTC', instant: Date.parse('2026-10-31T12:00Z') } };
  for (const sort of ['scheduledAsc', 'scheduledDesc'] as const) {
    const result = groupListItems([row('inbox', 'Inbox', 50), timed, overdue, pinned, allDay], 'time', sort);
    assert.deepEqual(result.map(group => group.kind), ['pinned', 'overdue', 'date', 'inbox']);
    assert.deepEqual(ids(result[2]!.items), ['allDay', 'timed']);
  }
});

test('issue68 old order migrates read-only, new sort and notebook selections survive restart', async () => {
  const host = new MemoryJoplin();
  const store = new LocalIntentStore(host, () => 'device'); await store.initialize();
  for (const order of ['ascending', 'descending']) {
    const raw = JSON.stringify({ listOrder: order, listGrouping: 'notebook' });
    host.settingsValues.set(LOCAL_SETTINGS_PREFIX + 'preferences', raw);
    assert.equal((await store.preferences()).listSort, order === 'descending' ? 'scheduledDesc' : 'scheduledAsc');
    assert.equal(host.settingsValues.get(LOCAL_SETTINGS_PREFIX + 'preferences'), raw);
  }
  await store.savePreferences({ listSort: 'createdDesc', notebookIds: ['child'] });
  const restored = await new LocalIntentStore(host, () => 'other').preferences();
  assert.equal(restored.listSort, 'createdDesc'); assert.deepEqual(restored.notebookIds, ['child']);
  assert.equal(restored.listOrder, 'descending');
  for (const patch of [{ listSort: 'bad' }, { notebookIds: [1] }, { notebookIds: null }]) await assert.rejects(store.savePreferences(patch as any));
});

test('issue68 bridge preserves multi-notebook and search queries; parent selections include descendants', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  for (const [id, parent_id] of [['parent', ''], ['child', 'parent'], ['grandchild', 'child'], ['other', '']]) host.notebooks.set(id!, { id, parent_id, title: id });
  for (const id of ['parent', 'child', 'grandchild', 'other']) host.seedNote({ id, parent_id: id, title: `HELLO ${id}` });
  const app = new TaskApplication(host); await app.initialize();
  const controller = new PanelController({} as any, app);
  const snapshot = async (query: any) => {
    const reply = await controller.handleMessage({ protocolVersion: 1, requestId: 'query', action: 'snapshot', query: { view: 'inbox', ...query } });
    assert.equal(reply.ok, true, reply.error); return reply.snapshot;
  };
  assert.deepEqual((await snapshot({ notebookIds: ['parent'] })).items.map((item: PreviewItem) => item.noteId).sort(), ['child', 'grandchild', 'parent']);
  assert.deepEqual((await snapshot({ notebookIds: ['child'], search: ' hello  GRANDCHILD ' })).items.map((item: PreviewItem) => item.noteId), ['grandchild']);
  assert.deepEqual((await snapshot({ notebookIds: ['other', 'child'] })).items.map((item: PreviewItem) => item.noteId).sort(), ['child', 'grandchild', 'other']);
  assert.equal((await controller.handleMessage({ protocolVersion: 1, requestId: 'query', action: 'snapshot', query: { notebookIds: [1] } })).ok, false);
  assert.equal((await controller.handleMessage({ protocolVersion: 1, requestId: 'query', action: 'snapshot', query: { search: [] } })).ok, false);
  await app.dispatch({ action: 'savePreferences', requestId: 'filter', preferences: { notebookIds: ['child'] } });
  assert.equal((await snapshot({})).items.length, 2);
  assert.equal((await snapshot({ notebookIds: [] })).items.length, 4);
  app.dispose();
});

test('issue68 freshly created inbox tasks sort newest first before and after restart', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  let now = Date.parse('2026-10-31T12:00Z');
  const app = new TaskApplication(host, { now: () => now }); await app.initialize();
  for (const name of ['Old', 'New']) {
    now += 1000;
    const result = await app.dispatch({ action: 'createTask', requestId: name, input: { title: name, notebookId: 'book', schedule: { kind: 'none' } } });
    assert.equal(result.status, 'saved', result.message);
  }
  const sorted = async (application: TaskApplication) => groupListItems((await application.snapshot({ view: 'inbox' })).items)[0]!.items.map(item => item.title);
  assert.deepEqual(await sorted(app), ['New', 'Old']); app.dispose();
  const restarted = new TaskApplication(host); await restarted.initialize();
  assert.deepEqual(await sorted(restarted), ['New', 'Old']); restarted.dispose();
});

test('issue68 recurring periods and future previews use root creation time and match native and series titles', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  host.notebooks.set('other', { id: 'other', title: 'Other' });
  let now = Date.parse('2026-10-31T12:00Z');
  const app = new TaskApplication(host, { now: () => now }); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'repeat', input: {
    title: 'Series name', notebookId: 'book', schedule: { kind: 'allDay', date: '2026-10-31', zone: 'UTC' }, mode: 'archive',
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  assert.equal(made.status, 'saved', made.message);
  const rootCreated = (await app.snapshot({ view: 'all' })).tasks[0]!.createdAt;
  now += 5000;
  const done = await app.dispatch({ action: 'complete', requestId: 'complete', seriesId: made.seriesId });
  assert.equal(done.status, 'saved', done.message);
  let snapshot = await app.snapshot({ view: 'week', date: '2026-11-01', deviceZone: 'UTC' });
  const active = snapshot.tasks.find(task => !task.historical)!;
  assert.notEqual(active.noteId, made.noteId);
  assert.ok(snapshot.items.some(item => item.kind === 'projected'));
  assert.ok(snapshot.tasks.every(task => task.createdAt === rootCreated));
  assert.ok(snapshot.items.every(item => item.createdAt === rootCreated));
  await host.data.put(['notes', active.noteId], {}, { title: 'Native alias' });
  await app.dispatch({ action: 'refresh', requestId: 'rename', noteIds: [active.noteId] });
  for (const search of ['Series', 'Native', 'series alias']) {
    snapshot = await app.snapshot({ view: 'week', date: '2026-11-01', deviceZone: 'UTC', search, notebookIds: ['book'] });
    assert.ok(snapshot.items.some(item => item.kind === 'actual'), search);
    assert.ok(snapshot.items.some(item => item.kind === 'projected'), search);
  }
  assert.equal((await app.snapshot({ view: 'week', date: '2026-11-01', deviceZone: 'UTC', notebookIds: ['other'] })).items.length, 0);
  app.dispose();
});

test('issue68 panel filters/search clear hidden selections, retain search across views and reset it on reopen', async () => {
  const React = await import('react');
  const { act, create } = await import('react-test-renderer');
  const { App } = await import('../../src/panel/App');
  const { TaskFilters } = await import('../../src/panel/TaskFilters');
  const { ListSortMenu } = await import('../../src/panel/ListSortMenu');
  const { TaskList } = await import('../../src/panel/TaskViews');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  for (const id of ['a', 'b']) { host.notebooks.set(id, { id, title: id }); host.seedNote({ id, title: `Task ${id}`, parent_id: id }); }
  const app = new TaskApplication(host); await app.initialize();
  await app.local.savePreferences({ defaultView: 'inbox', language: 'en' });
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const noop = () => {};
  Object.assign(globalThis, {
    window: { addEventListener: noop, removeEventListener: noop },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    webviewApi: { onMessage: noop, postMessage: (message: any) => controller.handleMessage(message) },
  });
  let renderer: import('react-test-renderer').ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    const filters = () => renderer!.root.findByType(TaskFilters);
    const lists = () => renderer!.root.findAllByType(TaskList);
    const visible = () => lists().flatMap(list => list.props.items as PreviewItem[]);
    assert.equal(visible().length, 2);
    await act(async () => lists()[0]!.props.onToggleSelection(visible()[0]));
    assert.equal(lists()[0]!.props.selectedIds.size, 1);
    await act(async () => filters().props.onSearch('Task b'));
    assert.deepEqual(visible().map(item => item.title), ['Task b']);
    assert.equal(lists()[0]!.props.selectedIds.size, 0);
    const allButton = renderer!.root.findAllByType('button').find(button => button.props.children?.[1] === 'All');
    assert.ok(allButton);
    await act(async () => allButton!.props.onClick());
    assert.equal(filters().props.search, 'Task b');
    await act(async () => filters().props.onChange(['a']));
    assert.equal(visible().length, 0);
    assert.ok(renderer!.root.findAllByType('p').some(node => node.props.children === 'No tasks match these filters'));
    await act(async () => filters().props.onSearch(''));
    assert.deepEqual(visible().map(item => item.noteId), ['a']);
    const menu = renderer!.root.findByType(ListSortMenu);
    await act(async () => menu.props.onChange({ listSort: 'nameDesc' }));
    assert.equal((await app.local.preferences()).listSort, 'nameDesc');
    await act(async () => filters().props.onSearch('missing'));
    await act(async () => renderer!.unmount());
    await act(async () => { renderer = create(React.createElement(App)); });
    assert.equal(filters().props.search, '');
    assert.deepEqual(filters().props.selected, ['a']);
    assert.deepEqual(visible().map(item => item.noteId), ['a']);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});
