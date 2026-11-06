import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { startPlugin } from '../../src/bootstrap';
import { MemoryJoplin } from '../support/memory-joplin';
import { addDays } from '../../src/domain/dates';
import { timezoneAdapter } from '../../src/adapters/calendar/timezoneAdapter';

async function setup() {
  const host = new MemoryJoplin() as any;
  host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('notebook', { id: 'notebook', title: 'Book' });
  host.seedNote({ id: 'selected' });
  host.seedNote({ id: 'target' });
  host.seedNote({ id: 'other' });
  host.seedNote({ id: 'ordinary', is_todo: 0 });
  const commands = new Map<string, any>();
  const menus: any[] = [], notices: string[] = [];
  host.workspace = { selectedNote: async () => ({ id: 'selected' }) };
  host.commands = { execute: async () => {}, register: async (c: any) => commands.set(c.name, c) };
  host.views = {
    dialogs: { showMessageBox: async (message: string) => { notices.push(message); return 0; } },
    menuItems: { create: async (...args: any[]) => { menus.push(args); } },
    panels: { create: async () => 'panel', setHtml: async () => {}, addScript: async () => {}, onMessage: async () => {}, postMessage() {}, show: async () => {} },
  };
  const runtime = await startPlugin(host);
  return { ...runtime, host, commands, menus, notices };
}

test('issue73: five flat native menu entries target right-clicked notes and support batch dates', async () => {
  const runtime = await setup();
  try {
    assert.equal(runtime.menus.length, 5);
    assert.ok(runtime.menus.every(entry => entry[2] === 'noteListContextMenu'));
    for (const entry of runtime.menus) {
      const command = runtime.commands.get(entry[1]);
      assert.equal(command.enabledCondition, 'noteIsTodo || multipleNotesSelected');
      assert.ok(command.label.startsWith('Journey Tasks: '));
    }
    const today = timezoneAdapter.localDate(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
    for (const offset of [0, 1, 7]) {
      await runtime.commands.get(`journey.date${offset}`).execute(['target', 'other', 'ordinary']);
      const snapshot = await runtime.app.snapshot();
      for (const id of ['target', 'other']) {
        const schedule = snapshot.tasks.find(task => task.noteId === id)!.schedule;
        assert.equal(schedule.kind === 'none' ? '' : schedule.date, addDays(today, offset));
      }
      assert.equal(snapshot.tasks.find(task => task.noteId === 'selected')!.schedule.kind, 'none');
    }
    await runtime.commands.get('journey.dateClear').execute(['target', 'other']);
    assert.ok((await runtime.app.snapshot()).tasks.filter(task => ['target', 'other'].includes(task.noteId)).every(task => task.schedule.kind === 'none'));
    assert.equal(runtime.host.notes.get('ordinary').is_todo, 0);
    await runtime.commands.get('journey.openSelectedTask').execute(['target']);
    const reply = await runtime.panel.handleMessage({ protocolVersion: 1, requestId: 'editor', action: 'snapshot' });
    assert.deepEqual(reply.uiAction, { type: 'edit', noteId: 'target' });
  } finally { runtime.dispose(); }
});

test('issue73: native date shortcuts retain clock time and zone and report repeating date-clear errors', async () => {
  const runtime = await setup();
  try {
    const made = await runtime.app.dispatch({ action: 'createTask', requestId: 'repeat', input: {
      title: 'Repeating', notebookId: 'notebook', schedule: { kind: 'timed', date: '2026-11-03', time: '14:30:00', zone: 'Asia/Shanghai', instant: Date.parse('2026-11-03T06:30:00Z'), offsetMinutes: 480 },
      recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } }, mode: 'continuous',
    } });
    assert.equal(made.status, 'saved');
    await runtime.commands.get('journey.date1').execute([made.noteId]);
    const before = (await runtime.app.snapshot()).tasks.find(task => task.noteId === made.noteId && !task.historical)!;
    assert.equal(before.schedule.kind, 'timed');
    if (before.schedule.kind === 'timed') { assert.equal(before.schedule.time, '14:30:00'); assert.equal(before.schedule.zone, 'Asia/Shanghai'); }
    await runtime.commands.get('journey.date0').execute(['target']);
    runtime.host.seedNote({ id: 'completed', todo_completed: Date.now() });
    await runtime.commands.get('journey.dateClear').execute([made.noteId, 'ordinary', 'completed', 'target']);
    assert.equal(runtime.notices.length, 1);
    assert.match(runtime.notices[0]!, /1.*2.*1/s);
    assert.equal((await runtime.app.snapshot()).tasks.find(task => task.noteId === 'target')!.schedule.kind, 'none', 'failure on the first note does not stop later changes');
    assert.deepEqual((await runtime.app.snapshot()).tasks.find(task => task.noteId === made.noteId && !task.historical)!.schedule, before.schedule);
  } finally { runtime.dispose(); }
});

