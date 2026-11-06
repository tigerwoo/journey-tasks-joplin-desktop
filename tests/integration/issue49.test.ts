import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { SeriesEditor, TaskForm } from '../../src/panel/App';
import { DateTimeInput } from '../../src/panel/DateTimeInput';
import { TranslationProvider } from '../../src/i18n/react';
import type { DatedSchedule, RecurrenceRule, SeriesDefinition } from '../../src/shared/models';

const date = (value: string): DatedSchedule => ({ kind: 'allDay', date: value, zone: 'Asia/Shanghai' });
const weekly: RecurrenceRule = { calendar: 'gregorian', frequency: 'weekly', interval: 2, weekdays: [5], basis: 'scheduled', end: { kind: 'never' } };
const definition: SeriesDefinition = { seriesId: 'series', revisionId: 'rev', parentRevisionIds: [], rule: weekly, anchor: date('2026-10-26'), priority: 'none', pinned: false, modeForNext: 'continuous', reminder: { enabled: false }, sourceNotebookId: 'book', sourceTagIds: [] };

for (const mode of ['continuous', 'archive'] as const) for (const first of ['2026-10-26', '2026-10-30']) {
  test(`issue49 ${mode}: ${first} survives rule edits, appears once, and advances once after restart`, async () => {
    const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
    host.notebooks.set('book', { id: 'book', title: 'Book' });
    const options = { now: () => Date.parse('2026-10-30T04:00:00Z') };
    let app = new TaskApplication(host, options); await app.initialize();
    const made = await app.dispatch({ action: 'createTask', requestId: 'create', input: { title: 'First date', notebookId: 'book', schedule: date(first) } });
    assert.equal((await app.dispatch({ action: 'editTask', requestId: 'enable', noteId: made.noteId!, patch: { recurrence: { ...weekly, interval: 1 }, mode } })).status, 'saved');
    let series = (await app.snapshot()).series[0]!;
    // An explicit current date overrides rule rematching while forecasts use the revised rule.
    const edited = { ...series.definition!, rule: weekly };
    assert.equal((await app.dispatch({ action: 'reviseSeries', requestId: 'rule', seriesId: series.seriesId, revisionId: series.definition!.revisionId, definition: edited, currentSchedule: date(first) })).status, 'saved');
    app = new TaskApplication(host, options); await app.initialize();
    const month = await app.snapshot({ view: 'month', date: first, deviceZone: 'Asia/Shanghai' });
    series = month.series[0]!;
    assert.equal(series.occurrences.find(o => o.occurrenceId === series.activeOccurrenceId)!.deferred?.date, first);
    assert.equal(series.occurrences.find(o => o.occurrenceId === series.activeOccurrenceId)!.scheduled.date, '2026-10-30');
    assert.equal(month.items.filter(i => i.date === first).length, 1);
    assert.equal(month.items.filter(i => i.date === '2026-10-30').length, first === '2026-10-30' ? 1 : 0);
    assert.equal((await app.dispatch({ action: 'complete', requestId: 'done', seriesId: series.seriesId })).status, 'saved');
    series = (await app.snapshot()).series[0]!;
    assert.equal(series.consumedCount, 1);
    assert.equal(series.occurrences.find(o => o.occurrenceId === series.activeOccurrenceId)!.scheduled.date, '2026-11-13');
  });
}

