import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { CalendarDay, CalendarWeek, CalendarMonth, CalendarYear } from '../../src/panel/TaskViews';
import { TranslationProvider } from '../../src/i18n/react';
import type { PreviewItem } from '../../src/shared/models';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const date = '2026-11-04';
const items: PreviewItem[] = Array.from({ length: 14 }, (_, index) => ({
  id: `task-${index}`, title: `Task ${index}`, kind: 'actual', date,
  schedule: { kind: 'allDay', date, zone: 'Asia/Shanghai' },
  priority: 'none', pinned: false, completed: false, overdue: false,
}));
const renderList = (rows: PreviewItem[]) => React.createElement('div', null, rows.map(row => React.createElement('article', { key: row.id }, row.title)));
const noop = () => {};

test('issue80 month expands and collapses only the chosen date, resetting on month navigation', async () => {
  let renderer: ReactTestRenderer;
  const render = (month: string) => React.createElement(TranslationProvider, { locale: 'zh-CN', children: React.createElement(CalendarMonth, { date: month, selectedDate: date, items, onSelect: noop, renderList }) });
  await act(async () => { renderer = create(render(date)); });
  try {
    const rows = () => renderer!.root.findAllByType('article');
    const toggle = () => renderer!.root.findByProps({ className: 'overflow-count' });
    assert.equal(rows().length, 3);
    assert.deepEqual(toggle().children, ['共 14 条', ' / ', '展开全部']);
    await act(async () => toggle().props.onClick());
    assert.equal(rows().length, 14);
    assert.equal(toggle().props['aria-expanded'], true);
    await act(async () => toggle().props.onClick());
    assert.equal(rows().length, 3);
    await act(async () => toggle().props.onClick());
    await act(async () => renderer!.update(render('2026-12-01')));
    await act(async () => renderer!.update(render(date)));
    assert.equal(rows().length, 3);
  } finally { await act(async () => renderer!.unmount()); }
});

test('issue80 day/week retain every task and year retains its overview', () => {
  for (const count of [0, 1, 5, 6, 14, 100]) {
    const rows = Array.from({ length: count }, (_, i) => ({ ...items[0]!, id: `row-${i}` }));
    for (const element of [React.createElement(CalendarDay, { items: rows, renderList }), React.createElement(CalendarWeek, { date, items: rows, onSelect: noop, renderList })]) {
      const html = renderToStaticMarkup(element);
      assert.equal((html.match(/<article>/g) ?? []).length, count);
    }
  }
  const html = renderToStaticMarkup(React.createElement(CalendarYear, { date, selectedDate: date, items, onSelect: noop, renderList }));
  assert.doesNotMatch(html, /<article>|overflow-count/);
});

test('issue80 simultaneous and late tasks can grow beyond their civil-time slot', () => {
  for (const time of ['12:00', '23:59']) {
    const rows = items.map(item => ({ ...item, schedule: { kind: 'timed' as const, date, time, zone: 'Asia/Shanghai', instant: Date.parse(`${date}T${time}:00+08:00`) } }));
    const html = renderToStaticMarkup(React.createElement(CalendarDay, { items: rows, renderList }));
    assert.equal((html.match(/<article>/g) ?? []).length, 14);
    assert.match(html, /class="timeline-cluster dense" style="min-height:40px"/);
  }
  const css = readFileSync(new URL('../../src/panel/panel.css', import.meta.url), 'utf8');
  for (const selector of ['.all-day-tasks', '.timeline-cluster', '.timeline-cluster.dense', '.week-column']) {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1]!.trim() === selector);
    assert.ok(rules.length, selector);
    for (const rule of rules) assert.doesNotMatch(rule[2]!, /max-height:|overflow(?:-y)?:\s*(?:auto|scroll|hidden)/, selector);
  }
});