test('issue73: native open routes current tasks to settings and historical notes to their series log', async () => {
  const React = await import('react');
  const { act, create } = await import('react-test-renderer');
  const { App } = await import('../../src/panel/App');
  const { TaskHistory } = await import('../../src/panel/TaskHistory');
  const { TaskContextMenu } = await import('../../src/panel/TaskContextMenu');
  const runtime = await setup();
  const names = ['window', 'document', 'navigator', 'webviewApi', 'IS_REACT_ACT_ENVIRONMENT'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const listeners = new Map<string, Function>();
  const noop = () => {};
  let failSnapshot = false;
  let snapshotGate: Promise<void> | undefined;
  const values = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { addEventListener: (name: string, fn: Function) => listeners.set(name, fn), removeEventListener: noop, innerWidth: 1000, innerHeight: 800 },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    navigator: { platform: 'MacIntel' },
    webviewApi: { onMessage: noop, postMessage: async (message: any) => {
      if (message.action === 'snapshot') await snapshotGate;
      if (failSnapshot && message.action === 'snapshot') return Promise.reject(new Error('Snapshot unavailable'));
      return runtime.panel.handleMessage(message);
    } },
  };
  let renderer: ReturnType<typeof create> | undefined;
  try {
    const notes = new Map<string, string>();
    for (const mode of ['archive', 'continuous'] as const) {
      const made = await runtime.app.dispatch({ action: 'createTask', requestId: `open-${mode}`, input: {
        title: `History ${mode}`, notebookId: 'notebook', mode,
        schedule: { kind: 'allDay', date: '2020-01-01', zone: 'UTC' },
        recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
      } });
      assert.equal(made.status, 'saved');
      assert.equal((await runtime.app.dispatch({ action: 'complete', requestId: `finish-${mode}`, seriesId: made.seriesId })).status, 'saved');
      notes.set(mode, made.noteId!);
    }
    Object.entries(values).forEach(([name, value]) => Object.defineProperty(globalThis, name, { configurable: true, value }));
    await act(async () => { renderer = create(React.createElement(App)); });
    const openMenu = async () => {
      await act(async () => {
        const header = renderer!.root.findAllByProps({ className: 'drawer-header' })[0];
        header?.findByType('button').props.onClick();
      });
      await act(async () => {
        const row = renderer!.root.findAllByType('article').find(row => row.props.onContextMenu)!;
        row.props.onContextMenu({ preventDefault: noop, clientX: 20, clientY: 20, currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } });
      });
      assert.equal(renderer!.root.findAllByType(TaskContextMenu).length, 1);
      assert.ok(renderer!.root.findAllByType('article').some(row => row.props['data-selected']));
      await act(async () => {
        renderer!.root.findAllByType('button').find(button => button.props['data-submenu'] === 'date')!.props.onClick();
      });
      assert.equal(renderer!.root.findAllByProps({ className: 'menu-submenu' }).length, 1);
    };
    const assertMenuClosed = () => {
      assert.equal(renderer!.root.findAllByType(TaskContextMenu).length, 0);
      assert.equal(renderer!.root.findAllByProps({ className: 'menu-shade' }).length, 0);
      assert.equal(renderer!.root.findAllByProps({ className: 'menu-submenu' }).length, 0);
      assert.ok(renderer!.root.findAllByType('article').every(row => !row.props['data-selected']));
    };
    const initialForms = renderer!.root.findAllByType('form').length;
    await openMenu();
    await act(async () => { listeners.get('journey-ui-action')!({ detail: { type: 'edit', noteId: 'target' } }); });
    assertMenuClosed();
    assert.ok(renderer!.root.findAllByType('form').length > initialForms);
    assert.ok(renderer!.root.findAllByType('input').some(input => input.props.value === 'Task'));

    const open = async (noteId: string) => act(async () => {
      listeners.get('journey-ui-action')!({ detail: { type: 'edit', noteId } });
    });
    const errors = () => renderer!.root.findAll(node => typeof node.type === 'string' && node.props.className === 'error');
    await openMenu();
    await open('ordinary');
    assertMenuClosed();
    assert.ok(errors().length, 'missing tasks still show an error');
    await openMenu();
    await open(notes.get('archive')!);
    assertMenuClosed();
    let history = renderer!.root.findByType(TaskHistory);
    assert.equal(history.props.title, 'History archive');
    assert.ok(history.props.entries.some((entry: any) => entry.kind === 'completed'));
    assert.equal(errors().length, 0, 'opening history clears the previous error');

    // Keep the history drawer mounted: opening it again must clear errors even
    // when the form type does not change and the drawer effect does not rerun.
    await open('ordinary');
    assert.ok(errors().length);
    await open(notes.get('archive')!);
    history = renderer!.root.findByType(TaskHistory);
    assert.equal(history.props.title, 'History archive');
    assert.equal(errors().length, 0);

    await openMenu();
    await open(notes.get('continuous')!);
    assertMenuClosed();
    assert.equal(renderer!.root.findAllByType(TaskHistory).length, 0, 'a shared carrier with a current period opens settings');
    const { createTranslator } = await import('../../src/i18n');
    const snapshot = await runtime.app.snapshot();
    const { resolveLanguage } = await import('../../src/i18n');
    const t = createTranslator(resolveLanguage(snapshot.preferences.language, snapshot.systemLocale));
    assert.ok(renderer!.root.findAllByType('h2').some(heading => heading.children.includes(t('form.series'))));
    assert.equal(errors().length, 0);

    await openMenu();
    await act(async () => { listeners.get('journey-ui-action')!({ detail: { type: 'series', noteId: notes.get('continuous') } }); });
    assertMenuClosed();
    assert.ok(renderer!.root.findAllByType('h2').some(heading => heading.children.includes(t('form.series'))));

    await openMenu();
    let releaseRead!: () => void;
    snapshotGate = new Promise<void>(resolve => { releaseRead = resolve; });
    await act(async () => { listeners.get('journey-ui-action')!({ detail: { type: 'edit', noteId: 'target' } }); });
    assertMenuClosed();
    await act(async () => { snapshotGate = undefined; releaseRead(); });

    await openMenu();
    failSnapshot = true;
    await open('target');
    assertMenuClosed();
    assert.ok(errors().some(node => node.children.includes('Snapshot unavailable')));
    failSnapshot = false;

    await openMenu();
    await act(async () => { listeners.get('journey-ui-action')!({ detail: { type: 'new' } }); });
    assertMenuClosed();
    assert.ok(renderer!.root.findAllByType('h2').some(heading => heading.children.includes(t('form.new'))));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    names.forEach((name, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
    runtime.dispose();
  }
});

test('issue73: Chinese today labels and native command wording stay consistent', async () => {
  const { createTranslator } = await import('../../src/i18n');
  for (const locale of ['zh-CN', 'zh-TW']) {
    const t = createTranslator(locale);
    assert.equal(t('view.today'), '今天');
    assert.equal(t('commands.setDate', { date: t('view.today') }), locale === 'zh-CN' ? '设为今天' : '設為今天');
  }
});