for (const rule of [weekly, { ...weekly, frequency: 'monthly', weekdays: undefined, monthDay: 30 }, { ...weekly, frequency: 'yearly', weekdays: undefined, month: 10, monthDay: 30 }] as RecurrenceRule[]) {
  test(`issue49 explicit Monday is retained for ${rule.frequency}; stopping retains it without forecasts`, async () => {
    const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID; host.notebooks.set('book', { id: 'book', title: 'Book' });
    const app = new TaskApplication(host); await app.initialize();
    const made = await app.dispatch({ action: 'createTask', requestId: 'make', input: { title: 'Edit date', notebookId: 'book', schedule: date('2026-10-30'), recurrence: weekly } });
    let series = (await app.snapshot()).series[0]!;
    assert.equal((await app.dispatch({ action: 'reviseSeries', requestId: 'move', seriesId: series.seriesId, revisionId: series.definition!.revisionId, definition: { ...series.definition!, anchor: date('2026-10-26'), rule }, currentSchedule: date('2026-10-26') })).status, 'saved');
    const snap = await app.snapshot({ view: 'month', date: '2026-10-26', deviceZone: 'Asia/Shanghai' });
    assert.equal(snap.items.filter(i => i.date === '2026-10-26').length, 1);
    assert.equal(snap.items.find(i => i.kind === 'actual')!.date, '2026-10-26');
    assert.equal((await app.dispatch({ action: 'deleteTask', requestId: 'stop', noteId: made.noteId!, seriesId: series.seriesId, scope: 'stop' })).status, 'saved');
    const stopped = await app.snapshot({ view: 'month', date: '2026-10-26', deviceZone: 'Asia/Shanghai' });
    assert.equal(stopped.items.length, 1); assert.equal(stopped.items[0]!.date, '2026-10-26');
    assert.ok(host.notes.has(made.noteId!));
  });
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
test('issue49 editor separates current date from anchor, previews exact dates and exposes stop', async () => {
  let renderer!: ReactTestRenderer;
  let saved: DatedSchedule | undefined, savedDefinition: SeriesDefinition | undefined, stopped = 0;
  await act(async () => { renderer = create(React.createElement(TranslationProvider, { locale: 'en', children: React.createElement(SeriesEditor, {
    definition, currentSchedule: date('2026-10-30'), consumedCount: 0, busy: false, folders: [{ id: 'book', title: 'Book' }], onInsertTemplate() {}, onStop() { stopped++; }, onSave(d, s) { savedDefinition = d; saved = s; },
  }) })); });
  try {
    const dates = () => renderer.root.findAllByType(DateTimeInput).filter(n => n.props.type === 'date');
    await act(async () => dates()[1]!.props.onChange({ target: { value: '2026-10-12' } }));
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal(saved, undefined, 'changing only the anchor preserves the current period');
    await act(async () => dates()[0]!.props.onChange({ target: { value: '2026-10-26' } }));
    const text = JSON.stringify(renderer.toJSON());
    assert.ok(text.includes('2026-10-26 全天') || text.includes('2026-10-26 All day'));
    assert.ok(text.includes('2026-10-30'));
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal(saved!.date, '2026-10-26'); assert.equal(savedDefinition!.anchor.date, '2026-10-12');
    await act(async () => renderer.root.findAllByType('button').find(n => n.props.className === 'danger full')!.props.onClick());
    assert.equal(stopped, 1);
  } finally { await act(async () => renderer.unmount()); }
});

test('issue49 first recurrence setup previews Monday first and Friday next', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(TranslationProvider, { locale: 'en', children: React.createElement(TaskForm, {
    task: { taskId: 'task', noteId: 'note', title: 'Task', notebookId: 'book', tagIds: [], completedAt: 0, priority: 'none', pinned: false, reminder: { enabled: false }, schedule: date('2026-10-26') }, folders: [{ id: 'book', title: 'Book' }], initialDate: '2026-10-30', busy: false, onSubmit() {},
  }) })); });
  try {
    await act(async () => renderer.root.findAllByType('label').find(n => n.children.includes('Repeating task'))!.findByType('input').props.onChange({ target: { checked: true } }));
    await act(async () => renderer.root.findAllByType('select').find(n => n.props.value === 'daily')!.props.onChange({ target: { value: 'weekly' } }));
    await act(async () => renderer.root.findByProps({ className: 'weekday-picker' }).findAllByType('input')[4]!.props.onChange({ target: { checked: true } }));
    const text = JSON.stringify(renderer.toJSON());
    assert.ok(text.includes('Current execution date: ')); assert.ok(text.includes('2026-10-26')); assert.ok(text.includes('2026-10-30'));
  } finally { await act(async () => renderer.unmount()); }
});
