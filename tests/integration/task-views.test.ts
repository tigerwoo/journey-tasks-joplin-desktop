import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskList, CalendarDay, CalendarWeek, CalendarMonth, CalendarYear, DateNavigation } from '../../src/panel/TaskViews';
import { TaskContextMenu } from '../../src/panel/TaskContextMenu';
import { TranslationProvider } from '../../src/i18n/react';
import type { Task, PreviewItem } from '../../src/shared/models';
import { readFileSync } from 'node:fs';
const noop = () => {};
const item: PreviewItem = { id: 'native', noteId: 'native', title: '用户 <script>alert(1)</script>', kind: 'actual', date: '2026-10-25',
  schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' }, priority: 'high', pinned: false, overdue: false, completed: false, notebookId: 'book', tagIds: ['tag'] };
const render = (element: React.ReactElement) => renderToStaticMarkup(React.createElement(TranslationProvider, { locale: 'en', children: element }));
const renderList = (items: PreviewItem[]) => React.createElement(TaskList, { items, busy: false, onSelect: noop, onComplete: noop, onMenu: noop });

test('task rows show native categories and a visible touch menu, escape user content, and hide legacy priority', () => {
  const html = render(React.createElement(TaskList, { items: [item], busy: false, onSelect: noop, onComplete: noop, onMenu: noop,
    folders: [{ id: 'book', title: '原生笔记本' }], tags: [{ id: 'tag', title: '原生标签' }] }));
  assert.match(html, /原生笔记本/); assert.match(html, /原生标签/); assert.match(html, /class="more"/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script|High priority|高优先级|priority-high/);
  const forecast = render(React.createElement(TaskList, { items: [{ ...item, kind: 'projected', noteId: undefined }], busy: false, onSelect: noop, onComplete: noop, onMenu: noop }));
  assert.doesNotMatch(forecast, /class="more"|type="checkbox"/);
});

test('task menu has exactly the requested action families and no destructive action runs during rendering', () => {
  const task: Task = { taskId: 'native', noteId: 'native', title: item.title, notebookId: 'book', tagIds: [], schedule: item.schedule, completedAt: 0,
    priority: 'none', pinned: false, reminder: { enabled: false } };
  let commands = 0;
  const html = render(React.createElement(TaskContextMenu, { task, x: 0, y: 0, busy: false, folders: [{ id: 'book', title: 'book' }], onCommand: async () => { commands++; return undefined; }, onClose: noop }));
  for (const label of ['Date', 'Open original note', 'Pin', 'Abandon', 'Move to', 'Delete']) assert.ok(html.includes(label), label);
  assert.equal((html.match(/role="menuitem"/g) || []).length, 5, 'date controls are a separate action family');
  assert.doesNotMatch(html, /Priority|Duplicate|Merge|Permanent/); assert.equal(commands, 0);
});

test('day timeline separates all-day and sorts timed tasks; week starts with Sunday and has seven dates', () => {
  const timed = (id: string, hour: number): PreviewItem => ({ ...item, id, title: id, schedule: { kind: 'timed', date: item.date, time: `${hour}:00`, zone: 'Asia/Shanghai', instant: Date.parse(`2026-10-25T${hour}:00:00Z`) } });
  const day = render(React.createElement(CalendarDay, { items: [timed('late', 12), item, timed('early', 10)], renderList }));
  assert.ok(day.indexOf('all-day') < day.indexOf('early')); assert.ok(day.indexOf('early') < day.indexOf('late'));
  const week = render(React.createElement(CalendarWeek, { date: '2026-10-28', items: [item], onSelect: noop, renderList }));
  assert.equal((week.match(/class="week-column/g) || []).length, 7); assert.match(week, />Sun</); assert.ok(week.indexOf('>Sun<') < week.indexOf('>Mon<'));
});

test('month exposes clickable week numbers and dates, year exposes month buttons and twelve calendars', () => {
  const props = { date: '2026-10-01', items: [item], selectedDate: item.date, onSelect: noop, onWeek: noop, renderList };
  const month = render(React.createElement(CalendarMonth, props));
  assert.match(month, /class="week-number"/); assert.doesNotMatch(month, /class="week-number"[^>]*disabled/);
  assert.match(month, /aria-label="2026-10-25, 1 tasks"/);
  const year = render(React.createElement(CalendarYear, { ...props, onMonth: noop }));
  assert.equal((year.match(/class="month-title"/g) || []).length, 12); assert.equal((year.match(/class="calendar compact"/g) || []).length, 12);
});

test('all list filters have no calendar arrows while day/week/month/year have semantic navigation', () => {
  for (const view of ['today', 'tomorrow', 'sevenDays', 'inbox', 'all'] as const) assert.doesNotMatch(render(React.createElement(DateNavigation, { view, label: 'range', onNavigate: noop, onToday: noop })), /<button/);
  for (const view of ['day', 'week', 'month', 'year'] as const) {
    const html = render(React.createElement(DateNavigation, { view, label: 'range', onNavigate: noop, onToday: noop }));
    assert.match(html, new RegExp(`aria-label="Previous ${view}"`)); assert.match(html, new RegExp(`aria-label="Next ${view}"`));
  }
});

test('static wiring preserves right-click, touch menus and calendar drilldown without completion bubbling', () => {
  const views = readFileSync(new URL('../../src/panel/TaskViews.tsx', import.meta.url), 'utf8');
  assert.match(views, /onContextMenu=/); assert.match(views, /e\.stopPropagation\(\); onComplete\(item\)/);
  assert.match(views, /e\.stopPropagation\(\); onMenu\(item, e\)/);
  assert.match(views, /onClick=\{\(\) => onSelect\(d\)\}/); assert.match(views, /onMonth\?\.\(date\)/);
});

test('App static wiring connects month and year date drilldown, week numbers, and native task menus', () => {
  const app = readFileSync(new URL('../../src/panel/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /onSelect=\{d => chooseView\('day', d, true\)\}/);
  assert.match(app, /onWeek=\{d => chooseView\('week', d, true\)\}/);
  assert.match(app, /onMonth=\{d => chooseView\('month', d, true\)\}/);
  assert.match(app, /view === 'week' \? addDays\(date, n \* 7\)/);
  assert.match(app, /<TaskContextMenu[^>]*onCommand=\{runMenuCommands\}/);
});

test('new and edit task forms expose pin only through task menus and contain no priority field', async () => {
  const { TaskForm } = await import('../../src/panel/App');
  const html = render(React.createElement(TaskForm, { folders: [{ id: 'book', title: 'book' }], initialDate: '2026-10-25', busy: false, onSubmit: noop }));
  assert.doesNotMatch(html, /High priority|Priority|priority|置顶|Pinned/);
  assert.match(html, /name="title"|<input/);
  const task: Task = { taskId: 'native', noteId: 'native', title: 'legacy', notebookId: 'book', tagIds: [], schedule: item.schedule, completedAt: 0, priority: 'high', pinned: true, reminder: { enabled: false } };
  const edit = render(React.createElement(TaskForm, { folders: [{ id: 'book', title: 'book' }], task, initialDate: '2026-10-25', busy: false, onSubmit: noop }));
  assert.doesNotMatch(edit, /High priority|Priority|priority|置顶|Pinned/);
});

test('reminder bells distinguish upcoming, elapsed and completed reminders in full and compact rows', () => {
  for (const compact of [false, true]) {
    const html = render(React.createElement(TaskList, { items: [
      { ...item, id: 'future', reminderAt: Date.now() + 60_000 },
      { ...item, id: 'past', reminderAt: Date.now() - 60_000 },
      { ...item, id: 'done', completed: true, reminderAt: Date.now() + 60_000 },
      { ...item, id: 'off', reminderAt: 0 },
    ], compact, busy: false, onSelect: noop, onComplete: noop }));
    assert.equal((html.match(/class="reminder-mark active"/g) || []).length, 1);
    assert.equal((html.match(/class="reminder-mark expired"/g) || []).length, 2);
    assert.match(html, /aria-label="Reminder active"/);
    assert.match(html, /aria-label="Reminder expired"/);
  }
});


test('month view limits busy days to three tasks with a total and expand control', () => {
  const items = Array.from({ length: 12 }, (_, index) => ({ ...item, id: `month-${index}`, noteId: `month-${index}`, title: `Month task ${index + 1}` }));
  const html = render(React.createElement(CalendarMonth, { date: item.date, selectedDate: item.date, items, onSelect: noop, renderList }));
  assert.equal((html.match(/class="task-row/g) || []).length, 3);
  assert.doesNotMatch(html, /Month task 12/);
  assert.match(html, /12 tasks \/ Show all/);
  assert.match(html, /aria-expanded="false"/);
});

test('task list and day timeline honor the saved clock format independently of language', () => {
  const date = new Date(2026, 9, 25, 13, 5);
  const timed: PreviewItem = { ...item, schedule: { kind: 'timed', date: item.date, time: '13:05', zone: Intl.DateTimeFormat().resolvedOptions().timeZone, instant: date.getTime() } };
  for (const locale of ['en', 'zh-CN'] as const) {
    for (const timeFormat of ['24h', '12h'] as const) {
      const expected = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: timeFormat === '12h' ? 'h12' : 'h23' }).format(date);
      const list = renderToStaticMarkup(React.createElement(TranslationProvider, { locale, timeFormat, children: renderList([timed]) }));
      const day = renderToStaticMarkup(React.createElement(TranslationProvider, { locale, timeFormat, children: React.createElement(CalendarDay, { items: [timed], renderList }) }));
      assert.ok(list.includes(expected), list);
      assert.ok(day.includes(`class="timeline-time">${expected}</time>`), day);
      const midnight = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: timeFormat === '12h' ? 'h12' : 'h23' }).format(new Date(2000, 0, 1));
      assert.ok(day.includes(`<time>${midnight}–`), 'free time uses the same clock format');
    }
  }
});
