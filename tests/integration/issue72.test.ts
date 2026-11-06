import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { App } from '../../src/panel/App';
import { TaskList } from '../../src/panel/TaskViews';
import { TaskFilters } from '../../src/panel/TaskFilters';
import { timezoneAdapter } from '../../src/adapters/calendar/timezoneAdapter';
import { createTranslator } from '../../src/i18n';
import { PanelController } from '../../src/panel/controller';

test('issue72 notebook shortcut opens all tasks including undated tasks and replaces search and notebook filters', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  host.notebooks.set('child', { id: 'child', title: 'Child', parent_id: 'book' });
  host.notebooks.set('other', { id: 'other', title: 'Other' });
  const app = new TaskApplication(host); await app.initialize();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const [title, notebookId, schedule] of [
    ['Dated', 'book', { kind: 'allDay', date: timezoneAdapter.localDate(Date.now(), zone), zone }],
    ['Undated', 'book', { kind: 'none' }],
    ['Child task', 'child', { kind: 'none' }],
    ['Unrelated', 'other', { kind: 'none' }],
  ] as const) {
    await app.dispatch({ action: 'createTask', requestId: title, input: { title, notebookId, schedule } });
  }
  await app.dispatch({ action: 'savePreferences', requestId: 'prefs', preferences: { defaultView: 'today', startupMode: 'fixed' } });
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'webviewApi', 'IS_REACT_ACT_ENVIRONMENT'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const noop = () => {};
  const queries: any[] = [];
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { addEventListener: noop, removeEventListener: noop },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null },
    webviewApi: { onMessage: noop, postMessage: (message: any) => {
      if (message.action === 'snapshot') queries.push(message.query);
      return controller.handleMessage(message);
    } },
  });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    const filters = () => renderer!.root.findByType(TaskFilters);
    await act(async () => { filters().props.onChange(['book', 'other']); filters().props.onSearch('Dated'); });
    const lists = () => renderer!.root.findAllByType(TaskList);
    const datedList = lists().find(list => list.props.items.some((item: any) => item.title === 'Dated'))!;
    assert.ok(lists().every(list => list.props.items.every((item: any) => item.title === 'Dated')));
    let stopped = false;
    const link = datedList.findAllByType('button').find(button => button.props.className === 'task-notebook notebook-link')!;
    const t = createTranslator('en-US');
    assert.equal(link.props['aria-label'], `${t('view.all')} · ${t('field.notebook')}: Book`);
    await act(async () => { link.props.onClick({ stopPropagation() { stopped = true; } }); });
    assert.ok(stopped);
    assert.deepEqual([...new Set(lists().flatMap(list => list.props.items.map((item: any) => item.title)))].sort(), ['Child task', 'Dated', 'Undated']);
    assert.deepEqual(filters().props.selected, ['book']);
    assert.equal(filters().props.search, '');
    assert.equal(queries.at(-1).view, 'all');
    assert.deepEqual((await app.snapshot()).preferences.notebookIds, ['book']);
    assert.equal((await app.snapshot()).preferences.lastView, 'all');
    const calendarButton = renderer!.root.findByProps({ className: 'mode-switch' }).findAllByType('button')[1]!;
    assert.ok(calendarButton);
    await act(async () => { calendarButton.props.onClick(); });
    assert.ok(lists().length > 0, 'calendar contains task lists');
    assert.ok(lists().every(list => list.props.onOpenNotebook === undefined));
    assert.equal(renderer!.root.findAllByType('button').filter(button => button.props.className === 'task-notebook notebook-link').length, 0);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});
